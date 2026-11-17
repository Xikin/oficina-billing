import { describe, it, expect, vi } from 'vitest';
import {
  BuscarOrcamentoUseCase,
  DecidirOrcamentoUseCase,
  ListarOrcamentosUseCase,
} from '../../src/application/use-cases/orcamentos.use-cases';
import {
  ProcessarNotificacaoUseCase,
  RegistrarPagamentoUseCase,
  SimularPagamentoUseCase,
} from '../../src/application/use-cases/pagamentos.use-cases';
import { EVENTOS } from '../../src/domain/mensageria/mensagem';
import { TransicaoInvalidaError } from '../../src/domain/orcamento/orcamento';
import { NotFoundError } from '../../src/shared/errors';
import {
  ORC_ID,
  gatewayFalso,
  logger,
  orcamento,
  pagamentoPendente,
  rastreamento,
  repoOrcamentos,
} from '../fixtures';

const cliente = { sub: 'c', role: 'CLIENTE' };
const funcionario = { sub: 'f', role: 'FUNCIONARIO' };

describe('consultas', () => {
  it('lista com paginação e busca com 404', async () => {
    const repo = repoOrcamentos();
    vi.mocked(repo.listar).mockResolvedValue({ data: [], total: 3 });
    expect(
      (await new ListarOrcamentosUseCase(repo).execute({ page: 1, limit: 2 })).meta.totalPages,
    ).toBe(2);
    const buscar = new BuscarOrcamentoUseCase(repo);
    vi.mocked(repo.buscarPorOrdem).mockResolvedValue(orcamento());
    expect((await buscar.porOrdem('o')).id).toBe(ORC_ID);
    vi.mocked(repo.buscarPorId).mockResolvedValue(null);
    await expect(buscar.porId('x')).rejects.toThrow(NotFoundError);
    vi.mocked(repo.buscarPorOrdem).mockResolvedValue(null);
    await expect(buscar.porOrdem('x')).rejects.toThrow(NotFoundError);
  });
});

describe('DecidirOrcamentoUseCase', () => {
  const montar = () => {
    const repo = repoOrcamentos();
    const gateway = gatewayFalso();
    vi.mocked(repo.buscarPorId).mockResolvedValue(orcamento());
    vi.mocked(repo.mudar).mockImplementation(async (m) => orcamento({ status: m.novoStatus }));
    return { repo, gateway, uc: new DecidirOrcamentoUseCase(repo, gateway, rastreamento, logger) };
  };

  it('aprovar cria a cobrança e publica o link de pagamento', async () => {
    const { repo, gateway, uc } = montar();
    vi.mocked(gateway.criarCobranca).mockResolvedValue({
      preferenciaId: 'pref-1',
      linkPagamento: 'https://mp.test/pagar',
    });

    expect((await uc.aprovar(ORC_ID, cliente)).status).toBe('APROVADO');

    const m = vi.mocked(repo.mudar).mock.calls[0][0];
    expect(m).toMatchObject({
      statusEsperado: 'AGUARDANDO_APROVACAO',
      versaoEsperada: 2,
      novoStatus: 'APROVADO',
      observacao: expect.stringContaining('cliente'),
      pagamento: { status: 'PENDENTE', preferenciaId: 'pref-1' },
    });
    expect(m.saidas[0].mensagem).toMatchObject({
      tipo: EVENTOS.ORCAMENTO_APROVADO,
      dados: { orcamentoId: ORC_ID, linkPagamento: 'https://mp.test/pagar' },
    });
  });

  it('não cria cobrança para orçamento que não está aguardando aprovação', async () => {
    const { repo, gateway, uc } = montar();
    vi.mocked(repo.buscarPorId).mockResolvedValue(orcamento({ status: 'REPROVADO' }));
    await expect(uc.aprovar(ORC_ID, cliente)).rejects.toThrow(TransicaoInvalidaError);
    expect(gateway.criarCobranca).not.toHaveBeenCalled();
  });

  it('reprovar publica o motivo, com padrão quando ausente', async () => {
    const { repo, uc } = montar();
    await uc.reprovar(ORC_ID, 'Caro', funcionario);
    expect(vi.mocked(repo.mudar).mock.calls[0][0]).toMatchObject({
      novoStatus: 'REPROVADO',
      motivo: 'Caro',
      observacao: expect.stringContaining('oficina (FUNCIONARIO)'),
    });
    await uc.reprovar(ORC_ID, undefined, cliente);
    expect(vi.mocked(repo.mudar).mock.calls[1][0].saidas[0].mensagem.dados).toMatchObject({
      motivo: 'Orçamento reprovado pelo cliente',
    });
  });
});

