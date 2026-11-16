import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { NotFoundError, UnauthorizedError } from '../../../shared/errors';
import {
  ProcessarNotificacaoUseCase,
  RegistrarPagamentoUseCase,
  SimularPagamentoUseCase,
} from '../../../application/use-cases/pagamentos.use-cases';
import { assinaturaValida } from '../../../infrastructure/pagamentos/assinatura-webhook';
import type { IOrcamentoRepository } from '../../../domain/repositories/orcamentos.repository.interface';
import type { IGatewayPagamento } from '../../../domain/services/gateway-pagamento.interface';
import type { IRastreamento } from '../../../domain/services/rastreamento.interface';
import type { ILogger } from '../../../domain/services/logger.service.interface';
import {
  erroResponseSchema,
  orcamentoParamsSchema,
  resultadoPagamentoSchema,
  simularPagamentoSchema,
  webhookBodySchema,
  webhookQuerySchema,
} from '../schemas/billing.schema';

export interface OpcoesPagamentos {
  repo: IOrcamentoRepository;
  gateway: IGatewayPagamento;
  rastreamento: IRastreamento;
  segredoWebhook: string | undefined;
}

export const pagamentosRoutes: FastifyPluginAsync<OpcoesPagamentos> = async (instance, opcoes) => {
  const fastify = instance.withTypeProvider<ZodTypeProvider>();
  const { repo, gateway, rastreamento, segredoWebhook } = opcoes;
  const tags = ['Pagamentos'];

  const registrar = (log: ILogger) =>
    new RegistrarPagamentoUseCase(repo, gateway, rastreamento, log);

  fastify.post(
    '/webhook',
    {
      schema: {
        tags,
        summary: 'Notificação do Mercado Pago',
        description:
          'Valida a assinatura x-signature (quando MERCADO_PAGO_WEBHOOK_SECRET está configurado), consulta o pagamento na API do Mercado Pago e só então atualiza o orçamento. O corpo da notificação nunca é usado como fonte do status.',
        querystring: webhookQuerySchema,
        body: webhookBodySchema,
        response: {
          200: resultadoPagamentoSchema,
          401: erroResponseSchema,
          502: erroResponseSchema,
        },
      },
    },
    async (req, rep) => {
      const tipo = req.query.type ?? req.query.topic ?? req.body?.type;
      const dataId = req.query['data.id'] ?? req.body?.data?.id?.toString() ?? req.query.id;

      if (tipo !== 'payment' || !dataId) {
        req.log.info(
          { evento: 'webhook_ignorado', tipo, acao: req.body?.action },
          'notificação que não é de pagamento',
        );
        return rep.send({ resultado: 'ignorado' as const });
      }

      if (
        segredoWebhook &&
        !assinaturaValida({
          cabecalhoAssinatura: req.headers['x-signature'] as string | undefined,
          requestId: req.headers['x-request-id'] as string | undefined,
          dataId,
          segredo: segredoWebhook,
        })
      ) {
        req.log.warn(
          { evento: 'webhook_assinatura_invalida', pagamentoId: dataId },
          'notificação rejeitada: assinatura ausente ou inválida',
        );
        throw new UnauthorizedError('Assinatura do webhook inválida');
      }

      const resultado = await new ProcessarNotificacaoUseCase(gateway, registrar(req.log)).execute(
        dataId,
      );
      return rep.send({ resultado });
    },
  );

  fastify.post(
    '/simulador/:orcamentoId',
    {
      schema: {
        tags,
        summary: 'Simular o pagamento de um orçamento (só no modo simulado)',
        description:
          'Faz o papel do Mercado Pago em desenvolvimento e na demonstração: aprova ou recusa o pagamento do orçamento como se o webhook tivesse chegado. Informe valor para simular pagamento divergente.',
        params: orcamentoParamsSchema,
        body: simularPagamentoSchema,
        response: { 200: resultadoPagamentoSchema, 404: erroResponseSchema },
      },
    },
    async (req, rep) => {
      if (!gateway.simulado) throw new NotFoundError('Simulador de pagamento');
      const resultado = await new SimularPagamentoUseCase(repo, registrar(req.log)).execute(
        req.params.orcamentoId,
        req.body.aprovado,
        req.body.valor,
      );
      return rep.send({ resultado });
    },
  );
};
