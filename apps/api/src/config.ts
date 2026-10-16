import {
  BILLING_INTERVALS,
  DEFAULT_PAYMENT_LINK_DAYS,
  isValidGstin,
  isValidIfsc,
  isValidPincode,
  PAID_PLAN_KEYS,
  PLAN_KEYS,
  SUBSCRIPTION_GATEWAYS,
  type BillingInterval,
  type PaidPlanKey,
  type PaymentInstructions,
  type PlanKey,
} from '@paint/shared';
import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const SMS_PROVIDERS = ['disabled', 'log'] as const;
export const EMAIL_PROVIDERS = ['disabled', 'smtp'] as const;
/** WhatsApp to parties (P2-M32): a BSP adapter joins `log` when [PO-1] is answered. */
export const MESSAGING_PROVIDERS = ['disabled', 'log'] as const;
/** UPI payment links (P2-M32): a gateway adapter joins `log` when [PO-2] is answered. */
export const PAYMENT_LINK_PROVIDERS = ['disabled', 'log'] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];
export type MessagingProvider = (typeof MESSAGING_PROVIDERS)[number];
export type PaymentLinkProviderName = (typeof PAYMENT_LINK_PROVIDERS)[number];

/** Every paid plan and interval the gateway must know, e.g. "standard_monthly". */
export const PLAN_ID_KEYS = PAID_PLAN_KEYS.flatMap((plan) =>
  BILLING_INTERVALS.map((interval) => `${plan}_${interval}` as const),
);
export type PlanIdKey = `${PaidPlanKey}_${BillingInterval}`;

