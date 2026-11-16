import type { Orcamento } from '../orcamento/orcamento';

export interface Cobranca {
  preferenciaId: string;
  linkPagamento: string;
}

export interface PagamentoNoGateway {
  id: string;
  status: string;
  detalhe: string | null;
  referenciaExterna: string | null;
  valor: number;
  metodo: string | null;
}

export interface IGatewayPagamento {
  readonly simulado: boolean;
  criarCobranca(orcamento: Orcamento): Promise<Cobranca>;
  consultarPagamento(pagamentoId: string): Promise<PagamentoNoGateway>;
  estornar(pagamentoId: string, chaveIdempotencia: string): Promise<void>;
}

export class GatewayIndisponivelError extends Error {
  constructor(operacao: string, detalhe: string) {
    super(`Mercado Pago indisponível ao ${operacao}: ${detalhe}`);
    this.name = 'GatewayIndisponivelError';
  }
}
