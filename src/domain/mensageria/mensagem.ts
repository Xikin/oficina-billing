export const SERVICO_BILLING = 'oficina-billing';

export const COMANDOS = {
  GERAR_ORCAMENTO: 'billing.comando.gerar-orcamento',
  CANCELAR: 'billing.comando.cancelar',
} as const;

export const EVENTOS = {
  ORCAMENTO_GERADO: 'billing.evento.orcamento-gerado',
  ORCAMENTO_FALHOU: 'billing.evento.orcamento-falhou',
  ORCAMENTO_APROVADO: 'billing.evento.orcamento-aprovado',
  ORCAMENTO_REPROVADO: 'billing.evento.orcamento-reprovado',
  PAGAMENTO_CONFIRMADO: 'billing.evento.pagamento-confirmado',
  PAGAMENTO_RECUSADO: 'billing.evento.pagamento-recusado',
  CANCELADO: 'billing.evento.cancelado',
} as const;

export type TipoEvento = (typeof EVENTOS)[keyof typeof EVENTOS];

export interface Mensagem<T = Record<string, unknown>> {
  id: string;
  tipo: string;
  versao: 1;
  sagaId: string;
  ordemId: string;
  causadaPor: string | null;
  origem: string;
  ocorridaEm: string;
  dados: T;
}

export interface MensagemSaida {
  mensagem: Mensagem;
  cabecalhos: Record<string, string>;
}

export class MensagemInvalidaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'MensagemInvalidaError';
  }
}