/** RAZORPAY_PLAN_IDS read, or null when it is not JSON with a plan id for every key. */
function planIdsFrom(text: string): Record<PlanIdKey, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = z
    .object(Object.fromEntries(PLAN_ID_KEYS.map((key) => [key, z.string().regex(/^plan_\w+$/)])))
    .safeParse(parsed);
  return result.success ? (result.data as Record<PlanIdKey, string>) : null;
}

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
    /** How WhatsApp messages to parties are sent; "log" prints them (not in production). */
    MESSAGING_PROVIDER: z.enum(MESSAGING_PROVIDERS).default('disabled'),
    /**
     * How UPI payment links are made: "log" makes pretend links paid on a page of the web
     * app through a signed webhook (development, tests and demos; not in production).
     */
    PAYMENT_LINK_PROVIDER: z.enum(PAYMENT_LINK_PROVIDERS).default('disabled'),
    /** Days a payment link stays payable. */
    PAYMENT_LINK_EXPIRY_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(30)
      .default(DEFAULT_PAYMENT_LINK_DAYS),
    /** The API's public address, for links sent to customers; default APP_URL + /api. */
    PUBLIC_API_URL: z.url({ protocol: /^https?$/ }).optional(),
    /**
     * How subscriptions are collected: "manual" (our invoices, paid by bank transfer or
     * UPI and recorded by an operator), "razorpay", or "fake" (tests; not in production).
     */
    SUBSCRIPTION_GATEWAY: z.enum(SUBSCRIPTION_GATEWAYS).default('manual'),
    RAZORPAY_KEY_ID: z.string().min(8).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(8).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(8).optional(),
    /** {"standard_monthly": "plan_…", …}: the Razorpay plan of every paid plan and interval. */
    RAZORPAY_PLAN_IDS: z.string().optional(),
    RAZORPAY_API_URL: z.url({ protocol: /^https?$/ }).default('https://api.razorpay.com/v1'),
    /** Days of free trial a new business gets. */
    SUBSCRIPTION_TRIAL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    /** Days a business keeps working after a renewal fails, before it is read-only. */
    SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(7),
    /** The platform's own GST details, printed on its invoices to businesses. */
    PLATFORM_LEGAL_NAME: z.string().trim().min(3).max(120).optional(),
    PLATFORM_GSTIN: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isValidGstin, 'is not a valid GSTIN')
      .optional(),
    /** Street address; lines separated by "|". */
    PLATFORM_ADDRESS: z.string().trim().min(3).max(300).optional(),
    PLATFORM_CITY: z.string().trim().min(2).max(60).optional(),
    PLATFORM_PINCODE: z.string().trim().refine(isValidPincode, 'is not a PIN code').optional(),
    PLATFORM_EMAIL: z.email().optional(),
    /** Prefix of the platform's invoice numbers (PRS/26-27/000001). */
    PLATFORM_INVOICE_PREFIX: z
      .string()
      .regex(/^[A-Z0-9]{1,4}$/, 'must be 1–4 capital letters or digits')
      .default('PRS'),
    /** SAC of the service invoiced; see docs/mvp-3/subscriptions.md. */
    PLATFORM_SAC: z
      .string()
      .regex(/^99\d{4}$/, 'must be a 6-digit SAC')
      .default('998315'),
    /** The platform's bank account and UPI id, for paying manual invoices. */
    PLATFORM_BANK_NAME: z.string().trim().min(3).max(100).optional(),
    PLATFORM_BANK_ACCOUNT_NAME: z.string().trim().min(3).max(120).optional(),
    PLATFORM_BANK_ACCOUNT_NUMBER: z
      .string()
      .trim()
      .regex(/^\d{9,18}$/, 'must be 9–18 digits')
      .optional(),
    PLATFORM_BANK_IFSC: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isValidIfsc, 'is not an IFSC like SBIN0020345')
      .optional(),
    PLATFORM_UPI_ID: z
      .string()
      .trim()
      .regex(/^[\w.-]{2,256}@[a-zA-Z][\w.-]{1,63}$/, 'is not a UPI id like name@bank')
      .optional(),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'log'), {
    path: ['SMS_PROVIDER'],
    message: '"log" prints sign-in codes to the console and is not allowed in production',
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.MESSAGING_PROVIDER === 'log'), {
    path: ['MESSAGING_PROVIDER'],
    message: '"log" prints customer messages to the console and is not allowed in production',
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.PAYMENT_LINK_PROVIDER === 'log'), {
    path: ['PAYMENT_LINK_PROVIDER'],
    message: '"log" makes payment links that take no money and is not allowed in production',
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
  )
  .refine((env) => env.NODE_ENV !== 'production' || env.SUBSCRIPTION_GATEWAY !== 'fake', {
    path: ['SUBSCRIPTION_GATEWAY'],
    message: 'must be "manual" or "razorpay" in production: the fake gateway takes no money',
  })
  .refine(
    (env) =>
      env.SUBSCRIPTION_GATEWAY !== 'razorpay' ||
      (env.RAZORPAY_KEY_ID !== undefined &&
        env.RAZORPAY_KEY_SECRET !== undefined &&
        env.RAZORPAY_WEBHOOK_SECRET !== undefined &&
        env.RAZORPAY_PLAN_IDS !== undefined),
    {
      path: ['RAZORPAY_KEY_ID'],
      message:
        'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET and RAZORPAY_PLAN_IDS are required',
    },
  )
  .refine((env) => env.RAZORPAY_PLAN_IDS === undefined || planIdsFrom(env.RAZORPAY_PLAN_IDS), {
    path: ['RAZORPAY_PLAN_IDS'],
    message: `must be JSON naming a plan id for each of ${PLAN_ID_KEYS.join(', ')}`,
  })
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      (env.PLATFORM_LEGAL_NAME !== undefined &&
        env.PLATFORM_GSTIN !== undefined &&
        env.PLATFORM_ADDRESS !== undefined &&
        env.PLATFORM_CITY !== undefined &&
        env.PLATFORM_PINCODE !== undefined),
    {
      path: ['PLATFORM_GSTIN'],
      message:
        'PLATFORM_LEGAL_NAME, PLATFORM_GSTIN, PLATFORM_ADDRESS, PLATFORM_CITY and PLATFORM_PINCODE are required in production',
    },
  )
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.SUBSCRIPTION_GATEWAY !== 'manual' ||
      (env.PLATFORM_BANK_NAME !== undefined &&
        env.PLATFORM_BANK_ACCOUNT_NAME !== undefined &&
        env.PLATFORM_BANK_ACCOUNT_NUMBER !== undefined &&
        env.PLATFORM_BANK_IFSC !== undefined),
    {
      path: ['PLATFORM_BANK_ACCOUNT_NUMBER'],
      message:
        'PLATFORM_BANK_NAME, PLATFORM_BANK_ACCOUNT_NAME, PLATFORM_BANK_ACCOUNT_NUMBER and PLATFORM_BANK_IFSC are required in production with manual invoicing',
    },
  );

/**
 * Placeholders for the platform's own GST and bank details, used until they are set
 * (never in production, which refuses to start without them). The GSTIN is a made-up
 * Telangana number with a valid check character.
 */
export const PLATFORM_PLACEHOLDERS = {
  legalName: 'Paint Retail SaaS Private Limited (placeholder)',
  gstin: '36AAACP0000P1ZP',
  address: 'Placeholder address, set PLATFORM_ADDRESS',
  city: 'Hyderabad',
  pincode: '500001',
  bankName: 'Placeholder Bank, set PLATFORM_BANK_NAME',
  accountName: 'Paint Retail SaaS Private Limited (placeholder)',
  accountNumber: '000000000000',
  ifsc: 'SBIN0000000',
} as const;

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
  /** How WhatsApp messages to parties are sent. */
  readonly messagingProvider: MessagingProvider;
  /** How UPI payment links are made, and how long they stay payable. */
  readonly paymentLinks: {
    readonly provider: PaymentLinkProviderName;
    readonly expiryDays: number;
  };
  /** The API's public address (no trailing slash), for links sent to customers. */
  readonly publicApiUrl: string;
  readonly subscriptions: SubscriptionsConfig;
}

