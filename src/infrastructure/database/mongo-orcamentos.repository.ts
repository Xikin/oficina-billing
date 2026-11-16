import { MongoServerError, type Collection, type Filter } from 'mongodb';
import type { DocumentoOrcamento, SaidaPendente } from './mongo';
import type { MensagemSaida } from '../../domain/mensageria/mensagem';
import type { Orcamento } from '../../domain/orcamento/orcamento';
import {
  OrcamentoAlteradoError,
  type IOrcamentoRepository,
  type ListarOrcamentosParams,
  type MudancaDeOrcamento,
} from '../../domain/repositories/orcamentos.repository.interface';

const CHAVE_DUPLICADA = 11000;

function paraSaidas(saidas: MensagemSaida[]): SaidaPendente[] {
  return saidas.map((s) => ({
    id: s.mensagem.id,
    routingKey: s.mensagem.tipo,
    payload: s.mensagem,
    cabecalhos: s.cabecalhos,
    criadoEm: new Date(),
  }));
}

export function paraOrcamento(doc: DocumentoOrcamento): Orcamento {
  const { _id, saidas: _saidas, bloqueadoAte: _bloqueio, ...resto } = doc;
  return { id: _id, ...resto };
}

export class MongoOrcamentoRepository implements IOrcamentoRepository {
  constructor(private readonly colecao: Collection<DocumentoOrcamento>) {}

  async criar(orcamento: Orcamento, saidas: MensagemSaida[]) {
    const { id, ...resto } = orcamento;
    try {
      await this.colecao.insertOne({
        _id: id,
        ...resto,
        saidas: paraSaidas(saidas),
        bloqueadoAte: null,
      });
      return 'criado' as const;
    } catch (erro) {
      if (erro instanceof MongoServerError && erro.code === CHAVE_DUPLICADA)
        return 'ja_existe' as const;
      throw erro;
    }
  }

  async buscarPorId(id: string) {
    const doc = await this.colecao.findOne({ _id: id });
    return doc ? paraOrcamento(doc) : null;
  }

  async buscarPorOrdem(ordemId: string) {
    const doc = await this.colecao.findOne({ ordemId });
    return doc ? paraOrcamento(doc) : null;
  }

  async listar({ page, limit, status }: ListarOrcamentosParams) {
    const filtro: Filter<DocumentoOrcamento> = status ? { status } : {};
    const [docs, total] = await Promise.all([
      this.colecao
        .find(filtro)
        .sort({ criadoEm: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      this.colecao.countDocuments(filtro),
    ]);
    return { data: docs.map(paraOrcamento), total };
  }

  async mudar(m: MudancaDeOrcamento) {
    const agora = new Date();
    const doc = await this.colecao.findOneAndUpdate(
      { _id: m.id, status: m.statusEsperado, versao: m.versaoEsperada },
      {
        $set: {
          status: m.novoStatus,
          atualizadoEm: agora,
          ...(m.pagamento && { pagamento: m.pagamento }),
          ...(m.motivo !== undefined && { motivo: m.motivo }),
        },
        $inc: { versao: 1 },
        $push: {
          historico: { status: m.novoStatus, observacao: m.observacao, em: agora },
          saidas: { $each: paraSaidas(m.saidas) },
        },
      },
      { returnDocument: 'after' },
    );
    if (!doc) throw new OrcamentoAlteradoError(m.id);
    return paraOrcamento(doc);
  }

  async enfileirar(id: string, saidas: MensagemSaida[]) {
    await this.colecao.updateOne({ _id: id }, { $push: { saidas: { $each: paraSaidas(saidas) } } });
  }
}
