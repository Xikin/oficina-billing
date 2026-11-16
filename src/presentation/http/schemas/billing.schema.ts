import { z } from 'zod';
import { STATUS_ORCAMENTO, type StatusOrcamento } from '../../../domain/orcamento/orcamento';

export const paramsIdSchema = z.object({ id: z.string().uuid() });
export const ordemParamsSchema = z.object({ ordemId: z.string().uuid() });
export const orcamentoParamsSchema = z.object({ orcamentoId: z.string().uuid() });

export const erroResponseSchema = z.object({
  statusCode: z.number().int(),
  code: z.string(),
  message: z.string(),
});

export const listarOrcamentosSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(STATUS_ORCAMENTO as [StatusOrcamento, ...StatusOrcamento[]]).optional(),
});

export const reprovarSchema = z.object({ motivo: z.string().min(3).max(500).optional() });

export const orcamentoResponseSchema = z.object({
  id: z.string().uuid(),
  ordemId: z.string().uuid(),
  sagaId: z.string(),
  numeroOS: z.number().int(),
  cliente: z.object({ id: z.string(), nome: z.string(), email: z.string().nullable() }),
  itens: z.array(
    z.object({
      tipo: z.enum(['SERVICO', 'PECA']),
      referenciaId: z.string(),
      nome: z.string(),
      quantidade: z.number().int(),
      precoUnitario: z.number(),
    }),
  ),
  valorTotal: z.number(),
  status: z.string(),
  pagamento: z
    .object({
      status: z.string(),
      preferenciaId: z.string().nullable(),
      linkPagamento: z.string().nullable(),
      pagamentoId: z.string().nullable(),
      valor: z.number().nullable(),
      metodo: z.string().nullable(),
      detalhe: z.string().nullable(),
      atualizadoEm: z.date(),
    })
    .nullable(),
  motivo: z.string().nullable(),
  historico: z.array(z.object({ status: z.string(), observacao: z.string(), em: z.date() })),
  versao: z.number().int(),
  criadoEm: z.date(),
  atualizadoEm: z.date(),
});

export const listarOrcamentosResponseSchema = z.object({
  data: z.array(orcamentoResponseSchema),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export const webhookQuerySchema = z
  .object({
    'data.id': z.string().optional(),
    type: z.string().optional(),
    topic: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

export const webhookBodySchema = z
  .object({
    type: z.string().optional(),
    action: z.string().optional(),
    data: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
  })
  .passthrough()
  .optional();

export const resultadoPagamentoSchema = z.object({
  resultado: z.enum(['confirmado', 'recusado', 'estornado_tardio', 'ignorado']),
});

export const simularPagamentoSchema = z.object({
  aprovado: z.boolean(),
  valor: z.number().positive().optional(),
});
