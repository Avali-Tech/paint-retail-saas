// Browser entry point. All logic lives in app/start.tsx, which is tested directly;
// the built app is exercised by the Playwright end-to-end tests.
import '@paint/ui/styles.css';
import './styles/app.css';
import { start } from './app/start.js';
import { startErrorTracking } from './observability/error-tracking.js';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');
// Off unless VITE_SENTRY_DSN was set at build time.
void startErrorTracking(import.meta.env);
start({ container, env: import.meta.env });
