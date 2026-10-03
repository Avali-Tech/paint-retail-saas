import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { activeErrorTracker, DISABLED_ERROR_TRACKER, startErrorTracking } from './index.js';

class FakeProcess extends EventEmitter {
  exit(): void {
    // Not reached in these tests.
  }
}

describe('startErrorTracking', () => {
  it('is off without SENTRY_DSN', () => {
    const source = new FakeProcess();

    expect(startErrorTracking({ NODE_ENV: 'production' }, source)).toBe(DISABLED_ERROR_TRACKER);
    expect(activeErrorTracker()).toBe(DISABLED_ERROR_TRACKER);
    expect(source.listenerCount('uncaughtException')).toBe(0);
  });

  it('starts a tracker and reports process crashes when SENTRY_DSN is set', () => {
    const source = new FakeProcess();

    const tracker = startErrorTracking(
      { SENTRY_DSN: 'https://publickey@o1.ingest.sentry.io/42' },
      source,
    );

    expect(tracker.enabled).toBe(true);
    expect(activeErrorTracker()).toBe(tracker);
    expect(source.listenerCount('uncaughtException')).toBe(1);
    expect(source.listenerCount('unhandledRejection')).toBe(1);
  });
});
