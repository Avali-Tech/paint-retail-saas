import { createTransport, type BaseTransportOptions, type Event } from '@sentry/core';
import { describe, expect, it, vi } from 'vitest';
import { createErrorTracker, DISABLED_ERROR_TRACKER, fetchTransport } from './error-tracker.js';

const settings = {
  dsn: 'https://publickey@o1.ingest.sentry.io/42',
  environment: 'test',
  release: 'abc123',
};

/** A transport that keeps the events it would have sent. */
function capturingTransport() {
  const events: Event[] = [];
  const transport = (options: BaseTransportOptions) =>
    createTransport(options, ({ body }) => {
      // Envelope: header line, item header line, item payload line.
      const [, itemHeader, payload] = String(body).split('\n');
      if ((JSON.parse(String(itemHeader)) as { type: string }).type === 'event') {
        events.push(JSON.parse(String(payload)) as Event);
      }
      return Promise.resolve({ statusCode: 200 });
    });
  return { events, transport };
}

describe('DISABLED_ERROR_TRACKER', () => {
  it('reports nothing and flushes immediately', async () => {
    expect(DISABLED_ERROR_TRACKER.enabled).toBe(false);
    expect(() => {
      DISABLED_ERROR_TRACKER.capture(new Error('x'));
    }).not.toThrow();
    await expect(DISABLED_ERROR_TRACKER.flush(10)).resolves.toBe(true);
  });
});

describe('createErrorTracker', () => {
  it('sends a scrubbed event tagged with the request id, route and status', async () => {
    const { events, transport } = capturingTransport();
    const tracker = createErrorTracker(settings, { transport });

    tracker.capture(new Error('sign-in for 9876543210 with code 482913 failed'), {
      requestId: 'req-0000-0001',
      method: 'POST',
      route: '/auth/otp/verify',
      status: 500,
    });
    await expect(tracker.flush(1_000)).resolves.toBe(true);

    expect(tracker.enabled).toBe(true);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.exception?.values?.[0]?.value).toBe(
      'sign-in for [phone] with code [code] failed',
    );
    expect(event?.tags).toEqual({
      request_id: 'req-0000-0001',
      'http.method': 'POST',
      'http.route': '/auth/otp/verify',
      'http.status_code': 500,
    });
    expect(event?.environment).toBe('test');
    expect(event?.release).toBe('abc123');
    expect(event?.request).toBeUndefined();
    expect(event?.user).toBeUndefined();
  });

  it('reports errors outside a request, and unmatched routes, without a release', async () => {
    const { events, transport } = capturingTransport();
    const tracker = createErrorTracker({ ...settings, release: null }, { transport });

    tracker.capture(new Error('worker failed'));
    tracker.capture(new Error('no route'), {
      requestId: 'r-12345678',
      method: 'GET',
      route: undefined,
      status: 500,
    });
    await tracker.flush(1_000);

    expect(events.map((event) => event.tags?.['http.route'])).toEqual([undefined, 'unmatched']);
    expect(events[0]?.release).toBeUndefined();
  });

  it('uses the fetch transport by default', () => {
    expect(createErrorTracker(settings).enabled).toBe(true);
  });
});

describe('fetchTransport', () => {
  it('posts the envelope to the DSN endpoint and passes rate limits back', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { 'X-Sentry-Rate-Limits': '60:error', 'Retry-After': '60' },
        }),
      ),
    );
    const tracker = createErrorTracker(settings, { transport: fetchTransport(fetchImpl) });

    tracker.capture(new Error('x'));
    await tracker.flush(1_000);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/o1\.ingest\.sentry\.io\/api\/42\/envelope\//),
      expect.objectContaining({ method: 'POST', body: expect.any(String) }),
    );
  });
});
