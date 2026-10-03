import { setActiveErrorTracker } from './active-tracker.js';
import { createErrorTracker, DISABLED_ERROR_TRACKER, type ErrorTracker } from './error-tracker.js';
import { reportProcessCrashes, type CrashSource } from './process-crashes.js';
import { errorTrackingSettings } from './settings.js';

export { activeErrorTracker } from './active-tracker.js';
export { DISABLED_ERROR_TRACKER, type ErrorTracker } from './error-tracker.js';
export { ObservabilityModule } from './observability.module.js';

/**
 * Error tracking from SENTRY_DSN (plus SENTRY_ENVIRONMENT, SENTRY_RELEASE). Call once
 * in main.ts before the app is created; ObservabilityModule then reports through it.
 * Unset: a tracker that does nothing and no process hooks.
 */
export function startErrorTracking(
  env: Record<string, string | undefined>,
  crashSource?: CrashSource,
): ErrorTracker {
  const settings = errorTrackingSettings(env);
  const tracker = settings === null ? DISABLED_ERROR_TRACKER : createErrorTracker(settings);
  reportProcessCrashes(tracker, crashSource);
  setActiveErrorTracker(tracker);
  return tracker;
}
