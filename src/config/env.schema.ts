import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  NATS_HOST: z.string().min(1),
  NATS_PORT: z.coerce.number().int().positive().default(4222),
  NATS_ENV_PREFIX: z.enum(['dev', 'beta', 'prod']),

  DATABASE_URL: z.string().url(),

  // Comma-separated list of valid API keys for X-API-Key header.
  TRENDS_API_KEYS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof envSchema>;
