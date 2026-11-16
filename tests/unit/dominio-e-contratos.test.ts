import { describe, it, expect } from 'vitest';
import {
  calcularTotal,
  desfechoDoMercadoPago,
  permite,
  proximoStatus,
  TransicaoInvalidaError,
  valorConfere,
} from '../../src/domain/orcamento/orcamento';
import {
  interpretarComando,
  lerEnvelope,
  novoEvento,
} from '../../src/application/mensageria/contratos';
import { COMANDOS, EVENTOS, MensagemInvalidaError } from '../../src/domain/mensageria/mensagem';
import { mensagem, rastreamento } from '../fixtures';

describe('regras do orçamento', () => {
  it.each([
    ['aprovar', 'AGUARDANDO_APROVACAO', 'APROVADO'],
    ['reprovar', 'AGUARDANDO_APROVACAO', 'REPROVADO'],
    ['confirmarPagamento', 'APROVADO', 'PAGO'],
    ['recusarPagamento', 'APROVADO', 'PAGAMENTO_RECUSADO'],
    ['cancelar', 'APROVADO', 'CANCELADO'],
    ['estornar', 'PAGO', 'ESTORNADO'],
  ] as const)('%s: %s → %s', (acao, de, para) => {
    expect(proximoStatus(acao, de)).toBe(para);
  });

  it('não aprova orçamento já reprovado', () => {
    expect(() => proximoStatus('aprovar', 'REPROVADO')).toThrow(TransicaoInvalidaError);
    expect(permite('cancelar', 'PAGO')).toBe(false);
  });

  it('soma em centavos', () => {
    expect(
      calcularTotal([
        { tipo: 'PECA', referenciaId: 'a', nome: 'a', quantidade: 3, precoUnitario: 0.1 },
        { tipo: 'PECA', referenciaId: 'b', nome: 'b', quantidade: 1, precoUnitario: 0.2 },
      ]),
    ).toBe(0.5);
  });

  it.each([
    ['approved', 'aprovado'],
    ['rejected', 'recusado'],
    ['cancelled', 'recusado'],
    ['refunded', 'estornado'],
    ['charged_back', 'estornado'],
    ['in_process', 'pendente'],
  ])('status %s do Mercado Pago vira %s', (status, desfecho) => {
    expect(desfechoDoMercadoPago(status)).toBe(desfecho);
  });

  it('valor confere quando paga o total ou mais', () => {
    expect(valorConfere(285, 285)).toBe(true);
    expect(valorConfere(284.99, 285)).toBe(false);
  });
});

describe('contratos de mensagem', () => {
  const gerar = {
    numeroOS: 9,
    cliente: { id: 'c', nome: 'Ana', email: null },
    itens: [{ tipo: 'PECA', referenciaId: 'p', nome: 'F', quantidade: 1, precoUnitario: 1 }],
  };

  it('interpreta gerar orçamento e cancelar', () => {
    expect(interpretarComando(lerEnvelope(mensagem(COMANDOS.GERAR_ORCAMENTO, gerar))).tipo).toBe(
      COMANDOS.GERAR_ORCAMENTO,
    );
    expect(
      interpretarComando(
        mensagem(COMANDOS.CANCELAR, { numeroOS: 9, orcamentoId: null, motivo: 'x' }),
      ),
    ).toMatchObject({ motivo: 'x' });
  });

  it('rejeita envelope, comando ou dados inválidos', () => {
    expect(() => lerEnvelope({ id: 'x' })).toThrow(MensagemInvalidaError);
    expect(() => interpretarComando(mensagem('billing.comando.voar', {}))).toThrow(/desconhecido/);
    expect(() =>
      interpretarComando(mensagem(COMANDOS.GERAR_ORCAMENTO, { ...gerar, itens: [{ tipo: 'X' }] })),
    ).toThrow(/Dados inválidos/);
  });

  it('monta evento com origem e número da OS', () => {
    const saida = novoEvento(
      EVENTOS.ORCAMENTO_GERADO,
      { sagaId: 's', ordemId: 'o', numeroOS: 3 },
      { valorTotal: 10 },
      'causa',
      rastreamento,
    );
    expect(saida.mensagem).toMatchObject({
      origem: 'oficina-billing',
      causadaPor: 'causa',
      dados: { numeroOS: 3, valorTotal: 10 },
    });
  });
});
