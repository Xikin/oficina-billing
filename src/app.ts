import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { env } from './config/env';
import { AppError } from './shared/errors';
import { EMISSOR_INTERNO } from './domain/auth/emissores';
import { TransicaoInvalidaError } from './domain/orcamento/orcamento';
import {
  OrcamentoAlteradoError,
  type IOrcamentoRepository,
} from './domain/repositories/orcamentos.repository.interface';
import {
  GatewayIndisponivelError,
  type IGatewayPagamento,
} from './domain/services/gateway-pagamento.interface';
import {
  rastreamentoDesligado,
  type IRastreamento,
} from './domain/services/rastreamento.interface';
import { orcamentosRoutes } from './presentation/http/routes/orcamentos.routes';
import { pagamentosRoutes } from './presentation/http/routes/pagamentos.routes';

export interface Dependencias {
  repo: IOrcamentoRepository;
  gateway: IGatewayPagamento;
  bancoAcessivel: () => Promise<boolean>;
  rastreamento?: IRastreamento;
  mensageria?: { readonly conectado: boolean } | null;
  segredoWebhook?: string;
}

function responder(
  req: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
) {
  req.log.warn(
    {
      evento: 'erro_negocio',
      codigo: code,
      statusCode,
      rota: req.routeOptions?.url,
      mensagem: message,
    },
    'requisição rejeitada',
  );
  return reply.status(statusCode).send({ statusCode, code, message });
}

export async function buildApp(deps: Dependencias): Promise<FastifyInstance> {
  const rastreamento = deps.rastreamento ?? rastreamentoDesligado;
  const mensageria = deps.mensageria ?? null;

  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: env.LOG_LEVEL,
            base: {
              service: 'oficina-billing',
              env: env.NODE_ENV,
              version: process.env.APP_VERSION ?? 'dev',
            },
            redact: { paths: ['req.headers.authorization'], censor: '[REDACTED]' },
          },
    genReqId(req) {
      const header = req.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0 && header.length <= 200) return header;
      return randomUUID();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    return payload;
  });

  const origens = env.ALLOWED_ORIGINS.split(',').filter(Boolean);
  await app.register(fastifyCors, {
    origin: origens.length > 0 ? origens : env.NODE_ENV !== 'production',
    exposedHeaders: ['x-request-id'],
  });
  await app.register(fastifyJwt, { secret: env.JWT_SECRET, sign: { iss: EMISSOR_INTERNO } });
  await app.register(fastifyJwt, { secret: env.JWT_CLIENTE_SECRET, namespace: 'cliente' });

  if (env.SWAGGER_ENABLED) {
    await app.register(fastifySwagger, {
      transform: jsonSchemaTransform,
      openapi: {
        info: {
          title: 'Oficina Mecânica — Orçamento e Pagamento',
          version: '1.0.0',
          description: `Orçamentos, aprovação pelo cliente e cobrança pelo Mercado Pago (modo ${deps.gateway.simulado ? 'simulado' : 'real'}). Participa da saga de atendimento pelo RabbitMQ.`,
        },
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
        tags: [{ name: 'Orçamentos' }, { name: 'Pagamentos' }, { name: 'Saúde' }],
      },
    });
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  app.setErrorHandler((error, req, reply) => {
    if (error.validation)
      return reply.status(422).send({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        errors: error.validation,
      });
    if (error instanceof ZodError)
      return reply.status(422).send({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        errors: error.flatten().fieldErrors,
      });
    if (error instanceof AppError)
      return responder(req, reply, error.statusCode, error.code, error.message);
    if (error instanceof TransicaoInvalidaError)
      return responder(req, reply, 400, 'BUSINESS_ERROR', error.message);
    if (error instanceof OrcamentoAlteradoError)
      return responder(req, reply, 409, 'CONFLICT', error.message);
    if (error instanceof GatewayIndisponivelError) {
      req.log.error(
        { evento: 'falha_integracao', integracao: 'mercado_pago', erro: error.message },
        'Mercado Pago indisponível',
      );
      return reply.status(502).send({
        statusCode: 502,
        code: 'GATEWAY_INDISPONIVEL',
        message: 'Não foi possível falar com o Mercado Pago; tente de novo em instantes',
      });
    }

    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
      return responder(req, reply, error.statusCode, error.code ?? 'BAD_REQUEST', error.message);

    req.log.error(
      { evento: 'erro_interno', rota: req.routeOptions?.url, err: error },
      'erro não tratado ao processar requisição',
    );
    return reply
      .status(500)
      .send({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' });
  });

  app.get('/health', { schema: { tags: ['Saúde'], summary: 'Liveness' } }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  app.get(
    '/health/ready',
    { schema: { tags: ['Saúde'], summary: 'Readiness — MongoDB acessível' } },
    async (_req, rep) => {
      const inicio = Date.now();
      const banco = await deps.bancoAcessivel();
      const corpo = {
        status: banco ? 'ok' : 'degradado',
        dependencias: {
          mongodb: banco ? 'ok' : 'indisponivel',
          mensageria: mensageria ? (mensageria.conectado ? 'ok' : 'reconectando') : 'desligada',
          mercadoPago: deps.gateway.simulado ? 'simulado' : 'real',
        },
        latenciaMs: Date.now() - inicio,
      };
      return rep.status(banco ? 200 : 503).send(corpo);
    },
  );

  app.register(orcamentosRoutes, {
    prefix: '/orcamentos',
    repo: deps.repo,
    gateway: deps.gateway,
    rastreamento,
  });
  app.register(pagamentosRoutes, {
    prefix: '/pagamentos',
    repo: deps.repo,
    gateway: deps.gateway,
    rastreamento,
    segredoWebhook: deps.segredoWebhook,
  });

  return app;
}
