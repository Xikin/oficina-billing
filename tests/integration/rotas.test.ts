import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { GatewayIndisponivelError } from '../../src/domain/services/gateway-pagamento.interface';
import { OrcamentoAlteradoError } from '../../src/domain/repositories/orcamentos.repository.interface';
import {
  CLIENTE_ID,
  ORC_ID,
  ORDEM_ID,
  gatewayFalso,
  orcamento,
  pagamentoPendente,
  repoOrcamentos,
} from '../fixtures';

const SEGREDO = 'segredo-webhook';
const repo = repoOrcamentos();
const gateway = gatewayFalso(true);
const bancoAcessivel = vi.fn();
let app: FastifyInstance;
let interno: string;
let dono: string;
let outro: string;

beforeAll(async () => {
  app = await buildApp({
    repo,
    gateway,
    bancoAcessivel,
    segredoWebhook: SEGREDO,
    mensageria: { conectado: false },
  });
  await app.ready();
  interno = app.jwt.sign({ sub: 'f', role: 'FUNCIONARIO' });
  dono = app.jwt.cliente.sign({ sub: CLIENTE_ID, role: 'CLIENTE' }, { iss: 'oficina-auth-lambda' });
  outro = app.jwt.cliente.sign({ sub: 'outro', role: 'CLIENTE' }, { iss: 'oficina-auth-lambda' });
});

afterAll(() => app.close());

beforeEach(() => {
  vi.mocked(repo.buscarPorId).mockResolvedValue(orcamento());
  vi.mocked(repo.buscarPorOrdem).mockResolvedValue(orcamento());
  vi.mocked(repo.mudar).mockImplementation(async (m) =>
    orcamento({ status: m.novoStatus, pagamento: m.pagamento ?? null }),
  );
  Object.assign(gateway, { simulado: true });
});

const como = (token: string) => ({ authorization: `Bearer ${token}` });

