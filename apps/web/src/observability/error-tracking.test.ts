import * as Sentry from '@sentry/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserOptions,
  startErrorTracking,
  webErrorTrackingSettings,
  type BrowserSdk,
} from './error-tracking.js';

const DSN = 'https://publickey@o1.ingest.sentry.io/42';

describe('webErrorTrackingSettings', () => {
  it('is off without VITE_SENTRY_DSN', () => {
    expect(webErrorTrackingSettings({})).toBeNull();
    expect(webErrorTrackingSettings({ VITE_SENTRY_DSN: '  ' })).toBeNull();
    expect(webErrorTrackingSettings({ VITE_SENTRY_DSN: 42 })).toBeNull();
  });

  it('reads the environment and release, defaulting to the Vite mode', () => {
    expect(
      webErrorTrackingSettings({
        VITE_SENTRY_DSN: DSN,
        VITE_SENTRY_ENVIRONMENT: 'staging',
        VITE_SENTRY_RELEASE: 'abc123',
      }),
    ).toEqual({ dsn: DSN, environment: 'staging', release: 'abc123' });
    expect(webErrorTrackingSettings({ VITE_SENTRY_DSN: DSN, MODE: 'development' })).toEqual({
      dsn: DSN,
      environment: 'development',
      release: undefined,
    });
    expect(webErrorTrackingSettings({ VITE_SENTRY_DSN: DSN })?.environment).toBe('production');
  });
});

function fakeSdk() {
  return {
    init: vi.fn<BrowserSdk['init']>(),
    globalHandlersIntegration: vi.fn(() => ({ name: 'GlobalHandlers' })),
    browserApiErrorsIntegration: vi.fn(() => ({ name: 'BrowserApiErrors' })),
    linkedErrorsIntegration: vi.fn(() => ({ name: 'LinkedErrors' })),
    dedupeIntegration: vi.fn(() => ({ name: 'Dedupe' })),
  };
}

describe('startErrorTracking', () => {
  it('does not load the SDK when off', async () => {
    const load = vi.fn(() => Promise.resolve(fakeSdk() as unknown as BrowserSdk));

    await expect(startErrorTracking({}, { load })).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('starts with errors-only options when on', async () => {
    const sdk = fakeSdk();

    await expect(
      startErrorTracking(
        { VITE_SENTRY_DSN: DSN },
        { load: () => Promise.resolve(sdk as unknown as BrowserSdk) },
      ),
    ).resolves.toBe(true);

    const options = sdk.init.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      dsn: DSN,
      dataCollection: { userInfo: false, httpBodies: [] },
      defaultIntegrations: false,
      integrations: [
        { name: 'GlobalHandlers' },
        { name: 'BrowserApiErrors' },
        { name: 'LinkedErrors' },
        { name: 'Dedupe' },
      ],
    });
    expect(options).not.toHaveProperty('release');
    expect(options).not.toHaveProperty('transport');
  });

  it('never stops the app from starting when the SDK fails to load', async () => {
    await expect(
      startErrorTracking(
        { VITE_SENTRY_DSN: DSN },
        { load: () => Promise.reject(new Error('chunk failed')) },
      ),
    ).resolves.toBe(false);
  });
});

describe('with the real SDK', () => {
  afterEach(async () => {
    await Sentry.close();
  });

  it('sends scrubbed errors and breadcrumbs', async () => {
    const payloads: string[] = [];
    const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
      Sentry.createTransport(options, ({ body }) => {
        payloads.push(String(body));
        return Promise.resolve({ statusCode: 200 });
      });

    await startErrorTracking(
      { VITE_SENTRY_DSN: DSN, VITE_SENTRY_RELEASE: 'abc123' },
      { transport },
    );
    Sentry.addBreadcrumb({ category: 'ui', message: 'typed 9876543210' });
    Sentry.captureException(new Error('wrong code 482913 for asha@example.com'));
    await Sentry.flush(1_000);

    const sent = payloads.join('\n');
    expect(sent).toContain('wrong code [code] for [email]');
    expect(sent).toContain('typed [phone]');
    expect(sent).toContain('abc123');
    expect(sent).not.toMatch(/482913|9876543210|asha@example\.com/);
  });

  it('builds options with the default loader', async () => {
    expect(await startErrorTracking({ VITE_SENTRY_DSN: DSN })).toBe(true);
    expect(
      browserOptions({ dsn: DSN, environment: 'x', release: undefined }, Sentry),
    ).toMatchObject({ dsn: DSN });
  });
});
