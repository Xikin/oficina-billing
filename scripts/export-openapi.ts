import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

process.env.NODE_ENV ??= 'development';
process.env.MONGODB_URI ??= 'mongodb://localhost:27017';
process.env.JWT_SECRET ??= 'placeholder-para-exportar-openapi-32-chars';
process.env.JWT_CLIENTE_SECRET ??= 'placeholder-cliente-para-exportar-openapi-32';
process.env.SWAGGER_ENABLED = 'true';

async function exportar() {
  const { buildApp } = await import('../src/app');
  const { GatewaySimulado } = await import('../src/infrastructure/pagamentos/mercado-pago.gateway');

  const indisponivel = async () => {
    throw new Error('repositório indisponível ao exportar a especificação');
  };
  const app = await buildApp({
    repo: {
      criar: indisponivel,
      buscarPorId: indisponivel,
      buscarPorOrdem: indisponivel,
      listar: indisponivel,
      mudar: indisponivel,
      enfileirar: indisponivel,
    },
    gateway: new GatewaySimulado('http://localhost:3000'),
    bancoAcessivel: async () => true,
  });
  await app.ready();

  const spec = app.swagger();
  const destino = resolve(__dirname, '..', 'docs', 'openapi.json');
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, `${JSON.stringify(spec, null, 2)}\n`, 'utf-8');
  console.log(
    `OpenAPI exportado para ${destino} (${Object.keys((spec as { paths?: object }).paths ?? {}).length} caminhos)`,
  );
  await app.close();
}

exportar().catch((erro) => {
  console.error('Falha ao exportar OpenAPI:', erro);
  process.exit(1);
});
