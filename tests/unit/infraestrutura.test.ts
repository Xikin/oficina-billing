import { createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { MongoServerError, type Collection } from 'mongodb';
import { MongoOrcamentoRepository } from '../../src/infrastructure/database/mongo-orcamentos.repository';
import { OutboxRelayMongo } from '../../src/infrastructure/mensageria/outbox-relay-mongo';
import {
  bancoAcessivel,
  criarIndices,
  type DocumentoOrcamento,
} from '../../src/infrastructure/database/mongo';
import {
  GatewaySimulado,
  MercadoPagoGateway,
} from '../../src/infrastructure/pagamentos/mercado-pago.gateway';
import { assinaturaValida } from '../../src/infrastructure/pagamentos/assinatura-webhook';
import { OrcamentoAlteradoError } from '../../src/domain/repositories/orcamentos.repository.interface';
import { GatewayIndisponivelError } from '../../src/domain/services/gateway-pagamento.interface';
import { ORC_ID, logger, orcamento } from '../fixtures';

const documento = (sobrescrever: Partial<DocumentoOrcamento> = {}): DocumentoOrcamento => {
  const { id, ...resto } = orcamento();
  return { _id: id, ...resto, saidas: [], bloqueadoAte: null, ...sobrescrever };
};

const colecao = () =>
  ({
    insertOne: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    createIndexes: vi.fn(),
  }) as unknown as Collection<DocumentoOrcamento>;

const saida = {
  mensagem: {
    id: 'ev-1',
    tipo: 'billing.evento.orcamento-gerado',
    versao: 1 as const,
    sagaId: 's',
    ordemId: 'o',
    causadaPor: null,
    origem: 'oficina-billing',
    ocorridaEm: '',
    dados: {},
  },
  cabecalhos: { traceparent: 'tp' },
};

describe('MongoOrcamentoRepository', () => {
  it('cria o documento com as saídas pendentes embutidas', async () => {
    const c = colecao();
    expect(await new MongoOrcamentoRepository(c).criar(orcamento(), [saida])).toBe('criado');
    const doc = vi.mocked(c.insertOne).mock.calls[0][0] as DocumentoOrcamento;
    expect(doc._id).toBe(ORC_ID);
    expect(doc.saidas).toEqual([
      expect.objectContaining({ id: 'ev-1', routingKey: 'billing.evento.orcamento-gerado' }),
    ]);
  });

  it('chave duplicada vira ja_existe; outros erros sobem', async () => {
    const c = colecao();
    vi.mocked(c.insertOne).mockRejectedValueOnce(
      new MongoServerError({ code: 11000, errmsg: 'dup' }),
    );
    expect(await new MongoOrcamentoRepository(c).criar(orcamento(), [])).toBe('ja_existe');
    vi.mocked(c.insertOne).mockRejectedValueOnce(new Error('rede'));
    await expect(new MongoOrcamentoRepository(c).criar(orcamento(), [])).rejects.toThrow('rede');
  });

  it('mudança é condicional ao status e à versão, e empilha histórico e saídas', async () => {
    const c = colecao();
    vi.mocked(c.findOneAndUpdate).mockResolvedValueOnce(documento({ status: 'APROVADO' }));
    const r = await new MongoOrcamentoRepository(c).mudar({
      id: ORC_ID,
      statusEsperado: 'AGUARDANDO_APROVACAO',
      versaoEsperada: 2,
      novoStatus: 'APROVADO',
      observacao: 'ok',
      motivo: 'm',
      saidas: [saida],
    });
    expect(r).toMatchObject({ id: ORC_ID, status: 'APROVADO' });
    expect(r).not.toHaveProperty('saidas');
    const [filtro, update] = vi.mocked(c.findOneAndUpdate).mock.calls[0];
    expect(filtro).toEqual({ _id: ORC_ID, status: 'AGUARDANDO_APROVACAO', versao: 2 });
    expect(update).toMatchObject({
      $set: { status: 'APROVADO', motivo: 'm' },
      $inc: { versao: 1 },
    });

    vi.mocked(c.findOneAndUpdate).mockResolvedValueOnce(null);
    await expect(
      new MongoOrcamentoRepository(c).mudar({
        id: ORC_ID,
        statusEsperado: 'APROVADO',
        versaoEsperada: 3,
        novoStatus: 'PAGO',
        observacao: 'x',
        saidas: [],
      }),
    ).rejects.toThrow(OrcamentoAlteradoError);
  });

  it('busca, lista e enfileira', async () => {
    const c = colecao();
    const repo = new MongoOrcamentoRepository(c);
    vi.mocked(c.findOne).mockResolvedValueOnce(documento()).mockResolvedValueOnce(null);
    expect((await repo.buscarPorId(ORC_ID))?.id).toBe(ORC_ID);
    expect(await repo.buscarPorOrdem('o')).toBeNull();

    const cursor = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([documento()]),
    };
    vi.mocked(c.find).mockReturnValue(cursor as never);
    vi.mocked(c.countDocuments).mockResolvedValue(1);
    const { data, total } = await repo.listar({ page: 2, limit: 10, status: 'PAGO' });
    expect(c.find).toHaveBeenCalledWith({ status: 'PAGO' });
    expect(cursor.skip).toHaveBeenCalledWith(10);
    expect([data.length, total]).toEqual([1, 1]);
    await repo.listar({ page: 1, limit: 10 });
    expect(c.find).toHaveBeenLastCalledWith({});

    await repo.enfileirar(ORC_ID, [saida]);
    expect(c.updateOne).toHaveBeenCalledWith(
      { _id: ORC_ID },
      { $push: { saidas: { $each: [expect.objectContaining({ id: 'ev-1' })] } } },
    );
  });

  it('cria índices e verifica o banco com ping', async () => {
    const c = colecao();
    await criarIndices(c);
    expect(vi.mocked(c.createIndexes).mock.calls[0][0]).toContainEqual(
      expect.objectContaining({ key: { ordemId: 1 }, unique: true }),
    );
    expect(await bancoAcessivel({ command: vi.fn().mockResolvedValue({ ok: 1 }) } as never)).toBe(
      true,
    );
    expect(await bancoAcessivel({ command: vi.fn().mockRejectedValue(new Error()) } as never)).toBe(
      false,
    );
  });
});

