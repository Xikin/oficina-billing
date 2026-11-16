import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DadosDaAssinatura {
  cabecalhoAssinatura: string | undefined;
  requestId: string | undefined;
  dataId: string;
  segredo: string;
  agoraMs?: number;
  toleranciaSegundos?: number;
}

export function assinaturaValida(dados: DadosDaAssinatura): boolean {
  if (!dados.cabecalhoAssinatura || !dados.requestId) return false;

  const partes = Object.fromEntries(
    dados.cabecalhoAssinatura.split(',').map((parte) => {
      const [chave, ...valor] = parte.trim().split('=');
      return [chave, valor.join('=')];
    }),
  );
  const ts = partes.ts;
  const recebida = partes.v1;
  if (!ts || !recebida) return false;

  const tsMs = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  if (!Number.isFinite(tsMs)) return false;
  if (dados.toleranciaSegundos !== undefined) {
    const agora = dados.agoraMs ?? Date.now();
    if (Math.abs(agora - tsMs) > dados.toleranciaSegundos * 1000) return false;
  }

  const id = /^[a-z0-9]+$/i.test(dados.dataId) ? dados.dataId.toLowerCase() : dados.dataId;
  const manifesto = `id:${id};request-id:${dados.requestId};ts:${ts};`;
  const esperada = createHmac('sha256', dados.segredo).update(manifesto).digest('hex');

  const a = Buffer.from(esperada);
  const b = Buffer.from(recebida);
  return a.length === b.length && timingSafeEqual(a, b);
}