describe('RegistrarPagamentoUseCase', () => {
  const pagamento = (sobrescrever = {}) => ({
    id: 'pg-1',
    status: 'approved',
    detalhe: 'accredited',
    referenciaExterna: ORC_ID,
    valor: 285,
    metodo: 'pix',
    ...sobrescrever,
  });

  const montar = (status = 'APROVADO' as const, extra = {}) => {
    const repo = repoOrcamentos();
    const gateway = gatewayFalso();
    vi.mocked(repo.buscarPorId).mockResolvedValue(
      orcamento({ status, pagamento: pagamentoPendente, ...extra }),
    );
    return {
      repo,
      gateway,
      uc: new RegistrarPagamentoUseCase(repo, gateway, rastreamento, logger),
    };
  };

  it('aprovado com valor certo confirma e avisa a saga', async () => {
    const { repo, uc } = montar();
    expect(await uc.execute(pagamento())).toBe('confirmado');
    const m = vi.mocked(repo.mudar).mock.calls[0][0];
    expect(m).toMatchObject({
      novoStatus: 'PAGO',
      pagamento: {
        status: 'APROVADO',
        pagamentoId: 'pg-1',
        linkPagamento: 'https://mp.test/pagar',
      },
    });
    expect(m.saidas[0].mensagem).toMatchObject({
      tipo: EVENTOS.PAGAMENTO_CONFIRMADO,
      dados: { pagamentoId: 'pg-1', valor: 285 },
    });
  });

  it('valor menor que o orçamento é estornado e tratado como recusa', async () => {
    const { repo, gateway, uc } = montar();
    expect(await uc.execute(pagamento({ valor: 100 }))).toBe('recusado');
    expect(gateway.estornar).toHaveBeenCalledWith('pg-1', 'estorno-divergente-pg-1');
    expect(vi.mocked(repo.mudar).mock.calls[0][0].saidas[0].mensagem.tipo).toBe(
      EVENTOS.PAGAMENTO_RECUSADO,
    );
  });

  it('recusado pelo Mercado Pago avisa a saga com o detalhe', async () => {
    const { repo, uc } = montar();
    expect(await uc.execute(pagamento({ status: 'rejected', detalhe: 'cc_rejected' }))).toBe(
      'recusado',
    );
    expect(vi.mocked(repo.mudar).mock.calls[0][0].saidas[0].mensagem.dados).toMatchObject({
      motivo: 'cc_rejected',
    });
    await uc.execute(pagamento({ status: 'cancelled', detalhe: null }));
    expect(vi.mocked(repo.mudar).mock.calls[1][0].motivo).toBe('cancelled');
  });

  it('pagamento depois do cancelamento é estornado e registrado', async () => {
    const { repo, gateway, uc } = montar('CANCELADO' as never);
    expect(await uc.execute(pagamento())).toBe('estornado_tardio');
    expect(gateway.estornar).toHaveBeenCalledWith('pg-1', 'estorno-excedente-pg-1');
    expect(vi.mocked(repo.mudar).mock.calls[0][0]).toMatchObject({
      statusEsperado: 'CANCELADO',
      novoStatus: 'ESTORNADO',
      saidas: [],
    });
  });

  it('segundo pagamento de orçamento já pago é estornado sem mexer no orçamento', async () => {
    const { repo, gateway, uc } = montar('PAGO' as never, {
      pagamento: { ...pagamentoPendente, status: 'APROVADO', pagamentoId: 'pg-original' },
    });
    expect(await uc.execute(pagamento({ id: 'pg-dobrado' }))).toBe('estornado_tardio');
    expect(gateway.estornar).toHaveBeenCalledWith('pg-dobrado', 'estorno-excedente-pg-dobrado');
    expect(repo.mudar).not.toHaveBeenCalled();
  });

  it('notificação repetida do mesmo pagamento é ignorada', async () => {
    const { repo, gateway, uc } = montar('PAGO' as never, {
      pagamento: { ...pagamentoPendente, status: 'APROVADO', pagamentoId: 'pg-1' },
    });
    expect(await uc.execute(pagamento())).toBe('ignorado');
    expect(gateway.estornar).not.toHaveBeenCalled();
    expect(repo.mudar).not.toHaveBeenCalled();
  });

  it('pendente ou sem orçamento é ignorado', async () => {
    const { repo, uc } = montar();
    expect(await uc.execute(pagamento({ status: 'in_process' }))).toBe('ignorado');
    expect(await uc.execute(pagamento({ referenciaExterna: null }))).toBe('ignorado');
    vi.mocked(repo.buscarPorId).mockResolvedValue(null);
    expect(await uc.execute(pagamento())).toBe('ignorado');
  });

  it('notificação do webhook consulta o pagamento na API antes de registrar', async () => {
    const { gateway, uc } = montar();
    vi.mocked(gateway.consultarPagamento).mockResolvedValue(pagamento());
    expect(await new ProcessarNotificacaoUseCase(gateway, uc).execute('pg-1')).toBe('confirmado');
    expect(gateway.consultarPagamento).toHaveBeenCalledWith('pg-1');
  });

  it('simulador gera um pagamento do valor do orçamento', async () => {
    const { repo, uc } = montar();
    expect(await new SimularPagamentoUseCase(repo, uc).execute(ORC_ID, true)).toBe('confirmado');
    expect(await new SimularPagamentoUseCase(repo, uc).execute(ORC_ID, false)).toBe('recusado');
    vi.mocked(repo.buscarPorId).mockResolvedValue(null);
    await expect(new SimularPagamentoUseCase(repo, uc).execute(ORC_ID, true)).rejects.toThrow(
      NotFoundError,
    );
  });
});
