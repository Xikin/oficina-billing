import { vi } from 'vitest';
import type { Orcamento } from '../src/domain/orcamento/orcamento';
import type { IOrcamentoRepository } from '../src/domain/repositories/orcamentos.repository.interface';
import type { IGatewayPagamento } from '../src/domain/services/gateway-pagamento.interface';
import type { Mensagem } from '../src/domain/mensageria/mensagem';

export const ORDEM_ID = 'd4e5f6a7-b8c9-0123-defa-234567890123';
export const ORC_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
export const CLIENTE_ID = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

export const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
export const rastreamento = { cabecalhosDePropagacao: () => ({ traceparent: 'tp' }) };

export function orcamento(sobrescrever: Partial<Orcamento> = {}): Orcamento {
  return {
    id: ORC_ID,
    ordemId: ORDEM_ID,
    sagaId: 'saga-1',
    numeroOS: 9,
    cliente: { id: CLIENTE_ID, nome: 'Ana', email: 'ana@x.com' },
    itens: [
      { tipo: 'SERVICO', referenciaId: 's', nome: 'Freio', quantidade: 1, precoUnitario: 200 },
      { tipo: 'PECA', referenciaId: 'p', nome: 'Pastilha', quantidade: 1, precoUnitario: 85 },
    ],
    valorTotal: 285,
    status: 'AGUARDANDO_APROVACAO',
    pagamento: null,
    motivo: null,
    historico: [],
    versao: 2,
    criadoEm: new Date(),
    atualizadoEm: new Date(),
    ...sobrescrever,
  };
}

export const pagamentoPendente = {
  status: 'PENDENTE' as const,
  preferenciaId: 'pref-1',
  linkPagamento: 'https://mp.test/pagar',
  pagamentoId: null,
  valor: null,
  metodo: null,
  detalhe: null,
  atualizadoEm: new Date(),
};

export function mensagem(tipo: string, dados: Record<string, unknown>): Mensagem {
  return {
    id: 'cmd-1',
    tipo,
    versao: 1,
    sagaId: 'saga-1',
    ordemId: ORDEM_ID,
    causadaPor: null,
    origem: 'oficina-os',
    ocorridaEm: new Date().toISOString(),
    dados,
  };
}

export const repoOrcamentos = () =>
  ({
    criar: vi.fn().mockResolvedValue('criado'),
    buscarPorId: vi.fn(),
    buscarPorOrdem: vi.fn(),
    listar: vi.fn(),
    mudar: vi.fn(),
    enfileirar: vi.fn(),
  }) as unknown as IOrcamentoRepository;

export const gatewayFalso = (simulado = false) =>
  ({
    simulado,
    criarCobranca: vi.fn(),
    consultarPagamento: vi.fn(),
    estornar: vi.fn(),
  }) as unknown as IGatewayPagamento;