describe('OutboxRelayMongo', () => {
  const pendente = (id: string) => ({
    id,
    routingKey: 'billing.evento.cancelado',
    payload: { id },
    cabecalhos: {},
    criadoEm: new Date(),
  });

  it('reserva o documento, publica em ordem, remove cada saída e libera', async () => {
    const c = colecao();
    vi.mocked(c.findOneAndUpdate)
      .mockResolvedValueOnce(documento({ saidas: [pendente('a'), pendente('b')] }))
      .mockResolvedValueOnce(null);
    const publicador = { publicar: vi.fn().mockResolvedValue(undefined) };

    expect(await new OutboxRelayMongo(c, publicador, logger).publicarPendentes()).toBe(2);
    expect(publicador.publicar.mock.calls.map((x) => x[1])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(c.updateOne).toHaveBeenCalledWith({ _id: ORC_ID }, { $pull: { saidas: { id: 'a' } } });
    expect(c.updateOne).toHaveBeenLastCalledWith({ _id: ORC_ID }, { $set: { bloqueadoAte: null } });
  });

  it('para no erro de publicação e mantém a saída para o próximo ciclo', async () => {
    const c = colecao();
    vi.mocked(c.findOneAndUpdate).mockResolvedValueOnce(
      documento({ saidas: [pendente('a'), pendente('b')] }),
    );
    const publicador = { publicar: vi.fn().mockRejectedValue(new Error('broker fora')) };

    expect(await new OutboxRelayMongo(c, publicador, logger).publicarPendentes()).toBe(0);
    expect(publicador.publicar).toHaveBeenCalledTimes(1);
    expect(c.updateOne).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'outbox_publicacao_adiada', mensagemId: 'a' }),
      expect.any(String),
    );
  });

  it('roda em ciclos, registra falhas e para', async () => {
    vi.useFakeTimers();
    const c = colecao();
    vi.mocked(c.findOneAndUpdate).mockRejectedValue(new Error('mongo fora'));
    const relay = new OutboxRelayMongo(c, { publicar: vi.fn() }, logger, {
      intervaloMs: 50,
      documentosPorCiclo: 5,
      bloqueioMs: 1000,
    });
    relay.iniciar();
    relay.iniciar();
    await vi.advanceTimersByTimeAsync(60);
    await relay.parar();
    vi.useRealTimers();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'outbox_falhou', erro: 'mongo fora' }),
      expect.any(String),
    );
  });
});

