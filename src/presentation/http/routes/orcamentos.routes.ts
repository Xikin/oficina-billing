import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  BuscarOrcamentoUseCase,
  DecidirOrcamentoUseCase,
  ListarOrcamentosUseCase,
  type Ator,
} from '../../../application/use-cases/orcamentos.use-cases';
import type { IOrcamentoRepository } from '../../../domain/repositories/orcamentos.repository.interface';
import type { IGatewayPagamento } from '../../../domain/services/gateway-pagamento.interface';
import type { IRastreamento } from '../../../domain/services/rastreamento.interface';
import { exigirDonoDoRecurso, exigirInterno } from '../middlewares/auth.middleware';
import {
  erroResponseSchema,
  listarOrcamentosResponseSchema,
  listarOrcamentosSchema,
  orcamentoResponseSchema,
  ordemParamsSchema,
  paramsIdSchema,
  reprovarSchema,
} from '../schemas/billing.schema';

export interface OpcoesOrcamentos {
  repo: IOrcamentoRepository;
  gateway: IGatewayPagamento;
  rastreamento: IRastreamento;
}

const ator = (req: FastifyRequest) => req.user as unknown as Ator;

export const orcamentosRoutes: FastifyPluginAsync<OpcoesOrcamentos> = async (instance, opcoes) => {
  const fastify = instance.withTypeProvider<ZodTypeProvider>();
  const { repo, gateway, rastreamento } = opcoes;
  const tags = ['Orçamentos'];
  const security = [{ bearerAuth: [] }];
  const respostas = {
    200: orcamentoResponseSchema,
    400: erroResponseSchema,
    403: erroResponseSchema,
    404: erroResponseSchema,
    409: erroResponseSchema,
    502: erroResponseSchema,
  };

  const listar = new ListarOrcamentosUseCase(repo);
  const buscar = new BuscarOrcamentoUseCase(repo);
  const decidir = (req: FastifyRequest) =>
    new DecidirOrcamentoUseCase(repo, gateway, rastreamento, req.log);

  const donoPorId = exigirDonoDoRecurso(async (req) => {
    const orcamento = await repo.buscarPorId((req.params as { id: string }).id);
    return orcamento ? orcamento.cliente.id : null;
  });
  const donoPorOrdem = exigirDonoDoRecurso(async (req) => {
    const orcamento = await repo.buscarPorOrdem((req.params as { ordemId: string }).ordemId);
    return orcamento ? orcamento.cliente.id : null;
  });

  fastify.get(
    '/',
    {
      onRequest: [exigirInterno],
      schema: {
        tags,
        security,
        summary: 'Listar orçamentos',
        querystring: listarOrcamentosSchema,
        response: { 200: listarOrcamentosResponseSchema },
      },
    },
    async (req, rep) => rep.send(await listar.execute(req.query)),
  );

  fastify.get(
    '/:id',
    {
      onRequest: [donoPorId],
      schema: {
        tags,
        security,
        summary: 'Buscar orçamento',
        description: 'O cliente só enxerga os próprios orçamentos.',
        params: paramsIdSchema,
        response: respostas,
      },
    },
    async (req, rep) => rep.send(await buscar.porId(req.params.id)),
  );

  fastify.get(
    '/ordem/:ordemId',
    {
      onRequest: [donoPorOrdem],
      schema: {
        tags,
        security,
        summary: 'Buscar orçamento pela OS',
        params: ordemParamsSchema,
        response: respostas,
      },
    },
    async (req, rep) => rep.send(await buscar.porOrdem(req.params.ordemId)),
  );

  fastify.post(
    '/:id/aprovar',
    {
      onRequest: [donoPorId],
      schema: {
        tags,
        security,
        summary: 'Aprovar orçamento',
        description:
          'Cria a cobrança no Mercado Pago e devolve o link de pagamento. Pode ser feito pelo cliente (token da Lambda) ou pela oficina.',
        params: paramsIdSchema,
        response: respostas,
      },
    },
    async (req, rep) => rep.send(await decidir(req).aprovar(req.params.id, ator(req))),
  );

  fastify.post(
    '/:id/reprovar',
    {
      onRequest: [donoPorId],
      schema: {
        tags,
        security,
        summary: 'Reprovar orçamento',
        description: 'Encerra o orçamento e dispara a compensação da saga: a OS é cancelada.',
        params: paramsIdSchema,
        body: reprovarSchema,
        response: respostas,
      },
    },
    async (req, rep) =>
      rep.send(await decidir(req).reprovar(req.params.id, req.body?.motivo, ator(req))),
  );
};
