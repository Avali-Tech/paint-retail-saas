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
const razorpay = {
  PAYMENT_GATEWAY: 'razorpay',
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
      subscriptions: {
        gateway: { name: 'fake' },
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
        PAYMENT_GATEWAY: 'razorpay',
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
    [{ ...required, NODE_ENV: 'production' }, /PAYMENT_GATEWAY: must be "razorpay" in production/],
    [
      { ...required, NODE_ENV: 'production' },
      /PLATFORM_GSTIN: PLATFORM_LEGAL_NAME, PLATFORM_GSTIN/,
    ],
    [{ ...required, PAYMENT_GATEWAY: 'stripe' }, /PAYMENT_GATEWAY/],
    [
      { ...required, PAYMENT_GATEWAY: 'razorpay' },
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
