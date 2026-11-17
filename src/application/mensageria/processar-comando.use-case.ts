import { randomUUID } from 'node:crypto';
import { interpretarComando, novoEvento } from './contratos';
import { COMANDOS, EVENTOS, type Mensagem } from '../../domain/mensageria/mensagem';
import { calcularTotal, permite, type Orcamento } from '../../domain/orcamento/orcamento';
import type { IOrcamentoRepository } from '../../domain/repositories/orcamentos.repository.interface';
import type { IGatewayPagamento } from '../../domain/services/gateway-pagamento.interface';
import type { ILogger } from '../../domain/services/logger.service.interface';
import type { IRastreamento } from '../../domain/services/rastreamento.interface';

export const CONSUMIDOR_COMANDOS = 'billing.comandos';

export class CancelamentoAntesDoOrcamentoError extends Error {
  constructor(ordemId: string) {
    super(`O orçamento da OS ${ordemId} foi criado durante o cancelamento; reprocessando`);
    this.name = 'CancelamentoAntesDoOrcamentoError';
  }
}

export class ProcessarComandoUseCase {
  constructor(
    private readonly repo: IOrcamentoRepository,
    private readonly gateway: IGatewayPagamento,
    private readonly rastreamento: IRastreamento,
    private readonly logger: ILogger,
  ) {}

  async execute(mensagem: Mensagem): Promise<void> {
    const comando = interpretarComando(mensagem);
    const contexto = {
      ordemId: mensagem.ordemId,
      sagaId: mensagem.sagaId,
      numeroOS: comando.numeroOS,
      mensagemId: mensagem.id,
      tipoMensagem: mensagem.tipo,
    };
    const evento = (
      tipo: (typeof EVENTOS)[keyof typeof EVENTOS],
      alvo: { sagaId: string; ordemId: string; numeroOS: number },
      dados: Record<string, unknown>,
    ) => novoEvento(tipo, alvo, dados, mensagem.id, this.rastreamento);

    if (comando.tipo === COMANDOS.GERAR_ORCAMENTO) {
      const agora = new Date();
      const semItens = comando.itens.length === 0;
      const orcamento: Orcamento = {
        id: randomUUID(),
        ordemId: mensagem.ordemId,
        sagaId: mensagem.sagaId,
        numeroOS: comando.numeroOS,
        cliente: comando.cliente,
        itens: comando.itens,
        valorTotal: calcularTotal(comando.itens),
        status: semItens ? 'CANCELADO' : 'AGUARDANDO_APROVACAO',
        pagamento: null,
        motivo: semItens ? 'Diagnóstico sem itens para orçar' : null,
        historico: [
          {
            status: semItens ? 'CANCELADO' : 'AGUARDANDO_APROVACAO',
            observacao: semItens
              ? 'Orçamento não gerado: diagnóstico sem itens'
              : 'Orçamento gerado a partir do diagnóstico',
            em: agora,
          },
        ],
        versao: 0,
        criadoEm: agora,
        atualizadoEm: agora,
      };
      const saida = semItens
        ? evento(EVENTOS.ORCAMENTO_FALHOU, orcamento, { motivo: orcamento.motivo })
        : evento(EVENTOS.ORCAMENTO_GERADO, orcamento, {
            orcamentoId: orcamento.id,
            valorTotal: orcamento.valorTotal,
          });

      const resultado = await this.repo.criar(orcamento, [saida]);
      if (resultado === 'ja_existe') {
        this.logger.warn(
          { evento: 'comando_ignorado', ...contexto },
          'a OS já tem orçamento (comando repetido ou cancelado antes)',
        );
        return;
      }
      this.logger.info(
        {
          evento: semItens ? 'orcamento_falhou' : 'orcamento_gerado',
          ...contexto,
          orcamentoId: orcamento.id,
          valorTotal: orcamento.valorTotal,
        },
        semItens ? 'orçamento não gerado' : 'orçamento gerado',
      );
      return;
    }

    const orcamento = await this.repo.buscarPorOrdem(mensagem.ordemId);

    if (!orcamento) {
      const agora = new Date();
      const registro: Orcamento = {
        id: randomUUID(),
        ordemId: mensagem.ordemId,
        sagaId: mensagem.sagaId,
        numeroOS: comando.numeroOS,
        cliente: { id: '', nome: '', email: null },
        itens: [],
        valorTotal: 0,
        status: 'CANCELADO',
        pagamento: null,
        motivo: comando.motivo,
        historico: [
          {
            status: 'CANCELADO',
            observacao: 'Cancelamento recebido antes do pedido de orçamento',
            em: agora,
          },
        ],
        versao: 0,
        criadoEm: agora,
        atualizadoEm: agora,
      };
      const criado = await this.repo.criar(registro, [
        evento(EVENTOS.CANCELADO, registro, { estornado: false }),
      ]);
      if (criado === 'ja_existe') throw new CancelamentoAntesDoOrcamentoError(mensagem.ordemId);
      this.logger.warn(
        { evento: 'orcamento_cancelado_antes_de_existir', ...contexto },
        'cancelamento chegou antes do pedido de orçamento',
      );
      return;
    }

    if (orcamento.status === 'PAGO' && orcamento.pagamento?.pagamentoId) {
      await this.gateway.estornar(orcamento.pagamento.pagamentoId, `estorno-${orcamento.id}`);
      await this.repo.mudar({
        id: orcamento.id,
        statusEsperado: 'PAGO',
        versaoEsperada: orcamento.versao,
        novoStatus: 'ESTORNADO',
        observacao: `Pagamento estornado: ${comando.motivo}`,
        motivo: comando.motivo,
        pagamento: { ...orcamento.pagamento, status: 'ESTORNADO', atualizadoEm: new Date() },
        saidas: [evento(EVENTOS.CANCELADO, orcamento, { estornado: true })],
      });
      this.logger.warn(
        {
          evento: 'pagamento_estornado',
          ...contexto,
          orcamentoId: orcamento.id,
          pagamentoId: orcamento.pagamento.pagamentoId,
          valor: orcamento.pagamento.valor,
        },
        'pagamento estornado na compensação da saga',
      );
      return;
    }

    if (permite('cancelar', orcamento.status)) {
      await this.repo.mudar({
        id: orcamento.id,
        statusEsperado: orcamento.status,
        versaoEsperada: orcamento.versao,
        novoStatus: 'CANCELADO',
        observacao: `Cancelado: ${comando.motivo}`,
        motivo: comando.motivo,
        saidas: [evento(EVENTOS.CANCELADO, orcamento, { estornado: false })],
      });
      this.logger.info(
        { evento: 'orcamento_cancelado', ...contexto, orcamentoId: orcamento.id },
        'orçamento cancelado na compensação da saga',
      );
      return;
    }

    await this.repo.enfileirar(orcamento.id, [
      evento(EVENTOS.CANCELADO, orcamento, { estornado: orcamento.status === 'ESTORNADO' }),
    ]);
    this.logger.info(
      { evento: 'orcamento_ja_encerrado', ...contexto, statusAtual: orcamento.status },
      'cancelamento confirmado: o orçamento já estava encerrado',
    );
  }
}
