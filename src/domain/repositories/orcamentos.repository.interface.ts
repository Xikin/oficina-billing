import type { MensagemSaida } from '../mensageria/mensagem';
import type { Orcamento, Pagamento, StatusOrcamento } from '../orcamento/orcamento';

export interface ListarOrcamentosParams {
  page: number;
  limit: number;
  status?: StatusOrcamento;
}

export interface MudancaDeOrcamento {
  id: string;
  statusEsperado: StatusOrcamento;
  versaoEsperada: number;
  novoStatus: StatusOrcamento;
  observacao: string;
  pagamento?: Pagamento;
  motivo?: string;
  saidas: MensagemSaida[];
}

export class OrcamentoAlteradoError extends Error {
  constructor(id: string) {
    super(`O orçamento ${id} foi alterado por outro processo; tente de novo`);
    this.name = 'OrcamentoAlteradoError';
  }
}

export interface IOrcamentoRepository {
  criar(orcamento: Orcamento, saidas: MensagemSaida[]): Promise<'criado' | 'ja_existe'>;
  buscarPorId(id: string): Promise<Orcamento | null>;
  buscarPorOrdem(ordemId: string): Promise<Orcamento | null>;
  listar(params: ListarOrcamentosParams): Promise<{ data: Orcamento[]; total: number }>;
  mudar(mudanca: MudancaDeOrcamento): Promise<Orcamento>;
  enfileirar(id: string, saidas: MensagemSaida[]): Promise<void>;
}
