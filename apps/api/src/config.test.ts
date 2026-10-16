import { describe, expect, it } from 'vitest';
import { gstinCheckCharacter } from '@paint/shared';
import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://app:secret@db.internal:5432/paint';
const AUTH_SECRET = 'test-secret-that-is-at-least-32-characters';
const required = { DATABASE_URL, AUTH_SECRET };
const PLAN_IDS = {
  starter_monthly: 'plan_SM',
  starter_annual: 'plan_SA',
  standard_monthly: 'plan_GM',
  standard_annual: 'plan_GA',
  enterprise_monthly: 'plan_EM',
  enterprise_annual: 'plan_EA',
};
const PLATFORM_GSTIN = `29AABCA1234B1Z${gstinCheckCharacter('29AABCA1234B1Z')}`;
const platform = {
  PLATFORM_LEGAL_NAME: 'Avali Tech Private Limited',
  PLATFORM_GSTIN,
  PLATFORM_ADDRESS: '4th Floor, 12 MG Road',
  PLATFORM_CITY: 'Bengaluru',
  PLATFORM_PINCODE: '560001',
};
const bank = {
  PLATFORM_BANK_NAME: 'HDFC Bank, MG Road',
  PLATFORM_BANK_ACCOUNT_NAME: 'Avali Tech Private Limited',
  PLATFORM_BANK_ACCOUNT_NUMBER: '50200012345678',
  PLATFORM_BANK_IFSC: 'hdfc0000123',
};
const production = {
  ...required,
  ...platform,
  NODE_ENV: 'production',
  STORAGE_BUCKET: 'docs',
  CLAMAV_HOST: 'clamav',
};
const KEY = Buffer.alloc(32, 7).toString('base64');
const OLD_KEY = Buffer.alloc(32, 9).toString('base64');
const razorpay = {
  SUBSCRIPTION_GATEWAY: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_live_key',
  RAZORPAY_KEY_SECRET: 'razorpay-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'razorpay-webhook-secret',
};

