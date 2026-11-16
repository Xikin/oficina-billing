import { z } from 'zod';
import 'dotenv/config';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),

    MONGODB_URI: z.string().min(1),
    MONGODB_DB: z.string().default('oficina_billing'),

    JWT_SECRET: z.string().min(32),
    JWT_CLIENTE_SECRET: z.string().min(32),

    MERCADO_PAGO_MODO: z.enum(['simulado', 'real']).default('simulado'),
    MERCADO_PAGO_ACCESS_TOKEN: z.string().optional(),
    MERCADO_PAGO_WEBHOOK_SECRET: z.string().optional(),
    MERCADO_PAGO_API_URL: z.string().url().default('https://api.mercadopago.com'),
    BILLING_URL_PUBLICA: z.string().url().default('http://localhost:3000'),

    ALLOWED_ORIGINS: z.string().default(''),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SWAGGER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    NEW_RELIC_LICENSE_KEY: z.string().optional(),
    NEW_RELIC_APP_NAME: z.string().default('oficina-billing'),

    RABBITMQ_URL: z.string().url().optional(),
    RABBITMQ_EXCHANGE: z.string().default('oficina.saga'),
    MENSAGERIA_MAX_TENTATIVAS: z.coerce.number().int().positive().default(5),
    MENSAGERIA_ATRASO_RETENTATIVA_MS: z.coerce.number().int().positive().default(5000),
    OUTBOX_INTERVALO_MS: z.coerce.number().int().positive().default(1000),
  })
  .refine((e) => e.MERCADO_PAGO_MODO === 'simulado' || Boolean(e.MERCADO_PAGO_ACCESS_TOKEN), {
    message: 'MERCADO_PAGO_ACCESS_TOKEN é obrigatório com MERCADO_PAGO_MODO=real',
    path: ['MERCADO_PAGO_ACCESS_TOKEN'],
  })
  .refine((e) => e.JWT_SECRET !== e.JWT_CLIENTE_SECRET, {
    message: 'JWT_CLIENTE_SECRET deve ser diferente de JWT_SECRET',
    path: ['JWT_CLIENTE_SECRET'],
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Variáveis de ambiente inválidas:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
