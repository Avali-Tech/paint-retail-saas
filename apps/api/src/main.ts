// Process entry point for the built server. All logic lives in bootstrap.ts,
// which is tested directly; the built output is exercised by dist.int.test.ts.
import { bootstrap } from './bootstrap.js';
import { startErrorTracking } from './observability/index.js';

// Off unless SENTRY_DSN is set; must run before the app is created.
startErrorTracking(process.env);
await bootstrap(process.env);
