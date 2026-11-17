import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  COMANDOS,
  MensagemInvalidaError,
  SERVICO_BILLING,
  type Mensagem,
  type MensagemSaida,
  type TipoEvento,
} from '../../domain/mensageria/mensagem';
import type { IRastreamento } from '../../domain/services/rastreamento.interface';

const envelopeSchema = z.object({
  id: z.string().min(1),
  tipo: z.string().min(1),
  versao: z.literal(1),
  sagaId: z.string().min(1),
  ordemId: z.string().uuid(),
  causadaPor: z.string().nullable(),
  origem: z.string().min(1),
  ocorridaEm: z.string().datetime(),
  dados: z.record(z.unknown()),
});

const numeroOS = z.number().int().positive();

const dadosPorComando = {
  [COMANDOS.GERAR_ORCAMENTO]: z.object({
    numeroOS,
    cliente: z.object({ id: z.string().min(1), nome: z.string(), email: z.string().nullable() }),
    itens: z.array(
      z.object({
        tipo: z.enum(['SERVICO', 'PECA']),
        referenciaId: z.string().min(1),
        nome: z.string().min(1),
        quantidade: z.number().int().positive(),
        precoUnitario: z.number().nonnegative(),
      }),
    ),
  }),
  [COMANDOS.CANCELAR]: z.object({
    numeroOS,
    orcamentoId: z.string().nullish(),
    motivo: z.string().min(1),
  }),
} as const;

type Dados<K extends keyof typeof dadosPorComando> = z.infer<(typeof dadosPorComando)[K]>;

export type Comando =
  | ({ tipo: typeof COMANDOS.GERAR_ORCAMENTO } & Dados<typeof COMANDOS.GERAR_ORCAMENTO>)
  | ({ tipo: typeof COMANDOS.CANCELAR } & Dados<typeof COMANDOS.CANCELAR>);

export function lerEnvelope(bruto: unknown): Mensagem {
  const resultado = envelopeSchema.safeParse(bruto);
  if (!resultado.success)
    throw new MensagemInvalidaError(`Envelope inválido: ${resultado.error.issues[0]?.message}`);
  return resultado.data as Mensagem;
}

export function interpretarComando(mensagem: Mensagem): Comando {
  const schema = dadosPorComando[mensagem.tipo as keyof typeof dadosPorComando];
  if (!schema) throw new MensagemInvalidaError(`Comando desconhecido: ${mensagem.tipo}`);
  const dados = schema.safeParse(mensagem.dados);
  if (!dados.success)
    throw new MensagemInvalidaError(
      `Dados inválidos em ${mensagem.tipo}: ${dados.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  return { tipo: mensagem.tipo, ...dados.data } as Comando;
}

export function novoEvento(
  tipo: TipoEvento,
  alvo: { sagaId: string; ordemId: string; numeroOS: number },
  dados: Record<string, unknown>,
  causadaPor: string | null,
  rastreamento: IRastreamento,
): MensagemSaida {
  return {
    mensagem: {
      id: randomUUID(),
      tipo,
      versao: 1,
      sagaId: alvo.sagaId,
      ordemId: alvo.ordemId,
      causadaPor,
      origem: SERVICO_BILLING,
      ocorridaEm: new Date().toISOString(),
      dados: { numeroOS: alvo.numeroOS, ...dados },
    },
    cabecalhos: rastreamento.cabecalhosDePropagacao(),
  };
}
