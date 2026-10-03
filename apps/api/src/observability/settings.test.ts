import { describe, expect, it } from 'vitest';
import { errorTrackingSettings } from './settings.js';

const DSN = 'https://publickey@o1.ingest.sentry.io/42';

describe('errorTrackingSettings', () => {
  it('is off when SENTRY_DSN is unset or blank', () => {
    expect(errorTrackingSettings({})).toBeNull();
    expect(errorTrackingSettings({ SENTRY_DSN: '' })).toBeNull();
  });

  it('defaults the environment to NODE_ENV, then development, with no release', () => {
    expect(errorTrackingSettings({ SENTRY_DSN: DSN, NODE_ENV: 'production' })).toEqual({
      dsn: DSN,
      environment: 'production',
      release: null,
    });
    expect(errorTrackingSettings({ SENTRY_DSN: DSN })?.environment).toBe('development');
  });

  it('takes the environment and release from SENTRY_ENVIRONMENT and SENTRY_RELEASE', () => {
    expect(
      errorTrackingSettings({
        SENTRY_DSN: DSN,
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_RELEASE: 'abc123',
      }),
    ).toEqual({ dsn: DSN, environment: 'staging', release: 'abc123' });
  });

  it('rejects an invalid DSN without echoing it', () => {
    const run = () => errorTrackingSettings({ SENTRY_DSN: 'ftp://secret-key@host/1' });
    expect(run).toThrow('Invalid error tracking settings: SENTRY_DSN');
    expect(run).not.toThrow(/secret-key/);
  });
});