export type GatewayConfig =
  | { readonly name: 'manual' }
  | { readonly name: 'fake' }
  | {
      readonly name: 'razorpay';
      readonly keyId: string;
      readonly keySecret: string;
      readonly webhookSecret: string;
      readonly planIds: Readonly<Record<PlanIdKey, string>>;
      readonly apiUrl: string;
    };

/** The platform as the supplier on its own GST invoices. */
export interface PlatformSupplierConfig {
  readonly legalName: string;
  readonly gstin: string;
  readonly addressLines: readonly string[];
  readonly city: string;
  readonly pincode: string;
  readonly email: string | null;
  readonly invoicePrefix: string;
  readonly sacCode: string;
}

export interface SubscriptionsConfig {
  readonly gateway: GatewayConfig;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly platform: PlatformSupplierConfig;
  /** Where businesses send money for manual invoices. */
  readonly bank: PaymentInstructions;
  /** The web app's address, for the fake gateway's checkout page. */
  readonly appUrl: string;
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
  const appUrl = data.APP_URL.replace(/\/$/, '');
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
    appUrl,
    // Both are required with EMAIL_PROVIDER=smtp (checked above).
    email:
      data.EMAIL_PROVIDER === 'smtp'
        ? { smtpUrl: String(data.SMTP_URL), from: String(data.EMAIL_FROM) }
        : null,
    workerIntervalSeconds: data.WORKER_INTERVAL_SECONDS,
    platformBootstrapToken: data.PLATFORM_BOOTSTRAP_TOKEN ?? null,
    signupPlan: data.SIGNUP_PLAN,
    messagingProvider: data.MESSAGING_PROVIDER,
    paymentLinks: {
      provider: data.PAYMENT_LINK_PROVIDER,
      expiryDays: data.PAYMENT_LINK_EXPIRY_DAYS,
    },
    publicApiUrl: (data.PUBLIC_API_URL ?? `${appUrl}/api`).replace(/\/$/, ''),
    subscriptions: {
      // Every Razorpay setting is required with SUBSCRIPTION_GATEWAY=razorpay (checked above).
      gateway:
        data.SUBSCRIPTION_GATEWAY === 'razorpay'
          ? {
              name: 'razorpay',
              keyId: String(data.RAZORPAY_KEY_ID),
              keySecret: String(data.RAZORPAY_KEY_SECRET),
              webhookSecret: String(data.RAZORPAY_WEBHOOK_SECRET),
              // Checked above: JSON with a plan id for every paid plan and interval.
              planIds: JSON.parse(String(data.RAZORPAY_PLAN_IDS)) as Record<PlanIdKey, string>,
              apiUrl: data.RAZORPAY_API_URL.replace(/\/$/, ''),
            }
          : { name: data.SUBSCRIPTION_GATEWAY },
      trialDays: data.SUBSCRIPTION_TRIAL_DAYS,
      graceDays: data.SUBSCRIPTION_GRACE_DAYS,
      platform: {
        legalName: data.PLATFORM_LEGAL_NAME ?? PLATFORM_PLACEHOLDERS.legalName,
        gstin: data.PLATFORM_GSTIN ?? PLATFORM_PLACEHOLDERS.gstin,
        addressLines: (data.PLATFORM_ADDRESS ?? PLATFORM_PLACEHOLDERS.address)
          .split('|')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        city: data.PLATFORM_CITY ?? PLATFORM_PLACEHOLDERS.city,
        pincode: data.PLATFORM_PINCODE ?? PLATFORM_PLACEHOLDERS.pincode,
        email: data.PLATFORM_EMAIL ?? null,
        invoicePrefix: data.PLATFORM_INVOICE_PREFIX,
        sacCode: data.PLATFORM_SAC,
      },
      bank: {
        bankName: data.PLATFORM_BANK_NAME ?? PLATFORM_PLACEHOLDERS.bankName,
        accountName: data.PLATFORM_BANK_ACCOUNT_NAME ?? PLATFORM_PLACEHOLDERS.accountName,
        accountNumber: data.PLATFORM_BANK_ACCOUNT_NUMBER ?? PLATFORM_PLACEHOLDERS.accountNumber,
        ifsc: data.PLATFORM_BANK_IFSC ?? PLATFORM_PLACEHOLDERS.ifsc,
        upiId: data.PLATFORM_UPI_ID ?? null,
      },
      appUrl: data.APP_URL.replace(/\/$/, ''),
    },
  };
}
