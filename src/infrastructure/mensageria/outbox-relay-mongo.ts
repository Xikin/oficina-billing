import type { Collection } from 'mongodb';
import type { DocumentoOrcamento } from '../database/mongo';
import type { ILogger } from '../../domain/services/logger.service.interface';
import type { IPublicadorDeMensagens } from './rabbitmq';

export interface OpcoesDoRelay {
  intervaloMs: number;
  documentosPorCiclo: number;
  bloqueioMs: number;
}

export class OutboxRelayMongo {
  private temporizador: NodeJS.Timeout | null = null;
  private cicloAtual: Promise<void> | null = null;

  constructor(
    private readonly colecao: Collection<DocumentoOrcamento>,
    private readonly publicador: IPublicadorDeMensagens,
    private readonly logger: ILogger,
    private readonly opcoes: OpcoesDoRelay = {
      intervaloMs: 1000,
      documentosPorCiclo: 50,
      bloqueioMs: 30_000,
    },
  ) {}

  iniciar(): void {
    if (this.temporizador) return;
    this.temporizador = setInterval(() => {
      if (!this.cicloAtual)
        this.cicloAtual = this.ciclo().finally(() => {
          this.cicloAtual = null;
        });
    }, this.opcoes.intervaloMs);
  }

  async parar(): Promise<void> {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
    await this.cicloAtual;
  }

  private async ciclo(): Promise<void> {
    try {
      await this.publicarPendentes();
    } catch (erro) {
      this.logger.error(
        { evento: 'outbox_falhou', erro: erro instanceof Error ? erro.message : String(erro) },
        'falha no ciclo do outbox',
      );
    }
  }

  async publicarPendentes(): Promise<number> {
    let publicadas = 0;
    for (let i = 0; i < this.opcoes.documentosPorCiclo; i++) {
      const agora = new Date();
      const doc = await this.colecao.findOneAndUpdate(
        {
          'saidas.id': { $exists: true },
          $or: [{ bloqueadoAte: null }, { bloqueadoAte: { $lt: agora } }],
        },
        { $set: { bloqueadoAte: new Date(agora.getTime() + this.opcoes.bloqueioMs) } },
        { returnDocument: 'after', sort: { atualizadoEm: 1 } },
      );
      if (!doc) break;

      let falhou = false;
      for (const saida of doc.saidas) {
        try {
          await this.publicador.publicar(saida.routingKey, saida.payload, saida.cabecalhos);
        } catch (erro) {
          falhou = true;
          this.logger.warn(
            {
              evento: 'outbox_publicacao_adiada',
              mensagemId: saida.id,
              tipoMensagem: saida.routingKey,
              erro: erro instanceof Error ? erro.message : String(erro),
            },
            'mensagem do outbox não publicada; nova tentativa no próximo ciclo',
          );
          break;
        }
        await this.colecao.updateOne({ _id: doc._id }, { $pull: { saidas: { id: saida.id } } });
        publicadas++;
      }

      await this.colecao.updateOne({ _id: doc._id }, { $set: { bloqueadoAte: null } });
      if (falhou) break;
    }
    return publicadas;
  }
}
