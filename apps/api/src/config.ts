import { PLAN_KEYS, type PlanKey } from '@paint/shared';
import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const SMS_PROVIDERS = ['disabled', 'log'] as const;
export const EMAIL_PROVIDERS = ['disabled', 'smtp'] as const;
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
    /** S3 bucket for documents; unset turns document uploads off (not allowed in production). */
    STORAGE_BUCKET: z.string().min(3).optional(),
    STORAGE_REGION: z.string().min(1).default('ap-south-1'),
    /** For S3-compatible stores in development and tests; unset = Amazon S3. */
    STORAGE_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** ClamAV daemon that scans every upload; required with STORAGE_BUCKET. */
    CLAMAV_HOST: z.string().min(1).optional(),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
    /** The web app's address, for links in emails. */
    APP_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:5173'),
    /** "smtp" sends notification emails (Amazon SES's SMTP endpoint in production). */
    EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('disabled'),
    /** smtp://user:password@host:port (smtps:// for TLS from the start). */
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    EMAIL_FROM: z.string().min(3).optional(),
    /** How often the background worker sends email and checks stock; 0 turns it off. */
    WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    /** One-time secret that creates the first platform operator; unset afterwards. */
    PLATFORM_BOOTSTRAP_TOKEN: z.string().min(32, 'must be at least 32 characters').optional(),
    /** The plan a business starts on when it signs itself up. */
    SIGNUP_PLAN: z.enum(PLAN_KEYS).default('trial'),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'log'), {
    path: ['SMS_PROVIDER'],
    message: '"log" prints sign-in codes to the console and is not allowed in production',
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.STORAGE_BUCKET !== undefined, {
    path: ['STORAGE_BUCKET'],
    message: 'is required in production',
  })
  .refine((env) => env.STORAGE_BUCKET === undefined || env.CLAMAV_HOST !== undefined, {
    path: ['CLAMAV_HOST'],
    message: 'is required to scan uploads when STORAGE_BUCKET is set',
  })
  .refine(
    (env) =>
      env.EMAIL_PROVIDER === 'disabled' ||
      (env.SMTP_URL !== undefined && env.EMAIL_FROM !== undefined),
    { path: ['SMTP_URL'], message: 'SMTP_URL and EMAIL_FROM are required to send email' },
  )
  .refine(
    (env) =>
      (env.STORAGE_ACCESS_KEY_ID === undefined) === (env.STORAGE_SECRET_ACCESS_KEY === undefined),
    { path: ['STORAGE_SECRET_ACCESS_KEY'], message: 'set both storage keys, or neither' },
  );

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
  /** Where documents are stored and scanned; null when uploads are off. */
  readonly documents: DocumentsConfig | null;
  /** The web app's address, for links in emails. */
  readonly appUrl: string;
  /** How notification emails are sent; null when email is off. */
  readonly email: { readonly smtpUrl: string; readonly from: string } | null;
  /** Seconds between background worker runs; 0 = off. */
  readonly workerIntervalSeconds: number;
  /** Lets the first platform operator be created through the API; null = off. */
  readonly platformBootstrapToken: string | null;
  /** The plan a business starts on when it signs itself up. */
  readonly signupPlan: PlanKey;
}

export interface DocumentsConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string | null;
  /** Null = the AWS default credential chain (the server's IAM role). */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
  readonly clamav: { readonly host: string; readonly port: number };
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
    documents:
      data.STORAGE_BUCKET === undefined
        ? null
        : {
            bucket: data.STORAGE_BUCKET,
            region: data.STORAGE_REGION,
            endpoint: data.STORAGE_ENDPOINT ?? null,
            credentials:
              data.STORAGE_ACCESS_KEY_ID === undefined
                ? null
                : {
                    accessKeyId: data.STORAGE_ACCESS_KEY_ID,
                    secretAccessKey: String(data.STORAGE_SECRET_ACCESS_KEY),
                  },
            // Required with STORAGE_BUCKET (checked above).
            clamav: { host: String(data.CLAMAV_HOST), port: data.CLAMAV_PORT },
          },
    appUrl: data.APP_URL.replace(/\/$/, ''),
    // Both are required with EMAIL_PROVIDER=smtp (checked above).
    email:
      data.EMAIL_PROVIDER === 'smtp'
        ? { smtpUrl: String(data.SMTP_URL), from: String(data.EMAIL_FROM) }
        : null,
    workerIntervalSeconds: data.WORKER_INTERVAL_SECONDS,
    platformBootstrapToken: data.PLATFORM_BOOTSTRAP_TOKEN ?? null,
    signupPlan: data.SIGNUP_PLAN,
  };
}
