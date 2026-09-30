import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://app:secret@db.internal:5432/paint';
const AUTH_SECRET = 'test-secret-that-is-at-least-32-characters';
const required = { DATABASE_URL, AUTH_SECRET };

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
