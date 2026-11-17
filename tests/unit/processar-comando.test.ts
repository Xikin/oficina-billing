import { describe, it, expect, vi } from 'vitest';
import {
  CancelamentoAntesDoOrcamentoError,
  ProcessarComandoUseCase,
} from '../../src/application/mensageria/processar-comando.use-case';
import { COMANDOS, EVENTOS } from '../../src/domain/mensageria/mensagem';
import {
  gatewayFalso,
  logger,
  mensagem,
  orcamento,
  rastreamento,
  repoOrcamentos,
} from '../fixtures';

const gerar = (itens: unknown[]) =>
  mensagem(COMANDOS.GERAR_ORCAMENTO, {
    numeroOS: 9,
    cliente: { id: 'c', nome: 'Ana', email: 'ana@x.com' },
    itens,
  });

const cancelar = mensagem(COMANDOS.CANCELAR, { numeroOS: 9, orcamentoId: 'o', motivo: 'Desistiu' });

const montar = () => {
  const repo = repoOrcamentos();
  const gateway = gatewayFalso();
  return { repo, gateway, uc: new ProcessarComandoUseCase(repo, gateway, rastreamento, logger) };
};

describe('gerar orçamento', () => {
  it('cria o orçamento com o total e enfileira orcamento-gerado', async () => {
    const { repo, uc } = montar();
    await uc.execute(
      gerar([
        { tipo: 'SERVICO', referenciaId: 's', nome: 'Freio', quantidade: 1, precoUnitario: 200 },
        { tipo: 'PECA', referenciaId: 'p', nome: 'Pastilha', quantidade: 2, precoUnitario: 85.5 },
      ]),
    );
    const [criado, saidas] = vi.mocked(repo.criar).mock.calls[0];
    expect(criado).toMatchObject({ status: 'AGUARDANDO_APROVACAO', valorTotal: 371, numeroOS: 9 });
    expect(saidas[0].mensagem).toMatchObject({
      tipo: EVENTOS.ORCAMENTO_GERADO,
      causadaPor: 'cmd-1',
      dados: { orcamentoId: criado.id, valorTotal: 371 },
    });
  });

  it('sem itens grava o orçamento encerrado e avisa a falha para a saga compensar', async () => {
    const { repo, uc } = montar();
    await uc.execute(gerar([]));
    const [criado, saidas] = vi.mocked(repo.criar).mock.calls[0];
    expect(criado.status).toBe('CANCELADO');
    expect(saidas[0].mensagem.tipo).toBe(EVENTOS.ORCAMENTO_FALHOU);
  });

  it('comando repetido não duplica o orçamento', async () => {
    const { repo, uc } = montar();
    vi.mocked(repo.criar).mockResolvedValue('ja_existe');
    await uc.execute(gerar([]));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'comando_ignorado' }),
      expect.any(String),
    );
  });
});

describe('cancelar (compensação)', () => {
  it('orçamento pago é estornado no Mercado Pago com chave de idempotência', async () => {
    const { repo, gateway, uc } = montar();
    vi.mocked(repo.buscarPorOrdem).mockResolvedValue(
      orcamento({
        status: 'PAGO',
        pagamento: {
          status: 'APROVADO',
          preferenciaId: 'pref',
          linkPagamento: 'l',
          pagamentoId: 'pg-1',
          valor: 285,
          metodo: 'pix',
          detalhe: null,
          atualizadoEm: new Date(),
        },
      }),
    );

    await uc.execute(cancelar);

    expect(gateway.estornar).toHaveBeenCalledWith('pg-1', `estorno-${orcamento().id}`);
    const m = vi.mocked(repo.mudar).mock.calls[0][0];
    expect(m).toMatchObject({
      statusEsperado: 'PAGO',
      novoStatus: 'ESTORNADO',
      pagamento: { status: 'ESTORNADO' },
    });
    expect(m.saidas[0].mensagem).toMatchObject({
      tipo: EVENTOS.CANCELADO,
      dados: { estornado: true },
    });
  });

  it('orçamento ainda não pago é só cancelado', async () => {
    const { repo, gateway, uc } = montar();
    vi.mocked(repo.buscarPorOrdem).mockResolvedValue(orcamento({ status: 'APROVADO' }));
    await uc.execute(cancelar);
    expect(gateway.estornar).not.toHaveBeenCalled();
    const m = vi.mocked(repo.mudar).mock.calls[0][0];
    expect(m.novoStatus).toBe('CANCELADO');
    expect(m.saidas[0].mensagem.dados).toMatchObject({ estornado: false });
  });

  it.each([
    ['REPROVADO', false],
    ['ESTORNADO', true],
  ] as const)('orçamento %s só reconfirma o cancelamento', async (status, estornado) => {
    const { repo, uc } = montar();
    vi.mocked(repo.buscarPorOrdem).mockResolvedValue(orcamento({ status }));
    await uc.execute(cancelar);
    expect(repo.mudar).not.toHaveBeenCalled();
    const [, saidas] = vi.mocked(repo.enfileirar).mock.calls[0];
    expect(saidas[0].mensagem.dados).toMatchObject({ estornado });
  });

  it('cancelamento antes do pedido de orçamento deixa registro e confirma', async () => {
    const { repo, uc } = montar();
    vi.mocked(repo.buscarPorOrdem).mockResolvedValue(null);
    await uc.execute(cancelar);
    const [criado, saidas] = vi.mocked(repo.criar).mock.calls[0];
    expect(criado.status).toBe('CANCELADO');
    expect(saidas[0].mensagem.tipo).toBe(EVENTOS.CANCELADO);
  });

  it('se o orçamento nascer durante o cancelamento, reprocessa', async () => {
    const { repo, uc } = montar();
    vi.mocked(repo.buscarPorOrdem).mockResolvedValue(null);
    vi.mocked(repo.criar).mockResolvedValue('ja_existe');
    await expect(uc.execute(cancelar)).rejects.toThrow(CancelamentoAntesDoOrcamentoError);
  });
});
