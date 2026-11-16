import { buildApp } from './app';
import { env } from './config/env';
import { bancoAcessivel, conectarMongo } from './infrastructure/database/mongo';
import { MongoOrcamentoRepository } from './infrastructure/database/mongo-orcamentos.repository';
import { RabbitMQ } from './infrastructure/mensageria/rabbitmq';
import { OutboxRelayMongo } from './infrastructure/mensageria/outbox-relay-mongo';
import { RastreamentoNewRelic } from './infrastructure/observabilidade/rastreamento-newrelic';
import {
  GatewaySimulado,
  MercadoPagoGateway,
} from './infrastructure/pagamentos/mercado-pago.gateway';
import {
  CONSUMIDOR_COMANDOS,
  ProcessarComandoUseCase,
} from './application/mensageria/processar-comando.use-case';
import { lerEnvelope } from './application/mensageria/contratos';
import { SERVICO_BILLING } from './domain/mensageria/mensagem';

async function start() {
  const rastreamento = new RastreamentoNewRelic();
  const mongo = await conectarMongo(env.MONGODB_URI, env.MONGODB_DB);
  const repo = new MongoOrcamentoRepository(mongo.orcamentos);
  const gateway =
    env.MERCADO_PAGO_MODO === 'real'
      ? new MercadoPagoGateway({
          accessToken: env.MERCADO_PAGO_ACCESS_TOKEN!,
          apiUrl: env.MERCADO_PAGO_API_URL,
          urlPublica: env.BILLING_URL_PUBLICA,
        })
      : new GatewaySimulado(env.BILLING_URL_PUBLICA);

  let mensageria: RabbitMQ | null = null;
  const app = await buildApp({
    repo,
    gateway,
    rastreamento,
    bancoAcessivel: () => bancoAcessivel(mongo.db),
    segredoWebhook: env.MERCADO_PAGO_WEBHOOK_SECRET,
    mensageria: env.RABBITMQ_URL
      ? {
          get conectado() {
            return mensageria?.conectado ?? false;
          },
        }
      : null,
  });
  const logger = app.log;

  if (gateway.simulado)
    logger.warn(
      { evento: 'mercado_pago_simulado' },
      'Mercado Pago em modo simulado: pagamentos são confirmados por /pagamentos/simulador',
    );

  let relay: OutboxRelayMongo | null = null;
  if (env.RABBITMQ_URL) {
    mensageria = new RabbitMQ({
      url: env.RABBITMQ_URL,
      exchange: env.RABBITMQ_EXCHANGE,
      servico: SERVICO_BILLING,
      maxTentativas: env.MENSAGERIA_MAX_TENTATIVAS,
      atrasoRetentativaMs: env.MENSAGERIA_ATRASO_RETENTATIVA_MS,
      logger,
      rastreamento,
    });
    const processar = new ProcessarComandoUseCase(repo, gateway, rastreamento, logger);
    mensageria.registrar({
      fila: CONSUMIDOR_COMANDOS,
      bindings: ['billing.comando.#'],
      prefetch: 1,
      tratar: (bruto) => processar.execute(lerEnvelope(bruto)),
    });
    await mensageria.conectar();

    relay = new OutboxRelayMongo(mongo.orcamentos, mensageria, logger, {
      intervaloMs: env.OUTBOX_INTERVALO_MS,
      documentosPorCiclo: 50,
      bloqueioMs: 30_000,
    });
    relay.iniciar();
  } else {
    logger.warn(
      { evento: 'mensageria_desligada' },
      'RABBITMQ_URL ausente: comandos da saga não serão recebidos',
    );
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ evento: 'servidor_iniciado', porta: env.PORT }, 'serviço de billing no ar');

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    logger.info({ evento: 'encerramento_iniciado', sinal }, 'encerrando graciosamente');
    try {
      await app.close();
      await relay?.parar();
      await mensageria?.encerrar();
      await mongo.cliente.close();
      process.exit(0);
    } catch (erro) {
      logger.error({ evento: 'encerramento_falhou', err: erro }, 'falha ao encerrar');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));
}

start().catch((err) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'oficina-billing',
      evento: 'falha_ao_iniciar',
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exit(1);
});
