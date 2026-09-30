import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://app:secret@db.internal:5432/paint';

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      databaseUrl: DATABASE_URL,
      logLevel: 'log',
      runMigrations: false,
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
      }),
    ).toEqual({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      databaseUrl: 'postgresql://app@localhost/paint',
      logLevel: 'warn',
      runMigrations: true,
    });
  });

  it('accepts port 0 (pick any free port)', () => {
    expect(loadConfig({ DATABASE_URL, PORT: '0' }).port).toBe(0);
  });

  it('treats RUN_MIGRATIONS=false as false', () => {
    expect(loadConfig({ DATABASE_URL, RUN_MIGRATIONS: 'false' }).runMigrations).toBe(false);
  });

  it.each([
    [{}, /DATABASE_URL/],
    [{ DATABASE_URL: 'not a url' }, /DATABASE_URL/],
    [{ DATABASE_URL: 'mysql://localhost/paint' }, /DATABASE_URL/],
    [{ DATABASE_URL, PORT: 'abc' }, /PORT/],
    [{ DATABASE_URL, PORT: '70000' }, /PORT/],
    [{ DATABASE_URL, PORT: '80.5' }, /PORT/],
    [{ DATABASE_URL, NODE_ENV: 'staging' }, /NODE_ENV/],
    [{ DATABASE_URL, LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
    [{ DATABASE_URL, RUN_MIGRATIONS: 'yes' }, /RUN_MIGRATIONS/],
    [{ DATABASE_URL, HOST: '' }, /HOST/],
  ])('rejects %o, naming the bad variable', (env, variable) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(variable);
  });

  it('lists every problem at once', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(
      /DATABASE_URL[\s\S]*PORT|PORT[\s\S]*DATABASE_URL/,
    );
  });

  it('never puts secret values in the error message', () => {
    try {
      loadConfig({ DATABASE_URL: 'postgres://app:super-secret@db', PORT: 'abc' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).name).toBe('ConfigError');
      expect((error as ConfigError).message).not.toContain('super-secret');
      return;
    }
    throw new Error('Expected loadConfig to throw');
  });
});
