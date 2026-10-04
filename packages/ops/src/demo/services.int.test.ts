import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBucket, lineSplitter, portInUse, waitForUrl } from './services.ts';

let server: Server;
let base: string;
let calls = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    calls += 1;
    if (request.url === '/flaky') response.statusCode = calls % 2 === 0 ? 200 : 503;
    if (request.url === '/existing') response.statusCode = 409;
    if (request.url === '/broken') response.statusCode = 500;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('local services', () => {
  it('tells a busy port from a free one', async () => {
    expect(await portInUse((server.address() as AddressInfo).port)).toBe(true);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, resolve));
    const free = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    expect(await portInUse(free)).toBe(false);
  });

  it('waits for a URL to answer, and gives up when told to', async () => {
    await waitForUrl(`${base}/flaky`, { intervalMs: 10 });
    await expect(waitForUrl(`${base}/broken`, { timeoutMs: 50, intervalMs: 10 })).rejects.toThrow(
      'did not answer within 0 s',
    );
    await expect(
      waitForUrl('http://127.0.0.1:1/', { timeoutMs: 20, intervalMs: 5 }),
    ).rejects.toThrow();
    await expect(waitForUrl(`${base}/ok`, { stillRunning: () => false })).rejects.toThrow(
      'stopped before',
    );
  });

  it('creates a bucket, accepting one that exists', async () => {
    await createBucket(base, 'new');
    await createBucket(base, 'existing');
    await expect(createBucket(base, 'broken', { attempts: 2, intervalMs: 5 })).rejects.toThrow(
      'answered 500',
    );
    await expect(createBucket('http://127.0.0.1:1', 'x', { attempts: 1 })).rejects.toThrow(
      'Could not create',
    );
  });

  it('splits output into lines', () => {
    const lines: string[] = [];
    const push = lineSplitter((line) => lines.push(line));
    push('one\ntw');
    push('o\nthree');
    push('\n');
    expect(lines).toEqual(['one', 'two', 'three']);
  });
});
