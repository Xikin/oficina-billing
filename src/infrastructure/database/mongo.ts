import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Orcamento } from '../../domain/orcamento/orcamento';

export interface SaidaPendente {
  id: string;
  routingKey: string;
  payload: unknown;
  cabecalhos: Record<string, string>;
  criadoEm: Date;
}

export type DocumentoOrcamento = Omit<Orcamento, 'id'> & {
  _id: string;
  saidas: SaidaPendente[];
  bloqueadoAte: Date | null;
};

export const COLECAO_ORCAMENTOS = 'orcamentos';

export async function conectarMongo(uri: string, banco: string) {
  const cliente = new MongoClient(uri, {
    appName: 'oficina-billing',
    serverSelectionTimeoutMS: 5000,
  });
  await cliente.connect();
  const db = cliente.db(banco);
  const orcamentos = db.collection<DocumentoOrcamento>(COLECAO_ORCAMENTOS);
  await criarIndices(orcamentos);
  return { cliente, db, orcamentos };
}

export async function criarIndices(orcamentos: Collection<DocumentoOrcamento>) {
  await orcamentos.createIndexes([
    { key: { ordemId: 1 }, name: 'ordem_unica', unique: true },
    { key: { status: 1, criadoEm: -1 }, name: 'status_recentes' },
    { key: { 'cliente.id': 1, criadoEm: -1 }, name: 'por_cliente' },
    { key: { 'saidas.id': 1 }, name: 'saidas_pendentes', sparse: true },
  ]);
}

export async function bancoAcessivel(db: Db): Promise<boolean> {
  try {
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
