import { describe, expect, it } from 'vitest';
import { RateLimiter, clientAddress } from './rate-limit.js';

describe('RateLimiter', () => {
  it('allows `limit` requests per window and key, then refuses until the window ends', () => {
    let now = 1_000;
    const limiter = new RateLimiter(2, 60_000, () => now);

    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false]);
    expect(limiter.take('b')).toBe(true);
    now += 59_999;
    expect(limiter.take('a')).toBe(false);
    now += 1;
    expect(limiter.take('a')).toBe(true);
  });

  it('forgets ended windows when a new one starts', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 10, () => now);
    limiter.take('old');
    now = 5;
    limiter.take('recent');
    now = 12;
    limiter.take('new');
    const windows = (limiter as unknown as { windows: Map<string, unknown> }).windows;
    expect([...windows.keys()]).toEqual(['recent', 'new']);
  });

  it('uses the real clock by default', () => {
    expect(new RateLimiter(1, 1_000).take('x')).toBe(true);
  });
});

describe('clientAddress', () => {
  it('takes the hop the load balancer added, else the socket address', () => {
    expect(clientAddress('10.0.0.1', undefined)).toBe('10.0.0.1');
    expect(clientAddress('10.0.0.1', '')).toBe('10.0.0.1');
    expect(clientAddress('10.0.0.1', '1.1.1.1, 49.36.2.7')).toBe('49.36.2.7');
    expect(clientAddress('10.0.0.1', ['1.1.1.1', '49.36.2.8 '])).toBe('49.36.2.8');
  });
});
