import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DISABLED_ERROR_TRACKER, type ErrorTracker } from './error-tracker.js';
import { CRASH_FLUSH_MS, reportProcessCrashes } from './process-crashes.js';

class FakeProcess extends EventEmitter {
  exit: (code: number) => void = () => undefined;
  readonly exited = new Promise<number>((resolve) => {
    this.exit = resolve;
  });
}

function fakeTracker(flush: () => Promise<boolean>) {
  return { enabled: true, capture: vi.fn<ErrorTracker['capture']>(), flush: vi.fn(flush) };
}

describe('reportProcessCrashes', () => {
  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'reports %s, waits for the report, then exits with code 1',
    async (event) => {
      const source = new FakeProcess();
      const tracker = fakeTracker(() => Promise.resolve(true));
      const log = vi.fn();
      reportProcessCrashes(tracker, source, log);
      const error = new Error('boom');

      source.emit(event, error);

      await expect(source.exited).resolves.toBe(1);
      expect(log).toHaveBeenCalledWith('Fatal error, exiting:', error);
      expect(tracker.capture).toHaveBeenCalledWith(error);
      expect(tracker.flush).toHaveBeenCalledWith(CRASH_FLUSH_MS);
    },
  );

  it('still exits when sending the report fails', async () => {
    const source = new FakeProcess();
    reportProcessCrashes(
      fakeTracker(() => Promise.reject(new Error('offline'))),
      source,
      () => undefined,
    );

    source.emit('uncaughtException', new Error('boom'));

    await expect(source.exited).resolves.toBe(1);
  });

  it('leaves the process alone when error tracking is off', () => {
    const source = new FakeProcess();
    reportProcessCrashes(DISABLED_ERROR_TRACKER, source);
    expect(source.listenerCount('uncaughtException')).toBe(0);
    expect(source.listenerCount('unhandledRejection')).toBe(0);
  });

  it('defaults to the real process and console', () => {
    const before = process.listenerCount('unhandledRejection');
    reportProcessCrashes(DISABLED_ERROR_TRACKER);
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});
