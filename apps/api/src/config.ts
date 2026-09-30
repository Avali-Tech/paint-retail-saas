import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const SMS_PROVIDERS = ['disabled', 'log'] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
    RUN_MIGRATIONS: booleanString.default(false),
    AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    SMS_PROVIDER: z.enum(SMS_PROVIDERS).default('disabled'),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'log'), {
    path: ['SMS_PROVIDER'],
    message: '"log" prints sign-in codes to the console and is not allowed in production',
  });

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  /** Apply pending database migrations before the server starts. */
  readonly runMigrations: boolean;
  /** Server secret used to hash one-time sign-in codes. */
  readonly authSecret: string;
  readonly sessionTtlDays: number;
  /** How one-time sign-in codes are delivered. */
  readonly smsProvider: SmsProvider;
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
    authSecret: data.AUTH_SECRET,
    sessionTtlDays: data.SESSION_TTL_DAYS,
    smsProvider: data.SMS_PROVIDER,
  };
}
