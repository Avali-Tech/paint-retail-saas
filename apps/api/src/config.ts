import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
  RUN_MIGRATIONS: booleanString.default(false),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  /** Apply pending database migrations before the server starts. */
  readonly runMigrations: boolean;
}

/** Thrown when environment variables are missing or invalid. Never includes their values. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Reads and validates the API's settings from environment variables. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid environment variables:\n  ${problems.join('\n  ')}`);
  }
  const { data } = result;
  return {
    nodeEnv: data.NODE_ENV,
    host: data.HOST,
    port: data.PORT,
    databaseUrl: data.DATABASE_URL,
    logLevel: data.LOG_LEVEL,
    runMigrations: data.RUN_MIGRATIONS,
  };
}