describe('loadConfig', () => {
  it('applies defaults when only the required settings are given', () => {
    expect(loadConfig(required)).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      databaseUrl: DATABASE_URL,
      logLevel: 'log',
      runMigrations: false,
      authSecret: AUTH_SECRET,
      sessionTtlDays: 30,
      smsProvider: 'disabled',
      documents: null,
      appUrl: 'http://localhost:5173',
      email: null,
      workerIntervalSeconds: 60,
      platformBootstrapToken: null,
      signupPlan: 'trial',
      messagingProvider: 'disabled',
      paymentLinks: {
        provider: 'disabled',
        credentialsKeys: null,
        razorpayApiUrl: 'https://api.razorpay.com/v1',
      },
      publicApiUrl: 'http://localhost:5173/api',
      subscriptions: {
        gateway: { name: 'manual' },
        trialDays: 14,
        graceDays: 7,
        platform: {
          legalName: 'Paint Retail SaaS Private Limited (placeholder)',
          gstin: '36AAACP0000P1ZP',
          addressLines: ['Placeholder address, set PLATFORM_ADDRESS'],
          city: 'Hyderabad',
          pincode: '500001',
          email: null,
          invoicePrefix: 'PRS',
          sacCode: '998315',
        },
        bank: {
          bankName: 'Placeholder Bank, set PLATFORM_BANK_NAME',
          accountName: 'Paint Retail SaaS Private Limited (placeholder)',
          accountNumber: '000000000000',
          ifsc: 'SBIN0000000',
          upiId: null,
        },
        appUrl: 'http://localhost:5173',
      },
    });
  });

  it('reads every setting from the environment', () => {
    expect(
      loadConfig({
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '8080',
        DATABASE_URL: 'postgresql://app@localhost/paint',
        LOG_LEVEL: 'warn',
        RUN_MIGRATIONS: 'true',
        AUTH_SECRET,
        SESSION_TTL_DAYS: '7',
        SMS_PROVIDER: 'disabled',
        STORAGE_BUCKET: 'paint-documents',
        STORAGE_REGION: 'ap-south-2',
        STORAGE_ENDPOINT: 'http://localhost:8333',
        STORAGE_ACCESS_KEY_ID: 'key-id',
        STORAGE_SECRET_ACCESS_KEY: 'key-secret',
        CLAMAV_HOST: 'clamav.internal',
        CLAMAV_PORT: '3311',
        APP_URL: 'https://app.paintsaas.in/',
        EMAIL_PROVIDER: 'smtp',
        SMTP_URL: 'smtp://user:pass@email-smtp.ap-south-1.amazonaws.com:587',
        EMAIL_FROM: 'ABC Paints <alerts@paintsaas.in>',
        WORKER_INTERVAL_SECONDS: '0',
        PLATFORM_BOOTSTRAP_TOKEN: 'bootstrap-token-of-at-least-32-characters',
        SIGNUP_PLAN: 'standard',
        MESSAGING_PROVIDER: 'disabled',
        PAYMENT_LINK_PROVIDER: 'razorpay',
        GATEWAY_CREDENTIALS_KEY: KEY,
        GATEWAY_CREDENTIALS_PREVIOUS_KEY: OLD_KEY,
        PUBLIC_API_URL: 'https://api.paintsaas.in/',
        SUBSCRIPTION_GATEWAY: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_live_key',
        RAZORPAY_KEY_SECRET: 'razorpay-key-secret',
        RAZORPAY_WEBHOOK_SECRET: 'razorpay-webhook-secret',
        RAZORPAY_PLAN_IDS: JSON.stringify(PLAN_IDS),
        RAZORPAY_API_URL: 'https://api.razorpay.example/v1/',
        SUBSCRIPTION_TRIAL_DAYS: '30',
        SUBSCRIPTION_GRACE_DAYS: '0',
        PLATFORM_LEGAL_NAME: 'Avali Tech Private Limited',
        PLATFORM_GSTIN: PLATFORM_GSTIN.toLowerCase(),
        PLATFORM_ADDRESS: '4th Floor, 12 MG Road | Ashok Nagar',
        PLATFORM_CITY: 'Bengaluru',
        PLATFORM_PINCODE: '560001',
        PLATFORM_EMAIL: 'billing@paintsaas.in',
        PLATFORM_INVOICE_PREFIX: 'PS',
        PLATFORM_SAC: '998314',
        ...bank,
        PLATFORM_UPI_ID: 'avalitech@hdfcbank',
      }),
    ).toEqual({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      databaseUrl: 'postgresql://app@localhost/paint',
      logLevel: 'warn',
      runMigrations: true,
      authSecret: AUTH_SECRET,
      sessionTtlDays: 7,
      smsProvider: 'disabled',
      documents: {
        bucket: 'paint-documents',
        region: 'ap-south-2',
        endpoint: 'http://localhost:8333',
        credentials: { accessKeyId: 'key-id', secretAccessKey: 'key-secret' },
        clamav: { host: 'clamav.internal', port: 3311 },
      },
      appUrl: 'https://app.paintsaas.in',
      email: {
        smtpUrl: 'smtp://user:pass@email-smtp.ap-south-1.amazonaws.com:587',
        from: 'ABC Paints <alerts@paintsaas.in>',
      },
      workerIntervalSeconds: 0,
      platformBootstrapToken: 'bootstrap-token-of-at-least-32-characters',
      signupPlan: 'standard',
      messagingProvider: 'disabled',
      paymentLinks: {
        provider: 'razorpay',
        credentialsKeys: {
          current: Buffer.from(KEY, 'base64'),
          previous: Buffer.from(OLD_KEY, 'base64'),
        },
        razorpayApiUrl: 'https://api.razorpay.example/v1',
      },
      publicApiUrl: 'https://api.paintsaas.in',
      subscriptions: {
        gateway: {
          name: 'razorpay',
          keyId: 'rzp_live_key',
          keySecret: 'razorpay-key-secret',
          webhookSecret: 'razorpay-webhook-secret',
          planIds: PLAN_IDS,
          apiUrl: 'https://api.razorpay.example/v1',
        },
        trialDays: 30,
        graceDays: 0,
        platform: {
          legalName: 'Avali Tech Private Limited',
          gstin: PLATFORM_GSTIN,
          addressLines: ['4th Floor, 12 MG Road', 'Ashok Nagar'],
          city: 'Bengaluru',
          pincode: '560001',
          email: 'billing@paintsaas.in',
          invoicePrefix: 'PS',
          sacCode: '998314',
        },
        bank: {
          bankName: 'HDFC Bank, MG Road',
          accountName: 'Avali Tech Private Limited',
          accountNumber: '50200012345678',
          ifsc: 'HDFC0000123',
          upiId: 'avalitech@hdfcbank',
        },
        appUrl: 'https://app.paintsaas.in',
      },
    });
  });

  it('uses Amazon S3 in Mumbai with the server role by default once a bucket is set', () => {
    expect(
      loadConfig({ ...required, STORAGE_BUCKET: 'paint-documents', CLAMAV_HOST: 'clamav' })
        .documents,
    ).toEqual({
      bucket: 'paint-documents',
      region: 'ap-south-1',
      endpoint: null,
      credentials: null,
      clamav: { host: 'clamav', port: 3310 },
    });
  });

  it('prints WhatsApp messages with the log provider outside production', () => {
    expect(loadConfig({ ...required, MESSAGING_PROVIDER: 'log' }).messagingProvider).toBe('log');
  });

  it('makes pretend payment links with the log provider outside production', () => {
    expect(loadConfig({ ...required, PAYMENT_LINK_PROVIDER: 'log' }).paymentLinks).toEqual({
      provider: 'log',
      credentialsKeys: null,
      razorpayApiUrl: 'https://api.razorpay.com/v1',
    });
  });

  it('takes Razorpay payment links in production with the key that seals shops’ credentials', () => {
    const config = loadConfig({
      ...production,
      ...bank,
      PAYMENT_LINK_PROVIDER: 'razorpay',
      GATEWAY_CREDENTIALS_KEY: KEY,
    });
    expect(config.paymentLinks.credentialsKeys).toEqual({
      current: Buffer.from(KEY, 'base64'),
      previous: null,
    });
  });

  it('never prints the credentials key when it is wrong', () => {
    const wrong = 'c2hvcnQta2V5LW5vdC0zMi1ieXRlcw==';
    expect(() => loadConfig({ ...required, GATEWAY_CREDENTIALS_KEY: wrong })).toThrow(
      /GATEWAY_CREDENTIALS_KEY: must be 32 random bytes/,
    );
    try {
      loadConfig({ ...required, GATEWAY_CREDENTIALS_KEY: wrong });
    } catch (error) {
      expect(String(error)).not.toContain(wrong);
    }
  });

  it('invoices by hand in production with the platform bank account and no Razorpay keys', () => {
    const config = loadConfig({ ...production, ...bank });
    expect(config.subscriptions.gateway).toEqual({ name: 'manual' });
    expect(config.subscriptions.bank).toMatchObject({ accountNumber: '50200012345678' });
  });

  it('needs no bank account in production when Razorpay collects', () => {
    expect(
      loadConfig({ ...production, ...razorpay, RAZORPAY_PLAN_IDS: JSON.stringify(PLAN_IDS) })
        .subscriptions.gateway.name,
    ).toBe('razorpay');
  });

  it('accepts port 0 (pick any free port)', () => {
    expect(loadConfig({ ...required, PORT: '0' }).port).toBe(0);
  });

  it('treats RUN_MIGRATIONS=false as false', () => {
    expect(loadConfig({ ...required, RUN_MIGRATIONS: 'false' }).runMigrations).toBe(false);
  });

  it.each([
    [{ AUTH_SECRET }, /DATABASE_URL/],
    [{ AUTH_SECRET, DATABASE_URL: 'not a url' }, /DATABASE_URL/],
    [{ AUTH_SECRET, DATABASE_URL: 'mysql://localhost/paint' }, /DATABASE_URL/],
    [{ DATABASE_URL }, /AUTH_SECRET/],
    [{ DATABASE_URL, AUTH_SECRET: 'too-short' }, /AUTH_SECRET: must be at least 32/],
    [{ ...required, SESSION_TTL_DAYS: '0' }, /SESSION_TTL_DAYS/],
    [{ ...required, SMS_PROVIDER: 'msg91' }, /SMS_PROVIDER/],
    [{ ...required, NODE_ENV: 'production', SMS_PROVIDER: 'log' }, /SMS_PROVIDER: "log"/],
    [{ ...required, MESSAGING_PROVIDER: 'gupshup' }, /MESSAGING_PROVIDER/],
    [
      { ...required, NODE_ENV: 'production', MESSAGING_PROVIDER: 'log' },
      /MESSAGING_PROVIDER: "log"/,
    ],
    [{ ...required, PAYMENT_LINK_PROVIDER: 'cashfree' }, /PAYMENT_LINK_PROVIDER/],
    [
      { ...required, PAYMENT_LINK_PROVIDER: 'razorpay' },
      /GATEWAY_CREDENTIALS_KEY: is required with PAYMENT_LINK_PROVIDER=razorpay/,
    ],
    [
      { ...required, GATEWAY_CREDENTIALS_KEY: KEY, GATEWAY_CREDENTIALS_PREVIOUS_KEY: 'short' },
      /GATEWAY_CREDENTIALS_PREVIOUS_KEY: must be 32 random bytes/,
    ],
    [
      { ...required, NODE_ENV: 'production', PAYMENT_LINK_PROVIDER: 'log' },
      /PAYMENT_LINK_PROVIDER: "log"/,
    ],
    [{ ...required, PUBLIC_API_URL: 'ftp://api' }, /PUBLIC_API_URL/],
    [{ ...required, PORT: 'abc' }, /PORT/],
    [{ ...required, PORT: '70000' }, /PORT/],
    [{ ...required, PORT: '80.5' }, /PORT/],
    [{ ...required, NODE_ENV: 'staging' }, /NODE_ENV/],
    [{ ...required, LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
    [{ ...required, RUN_MIGRATIONS: 'yes' }, /RUN_MIGRATIONS/],
    [{ ...required, HOST: '' }, /HOST/],
    [{ ...required, NODE_ENV: 'production' }, /STORAGE_BUCKET: is required in production/],
    [{ ...required, STORAGE_BUCKET: 'docs' }, /CLAMAV_HOST: is required to scan uploads/],
    [
      { ...required, STORAGE_BUCKET: 'docs', CLAMAV_HOST: 'c', STORAGE_ACCESS_KEY_ID: 'k' },
      /STORAGE_SECRET_ACCESS_KEY: set both/,
    ],
    [{ ...required, STORAGE_ENDPOINT: 'ftp://files' }, /STORAGE_ENDPOINT/],
    [{ ...required, CLAMAV_PORT: '0' }, /CLAMAV_PORT/],
    [{ ...required, EMAIL_PROVIDER: 'smtp' }, /SMTP_URL: SMTP_URL and EMAIL_FROM are required/],
    [
      { ...required, EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://localhost:25' },
      /SMTP_URL: SMTP_URL and EMAIL_FROM are required/,
    ],
    [{ ...required, SMTP_URL: 'http://localhost' }, /SMTP_URL/],
    [{ ...required, EMAIL_PROVIDER: 'ses' }, /EMAIL_PROVIDER/],
    [{ ...required, WORKER_INTERVAL_SECONDS: '-1' }, /WORKER_INTERVAL_SECONDS/],
    [{ ...required, SIGNUP_PLAN: 'free' }, /SIGNUP_PLAN/],
    [
      { ...required, PLATFORM_BOOTSTRAP_TOKEN: 'short' },
      /PLATFORM_BOOTSTRAP_TOKEN: must be at least 32/,
    ],
    [
      { ...production, ...bank, SUBSCRIPTION_GATEWAY: 'fake' },
      /SUBSCRIPTION_GATEWAY: must be "manual" or "razorpay" in production/,
    ],
    [production, /PLATFORM_BANK_ACCOUNT_NUMBER: PLATFORM_BANK_NAME, PLATFORM_BANK_ACCOUNT_NAME/],
    [{ ...required, PLATFORM_BANK_ACCOUNT_NUMBER: '12AB' }, /PLATFORM_BANK_ACCOUNT_NUMBER/],
    [{ ...required, PLATFORM_BANK_IFSC: 'HDFC123' }, /PLATFORM_BANK_IFSC: is not an IFSC/],
    [{ ...required, PLATFORM_UPI_ID: 'no-at-sign' }, /PLATFORM_UPI_ID: is not a UPI id/],
    [
      { ...required, NODE_ENV: 'production' },
      /PLATFORM_GSTIN: PLATFORM_LEGAL_NAME, PLATFORM_GSTIN/,
    ],
    [{ ...required, SUBSCRIPTION_GATEWAY: 'stripe' }, /SUBSCRIPTION_GATEWAY/],
    [
      { ...required, SUBSCRIPTION_GATEWAY: 'razorpay' },
      /RAZORPAY_KEY_ID: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET/,
    ],
    [
      { ...required, ...razorpay, RAZORPAY_PLAN_IDS: 'not json' },
      /RAZORPAY_PLAN_IDS: must be JSON/,
    ],
    [
      {
        ...required,
        ...razorpay,
        RAZORPAY_PLAN_IDS: JSON.stringify({ starter_monthly: 'plan_X' }),
      },
      /RAZORPAY_PLAN_IDS: must be JSON naming a plan id for each of starter_monthly, starter_annual/,
    ],
    [{ ...required, SUBSCRIPTION_TRIAL_DAYS: '0' }, /SUBSCRIPTION_TRIAL_DAYS/],
    [{ ...required, SUBSCRIPTION_GRACE_DAYS: '31' }, /SUBSCRIPTION_GRACE_DAYS/],
    [{ ...required, PLATFORM_GSTIN: '36AAACP0000P1ZX' }, /PLATFORM_GSTIN: is not a valid GSTIN/],
    [{ ...required, PLATFORM_PINCODE: '012345' }, /PLATFORM_PINCODE: is not a PIN code/],
    [{ ...required, PLATFORM_INVOICE_PREFIX: 'TOOLONG' }, /PLATFORM_INVOICE_PREFIX/],
    [{ ...required, PLATFORM_SAC: '3208' }, /PLATFORM_SAC: must be a 6-digit SAC/],
  ])('rejects %o, naming the bad variable', (env, variable) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(variable);
  });

  it('lists every problem at once', () => {
    const load = () => loadConfig({ PORT: 'abc' });

    for (const variable of [/AUTH_SECRET/, /DATABASE_URL/, /PORT/]) {
      expect(load).toThrow(variable);
    }
  });

  it('never puts gateway secrets in the error message', () => {
    try {
      loadConfig({ ...required, ...razorpay, RAZORPAY_PLAN_IDS: '{"leak": "razorpay-key-secret"' });
    } catch (error) {
      expect((error as ConfigError).message).not.toContain('razorpay-key-secret');
      expect((error as ConfigError).message).not.toContain('razorpay-webhook-secret');
      return;
    }
    throw new Error('Expected loadConfig to throw');
  });

  it('never puts secret values in the error message', () => {
    try {
      loadConfig({
        DATABASE_URL: 'postgres://app:super-secret@db',
        AUTH_SECRET: 'short-secret',
        PORT: 'abc',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).name).toBe('ConfigError');
      expect((error as ConfigError).message).not.toContain('super-secret');
      expect((error as ConfigError).message).not.toContain('short-secret');
      return;
    }
    throw new Error('Expected loadConfig to throw');
  });
});
