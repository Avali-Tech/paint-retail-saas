/**
 * The client's address for rate limiting. Behind the load balancer every request
 * comes from it, so the last X-Forwarded-For hop (the one the load balancer added)
 * is the client; without the header, the socket's address.
 */
export function clientAddress(ip: string, forwardedFor: string | string[] | undefined): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');
  return hops.at(-1) ?? ip;
}

/**
 * A fixed-window request limiter kept in memory, per key (e.g. a client address):
 * at most `limit` requests per `windowMs`. Each API server counts on its own, so
 * with N servers a client gets up to N × limit; enough to stop scraping of public
 * links, and the load balancer's WAF rule is the hard limit in production.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a request for `key`; false when it is over the limit for this window. */
  take(key: string): boolean {
    const now = this.now();
    const window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      this.sweep(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  /** Forgets windows that have ended, so the map never grows without bound. */
  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
