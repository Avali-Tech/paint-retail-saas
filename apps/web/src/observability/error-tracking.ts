import { PRIVATE_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from '@paint/observability';
import type { BrowserOptions } from '@sentry/browser';

/** Build-time settings (Vite `import.meta.env`). */
export type BuildEnv = Readonly<Record<string, unknown>>;

export interface WebErrorTrackingSettings {
  readonly dsn: string;
  readonly environment: string;
  readonly release: string | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** Off (null) unless VITE_SENTRY_DSN was set when the app was built. */
export function webErrorTrackingSettings(env: BuildEnv): WebErrorTrackingSettings | null {
  const dsn = text(env.VITE_SENTRY_DSN);
  if (dsn === undefined) return null;
  return {
    dsn,
    environment: text(env.VITE_SENTRY_ENVIRONMENT) ?? text(env.MODE) ?? 'production',
    release: text(env.VITE_SENTRY_RELEASE),
  };
}

/** The part of @sentry/browser used here. */
export type BrowserSdk = Pick<
  typeof import('@sentry/browser'),
  | 'init'
  | 'globalHandlersIntegration'
  | 'browserApiErrorsIntegration'
  | 'linkedErrorsIntegration'
  | 'dedupeIntegration'
>;

export interface StartOptions {
  /** Loads the SDK; it is a separate chunk, downloaded only when tracking is on. */
  readonly load?: () => Promise<BrowserSdk>;
  readonly transport?: BrowserOptions['transport'];
}

/** The SDK options: errors only, no tracing, replay or automatic breadcrumbs; everything scrubbed. */
export function browserOptions(
  settings: WebErrorTrackingSettings,
  sdk: BrowserSdk,
  transport?: BrowserOptions['transport'],
): BrowserOptions {
  return {
    dsn: settings.dsn,
    environment: settings.environment,
    ...(settings.release === undefined ? {} : { release: settings.release }),
    dataCollection: { ...PRIVATE_DATA_COLLECTION, httpBodies: [] },
    defaultIntegrations: false,
    integrations: [
      sdk.globalHandlersIntegration(),
      sdk.browserApiErrorsIntegration(),
      sdk.linkedErrorsIntegration(),
      sdk.dedupeIntegration(),
    ],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    ...(transport === undefined ? {} : { transport }),
  };
}

/**
 * Reports uncaught errors and unhandled rejections in the browser to Sentry.
 * Resolves to whether tracking started. Never throws: the app must start either way.
 */
export async function startErrorTracking(
  env: BuildEnv,
  { load = () => import('@sentry/browser'), transport }: StartOptions = {},
): Promise<boolean> {
  const settings = webErrorTrackingSettings(env);
  if (settings === null) return false;
  try {
    const sdk = await load();
    sdk.init(browserOptions(settings, sdk, transport));
    return true;
  } catch {
    return false;
  }
}
