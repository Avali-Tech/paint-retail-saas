import { DISABLED_ERROR_TRACKER, type ErrorTracker } from './error-tracker.js';

// The process's error tracker, set once by startErrorTracking() in main.ts, before
// the app is created. Like Sentry's own global client, this keeps the wiring out of
// createApp and bootstrap: nothing has to pass the tracker along.
let active: ErrorTracker = DISABLED_ERROR_TRACKER;

export function activeErrorTracker(): ErrorTracker {
  return active;
}

export function setActiveErrorTracker(tracker: ErrorTracker): void {
  active = tracker;
}
