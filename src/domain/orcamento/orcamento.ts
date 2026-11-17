export type StatusOrcamento =
  | 'AGUARDANDO_APROVACAO'
  | 'APROVADO'
  | 'REPROVADO'
  | 'PAGO'
  | 'PAGAMENTO_RECUSADO'
  | 'CANCELADO'
  | 'ESTORNADO';

export const STATUS_ORCAMENTO: readonly StatusOrcamento[] = [
  'AGUARDANDO_APROVACAO',
  'APROVADO',
  'REPROVADO',
  'PAGO',
  'PAGAMENTO_RECUSADO',
  'CANCELADO',
  'ESTORNADO',
];

export interface ItemOrcado {
  tipo: 'SERVICO' | 'PECA';
  referenciaId: string;
  nome: string;
  quantidade: number;
  precoUnitario: number;
}

export interface Pagamento {
  status: 'PENDENTE' | 'APROVADO' | 'RECUSADO' | 'ESTORNADO';
  preferenciaId: string | null;
  linkPagamento: string | null;
  pagamentoId: string | null;
  valor: number | null;
  metodo: string | null;
  detalhe: string | null;
  atualizadoEm: Date;
}

export interface RegistroHistorico {
  status: StatusOrcamento;
  observacao: string;
  em: Date;
}

export interface Orcamento {
  id: string;
  ordemId: string;
  sagaId: string;
  numeroOS: number;
  cliente: { id: string; nome: string; email: string | null };
  itens: ItemOrcado[];
  valorTotal: number;
  status: StatusOrcamento;
  pagamento: Pagamento | null;
  motivo: string | null;
  historico: RegistroHistorico[];
  versao: number;
  criadoEm: Date;
  atualizadoEm: Date;
}

export type AcaoOrcamento =
  'aprovar' | 'reprovar' | 'confirmarPagamento' | 'recusarPagamento' | 'cancelar' | 'estornar';

const TRANSICOES: Record<AcaoOrcamento, { de: readonly StatusOrcamento[]; para: StatusOrcamento }> =
  {
    aprovar: { de: ['AGUARDANDO_APROVACAO'], para: 'APROVADO' },
    reprovar: { de: ['AGUARDANDO_APROVACAO'], para: 'REPROVADO' },
    confirmarPagamento: { de: ['APROVADO'], para: 'PAGO' },
    recusarPagamento: { de: ['APROVADO'], para: 'PAGAMENTO_RECUSADO' },
    cancelar: { de: ['AGUARDANDO_APROVACAO', 'APROVADO', 'PAGAMENTO_RECUSADO'], para: 'CANCELADO' },
    estornar: { de: ['PAGO', 'CANCELADO'], para: 'ESTORNADO' },
  };

export const STATUS_LABEL: Record<StatusOrcamento, string> = {
  AGUARDANDO_APROVACAO: 'Aguardando aprovação',
  APROVADO: 'Aprovado, aguardando pagamento',
  REPROVADO: 'Reprovado',
  PAGO: 'Pago',
  PAGAMENTO_RECUSADO: 'Pagamento recusado',
  CANCELADO: 'Cancelado',
  ESTORNADO: 'Estornado',
};

export class TransicaoInvalidaError extends Error {
  constructor(acao: AcaoOrcamento, atual: StatusOrcamento) {
    super(`Ação "${acao}" não permitida para orçamento "${STATUS_LABEL[atual]}"`);
    this.name = 'TransicaoInvalidaError';
  }
}

export function proximoStatus(acao: AcaoOrcamento, atual: StatusOrcamento): StatusOrcamento {
  const regra = TRANSICOES[acao];
  if (!regra.de.includes(atual)) throw new TransicaoInvalidaError(acao, atual);
  return regra.para;
}

export function permite(acao: AcaoOrcamento, atual: StatusOrcamento): boolean {
  return TRANSICOES[acao].de.includes(atual);
}

export function calcularTotal(itens: ItemOrcado[]): number {
  const centavos = itens.reduce(
    (total, i) => total + Math.round(i.precoUnitario * 100) * i.quantidade,
    0,
  );
  return centavos / 100;
}

export type DesfechoDoPagamento = 'aprovado' | 'recusado' | 'estornado' | 'pendente';

export function desfechoDoMercadoPago(status: string): DesfechoDoPagamento {
  switch (status) {
    case 'approved':
      return 'aprovado';
    case 'rejected':
    case 'cancelled':
      return 'recusado';
    case 'refunded':
    case 'charged_back':
      return 'estornado';
    default:
      return 'pendente';
  }
}

export function valorConfere(pago: number, esperado: number): boolean {
  return Math.round(pago * 100) >= Math.round(esperado * 100);
}