describe('MercadoPagoGateway', () => {
  const gateway = (token = 'TEST-123') =>
    new MercadoPagoGateway({
      accessToken: token,
      apiUrl: 'https://mp.test',
      urlPublica: 'https://oficina.test',
    });

  const resposta = (corpo: unknown, status = 200) =>
    ({
      ok: status < 400,
      status,
      json: async () => corpo,
      text: async () => JSON.stringify(corpo),
    }) as Response;

  it('cria preferência com itens, referência externa e webhook; usa sandbox com token de teste', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        resposta({ id: 'pref', init_point: 'https://prod', sandbox_init_point: 'https://sandbox' }),
      );
    vi.stubGlobal('fetch', fetch);

    expect(await gateway().criarCobranca(orcamento())).toEqual({
      preferenciaId: 'pref',
      linkPagamento: 'https://sandbox',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://mp.test/checkout/preferences');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer TEST-123',
      'x-idempotency-key': `cobranca-${ORC_ID}`,
    });
    const corpo = JSON.parse(init.body);
    expect(corpo).toMatchObject({
      external_reference: ORC_ID,
      notification_url: 'https://oficina.test/pagamentos/webhook',
      payer: { email: 'ana@x.com' },
    });
    expect(corpo.items[0]).toMatchObject({ title: 'Freio', unit_price: 200, currency_id: 'BRL' });

    expect(
      (
        await gateway('APP_USR-1').criarCobranca(
          orcamento({ cliente: { id: 'c', nome: 'A', email: null } }),
        )
      ).linkPagamento,
    ).toBe('https://prod');
    vi.unstubAllGlobals();
  });

  it('consulta pagamento e normaliza os campos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        resposta({
          id: 123,
          status: 'approved',
          status_detail: 'accredited',
          external_reference: ORC_ID,
          transaction_amount: 285,
          payment_method_id: 'pix',
        }),
      ),
    );
    expect(await gateway().consultarPagamento('123')).toEqual({
      id: '123',
      status: 'approved',
      detalhe: 'accredited',
      referenciaExterna: ORC_ID,
      valor: 285,
      metodo: 'pix',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resposta({ id: 1, status: 'pending', transaction_amount: 1 })),
    );
    expect(await gateway().consultarPagamento('1')).toMatchObject({ detalhe: null, metodo: null });
    vi.unstubAllGlobals();
  });

  it('estorno envia chave de idempotência; erros viram GatewayIndisponivelError', async () => {
    const fetch = vi.fn().mockResolvedValue(resposta({ id: 'ref' }, 201));
    vi.stubGlobal('fetch', fetch);
    await gateway().estornar('123', 'estorno-x');
    expect(fetch.mock.calls[0][0]).toBe('https://mp.test/v1/payments/123/refunds');
    expect(fetch.mock.calls[0][1].headers['x-idempotency-key']).toBe('estorno-x');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resposta({ message: 'bad' }, 400)));
    await expect(gateway().estornar('1', 'k')).rejects.toThrow(GatewayIndisponivelError);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(gateway().consultarPagamento('1')).rejects.toThrow(/timeout/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('texto'));
    await expect(gateway().consultarPagamento('1')).rejects.toThrow(/texto/);
    vi.unstubAllGlobals();
  });

  it('gateway simulado gera link local, não consulta e estorna sem efeito', async () => {
    const simulado = new GatewaySimulado('http://billing');
    expect((await simulado.criarCobranca(orcamento())).linkPagamento).toBe(
      `http://billing/pagamentos/simulador/${ORC_ID}`,
    );
    await expect(simulado.consultarPagamento('1')).rejects.toThrow(GatewayIndisponivelError);
    await expect(simulado.estornar()).resolves.toBeUndefined();
  });
});

describe('assinatura do webhook', () => {
  const segredo = 'segredo-do-webhook';
  const assinar = (id: string, requestId: string, ts: string) =>
    createHmac('sha256', segredo)
      .update(`id:${id};request-id:${requestId};ts:${ts};`)
      .digest('hex');

  it('aceita a assinatura calculada sobre id, request-id e ts', () => {
    const v1 = assinar('123', 'req-1', '1704908010');
    expect(
      assinaturaValida({
        cabecalhoAssinatura: `ts=1704908010,v1=${v1}`,
        requestId: 'req-1',
        dataId: '123',
        segredo,
      }),
    ).toBe(true);
  });

  it('usa o id em minúsculas quando é alfanumérico', () => {
    const v1 = assinar('abc123', 'r', '1704908010');
    expect(
      assinaturaValida({
        cabecalhoAssinatura: `ts=1704908010,v1=${v1}`,
        requestId: 'r',
        dataId: 'ABC123',
        segredo,
      }),
    ).toBe(true);
  });

  it('recusa assinatura errada, incompleta ou fora da tolerância quando exigida', () => {
    const base = { requestId: 'r', dataId: '1', segredo };
    expect(assinaturaValida({ ...base, cabecalhoAssinatura: undefined })).toBe(false);
    expect(assinaturaValida({ ...base, cabecalhoAssinatura: 'ts=1' })).toBe(false);
    expect(assinaturaValida({ ...base, cabecalhoAssinatura: 'ts=abc,v1=00' })).toBe(false);
    expect(assinaturaValida({ ...base, cabecalhoAssinatura: 'ts=1704908010,v1=00' })).toBe(false);
    const v1 = assinar('1', 'r', '1704908010');
    expect(
      assinaturaValida({
        ...base,
        cabecalhoAssinatura: `ts=1704908010,v1=${v1}`,
        toleranciaSegundos: 60,
        agoraMs: 1704908010 * 1000 + 61_000,
      }),
    ).toBe(false);
    expect(
      assinaturaValida({
        ...base,
        cabecalhoAssinatura: `ts=1704908010,v1=${v1}`,
        toleranciaSegundos: 60,
      }),
    ).toBe(false);
  });
});
