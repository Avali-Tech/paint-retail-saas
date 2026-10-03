import type { ErrorTracker } from './error-tracker.js';

/** The part of `process` used here, so tests can drive it. */
export interface CrashSource {
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (reason: unknown) => void,
  ): unknown;
  exit(code: number): void;
}

/** How long a crashing process waits for its report to be sent. */
export const CRASH_FLUSH_MS = 2_000;

/**
 * Reports uncaught exceptions and unhandled rejections, then exits with code 1
 * as Node would have. Installs nothing when error tracking is off, so Node's own
 * behaviour is unchanged.
 */
export function reportProcessCrashes(
  tracker: ErrorTracker,
  source: CrashSource = process,
  log: (message: string, error: unknown) => void = console.error,
): void {
  if (!tracker.enabled) return;
  const crash = (reason: unknown) => {
    log('Fatal error, exiting:', reason);
    tracker.capture(reason);
    const exit = () => {
      source.exit(1);
    };
    tracker.flush(CRASH_FLUSH_MS).then(exit, exit);
  };
  source.on('uncaughtException', crash);
  source.on('unhandledRejection', crash);
}
