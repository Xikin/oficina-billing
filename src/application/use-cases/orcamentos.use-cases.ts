import { NotFoundError } from '../../shared/errors';
import { novoEvento } from '../mensageria/contratos';
import { EVENTOS } from '../../domain/mensageria/mensagem';
import { proximoStatus } from '../../domain/orcamento/orcamento';
import type {
  IOrcamentoRepository,
  ListarOrcamentosParams,
} from '../../domain/repositories/orcamentos.repository.interface';
import type { IGatewayPagamento } from '../../domain/services/gateway-pagamento.interface';
import type { ILogger } from '../../domain/services/logger.service.interface';
import type { IRastreamento } from '../../domain/services/rastreamento.interface';

export interface Ator {
  sub: string;
  role: string;
}

const quem = (ator: Ator) => (ator.role === 'CLIENTE' ? 'cliente' : `oficina (${ator.role})`);

export class ListarOrcamentosUseCase {
  constructor(private readonly repo: IOrcamentoRepository) {}

  async execute(params: ListarOrcamentosParams) {
    const { data, total } = await this.repo.listar(params);
    return {
      data,
      meta: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }
}

export class BuscarOrcamentoUseCase {
  constructor(private readonly repo: IOrcamentoRepository) {}

  async porId(id: string) {
    const orcamento = await this.repo.buscarPorId(id);
    if (!orcamento) throw new NotFoundError('Orçamento');
    return orcamento;
  }

  async porOrdem(ordemId: string) {
    const orcamento = await this.repo.buscarPorOrdem(ordemId);
    if (!orcamento) throw new NotFoundError('Orçamento');
    return orcamento;
  }
}

export class DecidirOrcamentoUseCase {
  constructor(
    private readonly repo: IOrcamentoRepository,
    private readonly gateway: IGatewayPagamento,
    private readonly rastreamento: IRastreamento,
    private readonly logger: ILogger,
  ) {}

  async aprovar(id: string, ator: Ator) {
    const orcamento = await new BuscarOrcamentoUseCase(this.repo).porId(id);
    const novoStatus = proximoStatus('aprovar', orcamento.status);
    const cobranca = await this.gateway.criarCobranca(orcamento);

    const atualizado = await this.repo.mudar({
      id,
      statusEsperado: orcamento.status,
      versaoEsperada: orcamento.versao,
      novoStatus,
      observacao: `Aprovado pelo ${quem(ator)}; cobrança criada no Mercado Pago`,
      pagamento: {
        status: 'PENDENTE',
        preferenciaId: cobranca.preferenciaId,
        linkPagamento: cobranca.linkPagamento,
        pagamentoId: null,
        valor: null,
        metodo: null,
        detalhe: null,
        atualizadoEm: new Date(),
      },
      saidas: [
        novoEvento(
          EVENTOS.ORCAMENTO_APROVADO,
          orcamento,
          { orcamentoId: id, linkPagamento: cobranca.linkPagamento },
          null,
          this.rastreamento,
        ),
      ],
    });

    this.logger.info(
      {
        evento: 'orcamento_aprovado',
        orcamentoId: id,
        ordemId: orcamento.ordemId,
        sagaId: orcamento.sagaId,
        numeroOS: orcamento.numeroOS,
        valorTotal: orcamento.valorTotal,
        aprovadoPor: ator.role,
      },
      'orçamento aprovado',
    );
    return atualizado;
  }

  async reprovar(id: string, motivo: string | undefined, ator: Ator) {
    const orcamento = await new BuscarOrcamentoUseCase(this.repo).porId(id);
    const novoStatus = proximoStatus('reprovar', orcamento.status);
    const justificativa = motivo ?? 'Orçamento reprovado pelo cliente';

    const atualizado = await this.repo.mudar({
      id,
      statusEsperado: orcamento.status,
      versaoEsperada: orcamento.versao,
      novoStatus,
      observacao: `Reprovado pelo ${quem(ator)}: ${justificativa}`,
      motivo: justificativa,
      saidas: [
        novoEvento(
          EVENTOS.ORCAMENTO_REPROVADO,
          orcamento,
          { orcamentoId: id, motivo: justificativa },
          null,
          this.rastreamento,
        ),
      ],
    });

    this.logger.info(
      {
        evento: 'orcamento_reprovado',
        orcamentoId: id,
        ordemId: orcamento.ordemId,
        sagaId: orcamento.sagaId,
        numeroOS: orcamento.numeroOS,
        reprovadoPor: ator.role,
      },
      'orçamento reprovado',
    );
    return atualizado;
  }
}
