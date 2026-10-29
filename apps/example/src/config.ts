import { z } from 'zod';

/** Una lista separada por comas: `https://app.example.com,https://admin.example.com`. */
const list = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** URL pública de este servidor. */
  BASE_URL: z.string().min(1),
  /** Orígenes de tu front end (los que pueden llamar con cookie). */
  TRUSTED_ORIGINS: list.default([]),
  /** Al menos 32 caracteres aleatorios: `openssl rand -base64 48`. */
  BETTER_AUTH_SECRET: z.string().min(1),
  /** Archivo SQLite (o `:memory:`). */
  DATABASE_FILE: z.string().min(1).default('axeda-example.sqlite'),
  /** Proxies de confianza delante de la API (IP o CIDR), separados por comas. */
  TRUSTED_PROXIES: list.default([]),
});

export interface ExampleConfig {
  readonly environment: 'production' | 'development';
  readonly port: number;
  readonly baseURL: string;
  readonly trustedOrigins: readonly string[];
  readonly secret: string;
  readonly databaseFile: string;
  readonly trustedProxies: readonly string[];
}

/**
 * Lee el entorno y falla al arrancar si falta algo: nada de valores por omisión para el secreto
 * ni para las URL. (La validación de fondo —secreto largo, `https` en producción— la hace
 * `secureAuthOptions`.)
 */
export function readConfig(env: Record<string, string | undefined>): ExampleConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration — ${problems.join('; ')}`);
  }
  const value = parsed.data;
  return {
    environment: value.NODE_ENV === 'production' ? 'production' : 'development',
    port: value.PORT,
    baseURL: value.BASE_URL,
    // Si no se dice, el único front end de confianza es el propio servidor.
    trustedOrigins: value.TRUSTED_ORIGINS.length > 0 ? value.TRUSTED_ORIGINS : [value.BASE_URL],
    secret: value.BETTER_AUTH_SECRET,
    databaseFile: value.DATABASE_FILE,
    trustedProxies: value.TRUSTED_PROXIES,
  };
}
