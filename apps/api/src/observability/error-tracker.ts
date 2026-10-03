import { PRIVATE_DATA_COLLECTION, scrubEvent } from '@paint/observability';
import {
  Scope,
  createStackParser,
  createTransport,
  dedupeIntegration,
  linkedErrorsIntegration,
  type BaseTransportOptions,
  type Transport,
} from '@sentry/core';
import { ServerRuntimeClient, nodeStackLineParser } from '@sentry/core/server';
import type { ErrorTrackingSettings } from './settings.js';

/** What is reported about the request an error happened in: never its body or headers. */
export interface RequestDetails {
  readonly requestId: string;
  readonly method: string;
  /** The route pattern (/parties/:id), not the URL, so ids and query strings stay out. */
  readonly route: string | undefined;
  readonly status: number;
}

export interface ErrorTracker {
  readonly enabled: boolean;
  readonly capture: (error: unknown, request?: RequestDetails) => void;
  /** Waits up to `timeoutMs` for queued reports to be sent; false if some were not. */
  readonly flush: (timeoutMs: number) => Promise<boolean>;
}

/** Used when SENTRY_DSN is not set: reports nothing. */
export const DISABLED_ERROR_TRACKER: ErrorTracker = {
  enabled: false,
  capture: () => undefined,
  flush: () => Promise.resolve(true),
};

/** Sends error reports with the runtime's fetch (no extra HTTP client in the bundle). */
export function fetchTransport(fetchImpl: typeof fetch = fetch) {
  return (options: BaseTransportOptions): Transport =>
    createTransport(options, async ({ body }) => {
      const response = await fetchImpl(options.url, { method: 'POST', body });
      return {
        statusCode: response.status,
        headers: {
          'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
          'retry-after': response.headers.get('retry-after'),
        },
      };
    });
}

export interface ErrorTrackerOptions {
  readonly transport?: (options: BaseTransportOptions) => Transport;
}

/**
 * A Sentry client with only error reporting: no tracing, no automatic request or
 * console capture, no default PII. Every event and breadcrumb is scrubbed first.
 */
export function createErrorTracker(
  settings: ErrorTrackingSettings,
  { transport = fetchTransport() }: ErrorTrackerOptions = {},
): ErrorTracker {
  const client = new ServerRuntimeClient({
    dsn: settings.dsn,
    environment: settings.environment,
    ...(settings.release === null ? {} : { release: settings.release }),
    platform: 'node',
    runtime: { name: 'node', version: process.version },
    dataCollection: { ...PRIVATE_DATA_COLLECTION, httpBodies: [] },
    integrations: [dedupeIntegration(), linkedErrorsIntegration()],
    stackParser: createStackParser(nodeStackLineParser()),
    transport,
    // Breadcrumbs travel inside events, so scrubEvent covers them too.
    beforeSend: (event) => scrubEvent(event),
  });
  client.init();
  return {
    enabled: true,
    capture(error, request) {
      const scope = new Scope();
      if (request) {
        scope.setTags({
          request_id: request.requestId,
          'http.method': request.method,
          'http.route': request.route ?? 'unmatched',
          'http.status_code': request.status,
        });
      }
      client.captureException(error, undefined, scope);
    },
    flush: async (timeoutMs) => client.flush(timeoutMs),
  };
}
