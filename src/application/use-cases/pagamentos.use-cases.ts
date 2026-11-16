import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../shared/errors';
import { novoEvento } from '../mensageria/contratos';
import { EVENTOS } from '../../domain/mensageria/mensagem';
import {
  desfechoDoMercadoPago,
  valorConfere,
  type Orcamento,
} from '../../domain/orcamento/orcamento';
import type { IOrcamentoRepository } from '../../domain/repositories/orcamentos.repository.interface';
import type {
  IGatewayPagamento,
  PagamentoNoGateway,
} from '../../domain/services/gateway-pagamento.interface';
import type { ILogger } from '../../domain/services/logger.service.interface';
import type { IRastreamento } from '../../domain/services/rastreamento.interface';

export type ResultadoDoPagamento = 'confirmado' | 'recusado' | 'estornado_tardio' | 'ignorado';

export class RegistrarPagamentoUseCase {
  constructor(
    private readonly repo: IOrcamentoRepository,
    private readonly gateway: IGatewayPagamento,
    private readonly rastreamento: IRastreamento,
    private readonly logger: ILogger,
  ) {}

  async execute(pagamento: PagamentoNoGateway): Promise<ResultadoDoPagamento> {
    const contexto = {
      pagamentoId: pagamento.id,
      statusGateway: pagamento.status,
      orcamentoId: pagamento.referenciaExterna,
    };

    const orcamento = pagamento.referenciaExterna
      ? await this.repo.buscarPorId(pagamento.referenciaExterna)
      : null;
    if (!orcamento) {
      this.logger.warn(
        { evento: 'pagamento_sem_orcamento', ...contexto },
        'notificação de pagamento sem orçamento correspondente',
      );
      return 'ignorado';
    }

    const desfecho = desfechoDoMercadoPago(pagamento.status);
    const registro = { ...contexto, ordemId: orcamento.ordemId, sagaId: orcamento.sagaId };

    if (desfecho === 'aprovado' && orcamento.status === 'APROVADO') {
      if (!valorConfere(pagamento.valor, orcamento.valorTotal)) {
        await this.gateway.estornar(pagamento.id, `estorno-divergente-${pagamento.id}`);
        return this.recusar(
          orcamento,
          pagamento,
          `valor pago (R$ ${pagamento.valor.toFixed(2)}) menor que o orçamento; pagamento estornado`,
        );
      }
      await this.repo.mudar({
        id: orcamento.id,
        statusEsperado: 'APROVADO',
        versaoEsperada: orcamento.versao,
        novoStatus: 'PAGO',
        observacao: `Pagamento ${pagamento.id} aprovado`,
        pagamento: this.pagamentoAtualizado(orcamento, pagamento, 'APROVADO'),
        saidas: [
          novoEvento(
            EVENTOS.PAGAMENTO_CONFIRMADO,
            orcamento,
            { pagamentoId: pagamento.id, valor: pagamento.valor },
            null,
            this.rastreamento,
          ),
        ],
      });
      this.logger.info(
        { evento: 'pagamento_confirmado', ...registro, valor: pagamento.valor },
        'pagamento confirmado',
      );
      return 'confirmado';
    }

    if (desfecho === 'recusado' && orcamento.status === 'APROVADO')
      return this.recusar(orcamento, pagamento, pagamento.detalhe ?? pagamento.status);

    const jaQuitouOrcamento = orcamento.pagamento?.pagamentoId === pagamento.id;
    if (desfecho === 'aprovado' && !jaQuitouOrcamento) {
      await this.gateway.estornar(pagamento.id, `estorno-excedente-${pagamento.id}`);
      if (orcamento.status === 'CANCELADO')
        await this.repo.mudar({
          id: orcamento.id,
          statusEsperado: 'CANCELADO',
          versaoEsperada: orcamento.versao,
          novoStatus: 'ESTORNADO',
          observacao: `Pagamento ${pagamento.id} chegou depois do cancelamento e foi estornado`,
          pagamento: this.pagamentoAtualizado(orcamento, pagamento, 'ESTORNADO'),
          saidas: [],
        });
      this.logger.warn(
        {
          evento: 'pagamento_excedente_estornado',
          ...registro,
          statusOrcamento: orcamento.status,
          valor: pagamento.valor,
        },
        'pagamento que não quita o orçamento (tardio ou em dobro); estornado automaticamente',
      );
      return 'estornado_tardio';
    }

    this.logger.info(
      { evento: 'notificacao_ignorada', ...registro, statusOrcamento: orcamento.status, desfecho },
      'notificação de pagamento sem efeito no estado atual',
    );
    return 'ignorado';
  }

  private async recusar(
    orcamento: Orcamento,
    pagamento: PagamentoNoGateway,
    motivo: string,
  ): Promise<ResultadoDoPagamento> {
    await this.repo.mudar({
      id: orcamento.id,
      statusEsperado: 'APROVADO',
      versaoEsperada: orcamento.versao,
      novoStatus: 'PAGAMENTO_RECUSADO',
      observacao: `Pagamento ${pagamento.id} recusado: ${motivo}`,
      motivo,
      pagamento: this.pagamentoAtualizado(orcamento, pagamento, 'RECUSADO'),
      saidas: [
        novoEvento(EVENTOS.PAGAMENTO_RECUSADO, orcamento, { motivo }, null, this.rastreamento),
      ],
    });
    this.logger.warn(
      {
        evento: 'pagamento_recusado',
        orcamentoId: orcamento.id,
        ordemId: orcamento.ordemId,
        sagaId: orcamento.sagaId,
        pagamentoId: pagamento.id,
        motivo,
      },
      'pagamento recusado',
    );
    return 'recusado';
  }

  private pagamentoAtualizado(
    orcamento: Orcamento,
    pagamento: PagamentoNoGateway,
    status: 'APROVADO' | 'RECUSADO' | 'ESTORNADO',
  ) {
    return {
      status,
      preferenciaId: orcamento.pagamento?.preferenciaId ?? null,
      linkPagamento: orcamento.pagamento?.linkPagamento ?? null,
      pagamentoId: pagamento.id,
      valor: pagamento.valor,
      metodo: pagamento.metodo,
      detalhe: pagamento.detalhe,
      atualizadoEm: new Date(),
    };
  }
}

export class ProcessarNotificacaoUseCase {
  constructor(
    private readonly gateway: IGatewayPagamento,
    private readonly registrar: RegistrarPagamentoUseCase,
  ) {}

  async execute(pagamentoId: string) {
    return this.registrar.execute(await this.gateway.consultarPagamento(pagamentoId));
  }
}

export class SimularPagamentoUseCase {
  constructor(
    private readonly repo: IOrcamentoRepository,
    private readonly registrar: RegistrarPagamentoUseCase,
  ) {}

  async execute(orcamentoId: string, aprovado: boolean, valor?: number) {
    const orcamento = await this.repo.buscarPorId(orcamentoId);
    if (!orcamento) throw new NotFoundError('Orçamento');
    return this.registrar.execute({
      id: `sim-${randomUUID()}`,
      status: aprovado ? 'approved' : 'rejected',
      detalhe: aprovado ? 'accredited' : 'cc_rejected_insufficient_amount',
      referenciaExterna: orcamentoId,
      valor: valor ?? orcamento.valorTotal,
      metodo: 'simulado',
    });
  }
}
