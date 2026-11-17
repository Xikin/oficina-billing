import {
  GatewayIndisponivelError,
  type Cobranca,
  type IGatewayPagamento,
  type PagamentoNoGateway,
} from '../../domain/services/gateway-pagamento.interface';
import type { Orcamento } from '../../domain/orcamento/orcamento';

export interface OpcoesMercadoPago {
  accessToken: string;
  apiUrl: string;
  urlPublica: string;
  timeoutMs?: number;
}

interface PreferenciaCriada {
  id: string;
  init_point: string;
  sandbox_init_point?: string;
}

interface PagamentoMercadoPago {
  id: number | string;
  status: string;
  status_detail?: string | null;
  external_reference?: string | null;
  transaction_amount: number;
  payment_method_id?: string | null;
}

export class MercadoPagoGateway implements IGatewayPagamento {
  readonly simulado = false;

  constructor(private readonly opcoes: OpcoesMercadoPago) {}

  private get ehTeste() {
    return this.opcoes.accessToken.startsWith('TEST-');
  }

  async criarCobranca(orcamento: Orcamento): Promise<Cobranca> {
    const preferencia = await this.chamar<PreferenciaCriada>(
      'criar a cobrança',
      'POST',
      '/checkout/preferences',
      {
        items: orcamento.itens.map((i) => ({
          id: i.referenciaId,
          title: i.nome,
          category_id: i.tipo === 'SERVICO' ? 'services' : 'others',
          quantity: i.quantidade,
          unit_price: i.precoUnitario,
          currency_id: 'BRL',
        })),
        external_reference: orcamento.id,
        notification_url: `${this.opcoes.urlPublica}/pagamentos/webhook`,
        statement_descriptor: 'OFICINA',
        metadata: { ordem_id: orcamento.ordemId, numero_os: orcamento.numeroOS },
        ...(orcamento.cliente.email && { payer: { email: orcamento.cliente.email } }),
      },
      `cobranca-${orcamento.id}`,
    );
    return {
      preferenciaId: preferencia.id,
      linkPagamento:
        this.ehTeste && preferencia.sandbox_init_point
          ? preferencia.sandbox_init_point
          : preferencia.init_point,
    };
  }

  async consultarPagamento(pagamentoId: string): Promise<PagamentoNoGateway> {
    const p = await this.chamar<PagamentoMercadoPago>(
      'consultar o pagamento',
      'GET',
      `/v1/payments/${encodeURIComponent(pagamentoId)}`,
    );
    return {
      id: String(p.id),
      status: p.status,
      detalhe: p.status_detail ?? null,
      referenciaExterna: p.external_reference ?? null,
      valor: p.transaction_amount,
      metodo: p.payment_method_id ?? null,
    };
  }

  async estornar(pagamentoId: string, chaveIdempotencia: string): Promise<void> {
    await this.chamar(
      'estornar o pagamento',
      'POST',
      `/v1/payments/${encodeURIComponent(pagamentoId)}/refunds`,
      {},
      chaveIdempotencia,
    );
  }

  private async chamar<T>(
    operacao: string,
    metodo: 'GET' | 'POST',
    caminho: string,
    corpo?: unknown,
    chaveIdempotencia?: string,
  ): Promise<T> {
    let resposta: Response;
    try {
      resposta = await fetch(`${this.opcoes.apiUrl}${caminho}`, {
        method: metodo,
        headers: {
          authorization: `Bearer ${this.opcoes.accessToken}`,
          'content-type': 'application/json',
          ...(chaveIdempotencia && { 'x-idempotency-key': chaveIdempotencia }),
        },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(this.opcoes.timeoutMs ?? 10_000),
      });
    } catch (erro) {
      throw new GatewayIndisponivelError(
        operacao,
        erro instanceof Error ? erro.message : String(erro),
      );
    }

    if (!resposta.ok) {
      const detalhe = (await resposta.text()).slice(0, 300);
      throw new GatewayIndisponivelError(operacao, `HTTP ${resposta.status} ${detalhe}`);
    }
    return (await resposta.json()) as T;
  }
}

export class GatewaySimulado implements IGatewayPagamento {
  readonly simulado = true;

  constructor(private readonly urlPublica: string) {}

  async criarCobranca(orcamento: Orcamento): Promise<Cobranca> {
    return {
      preferenciaId: `sim-pref-${orcamento.id}`,
      linkPagamento: `${this.urlPublica}/pagamentos/simulador/${orcamento.id}`,
    };
  }

  async consultarPagamento(pagamentoId: string): Promise<PagamentoNoGateway> {
    throw new GatewayIndisponivelError(
      'consultar o pagamento',
      `modo simulado não consulta pagamentos reais (${pagamentoId}); use /pagamentos/simulador`,
    );
  }

  async estornar(): Promise<void> {}
}