describe('orçamentos', () => {
  it('lista só para a oficina', async () => {
    vi.mocked(repo.listar).mockResolvedValue({ data: [orcamento()], total: 1 });
    expect(
      (await app.inject({ method: 'GET', url: '/orcamentos', headers: como(interno) })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/orcamentos', headers: como(dono) })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/orcamentos' })).statusCode).toBe(401);
  });

  it('cliente vê o próprio orçamento e não o de outro', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/orcamentos/${ORC_ID}`, headers: como(dono) }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/orcamentos/ordem/${ORDEM_ID}`,
          headers: como(outro),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/orcamentos/ordem/${ORDEM_ID}`,
          headers: como(interno),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('404 para orçamento inexistente', async () => {
    vi.mocked(repo.buscarPorId).mockResolvedValue(null);
    const res = await app.inject({
      method: 'GET',
      url: `/orcamentos/${ORC_ID}`,
      headers: como(interno),
    });
    expect(res.statusCode).toBe(404);
  });

  it('dono aprova e recebe o link; outro cliente é barrado', async () => {
    vi.mocked(gateway.criarCobranca).mockResolvedValue({
      preferenciaId: 'pref',
      linkPagamento: 'https://mp/pagar',
    });
    const ok = await app.inject({
      method: 'POST',
      url: `/orcamentos/${ORC_ID}/aprovar`,
      headers: como(dono),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pagamento.linkPagamento).toBe('https://mp/pagar');

    const barrado = await app.inject({
      method: 'POST',
      url: `/orcamentos/${ORC_ID}/aprovar`,
      headers: como(outro),
    });
    expect(barrado.statusCode).toBe(403);
  });

  it('502 quando o Mercado Pago está fora; 400 para transição inválida; 409 em concorrência', async () => {
    vi.mocked(gateway.criarCobranca).mockRejectedValue(
      new GatewayIndisponivelError('criar', 'timeout'),
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/orcamentos/${ORC_ID}/aprovar`,
          headers: como(dono),
        })
      ).statusCode,
    ).toBe(502);

    vi.mocked(repo.buscarPorId).mockResolvedValue(orcamento({ status: 'PAGO' }));
    const invalida = await app.inject({
      method: 'POST',
      url: `/orcamentos/${ORC_ID}/reprovar`,
      headers: como(dono),
      payload: {},
    });
    expect(invalida.statusCode).toBe(400);

    vi.mocked(repo.buscarPorId).mockResolvedValue(orcamento());
    vi.mocked(repo.mudar).mockRejectedValue(new OrcamentoAlteradoError(ORC_ID));
    const conflito = await app.inject({
      method: 'POST',
      url: `/orcamentos/${ORC_ID}/reprovar`,
      headers: como(interno),
      payload: { motivo: 'Muito caro' },
    });
    expect(conflito.statusCode).toBe(409);
  });

  it('valida o corpo da reprovação', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/orcamentos/${ORC_ID}/reprovar`,
      headers: como(dono),
      payload: { motivo: 'x' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('webhook do Mercado Pago', () => {
  const assinar = (id: string, requestId: string, ts = '1704908010') =>
    `ts=${ts},v1=${createHmac('sha256', SEGREDO).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex')}`;

  it('com assinatura válida consulta o pagamento e confirma', async () => {
    vi.mocked(repo.buscarPorId).mockResolvedValue(
      orcamento({ status: 'APROVADO', pagamento: pagamentoPendente }),
    );
    vi.mocked(gateway.consultarPagamento).mockResolvedValue({
      id: '555',
      status: 'approved',
      detalhe: 'accredited',
      referenciaExterna: ORC_ID,
      valor: 285,
      metodo: 'pix',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/pagamentos/webhook?data.id=555&type=payment',
      headers: { 'x-signature': assinar('555', 'req-9'), 'x-request-id': 'req-9' },
      payload: { type: 'payment', action: 'payment.updated', data: { id: '555' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resultado: 'confirmado' });
  });

  it('401 com assinatura inválida, sem consultar o Mercado Pago', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pagamentos/webhook',
      headers: { 'x-signature': 'ts=1,v1=00', 'x-request-id': 'r' },
      payload: { type: 'payment', data: { id: 1 } },
    });
    expect(res.statusCode).toBe(401);
    expect(gateway.consultarPagamento).not.toHaveBeenCalled();
  });

  it('ignora notificações que não são de pagamento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pagamentos/webhook?topic=merchant_order&id=1',
      payload: {},
    });
    expect(res.json()).toEqual({ resultado: 'ignorado' });
  });
});

describe('simulador e saúde', () => {
  it('simula aprovação no modo simulado e some no modo real', async () => {
    vi.mocked(repo.buscarPorId).mockResolvedValue(
      orcamento({ status: 'APROVADO', pagamento: pagamentoPendente }),
    );
    const ok = await app.inject({
      method: 'POST',
      url: `/pagamentos/simulador/${ORC_ID}`,
      payload: { aprovado: true },
    });
    expect(ok.json()).toEqual({ resultado: 'confirmado' });

    Object.assign(gateway, { simulado: false });
    const real = await app.inject({
      method: 'POST',
      url: `/pagamentos/simulador/${ORC_ID}`,
      payload: { aprovado: true },
    });
    expect(real.statusCode).toBe(404);
  });

  it('readiness reflete o MongoDB; erro inesperado vira 500', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    bancoAcessivel.mockResolvedValue(true);
    const pronto = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(pronto.json().dependencias).toEqual({
      mongodb: 'ok',
      mensageria: 'reconectando',
      mercadoPago: 'simulado',
    });
    bancoAcessivel.mockResolvedValue(false);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);

    vi.mocked(repo.listar).mockRejectedValue(new Error('boom'));
    const erro = await app.inject({ method: 'GET', url: '/orcamentos', headers: como(interno) });
    expect(erro.statusCode).toBe(500);
  });
});

describe('erros do próprio Fastify', () => {
  it('JSON malformado devolve 400, não 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/orcamentos/${ORC_ID}/aprovar`,
      headers: { ...como(dono), 'content-type': 'application/json' },
      payload: '{quebrado',
    });
    expect(res.statusCode).toBe(400);
  });
});
