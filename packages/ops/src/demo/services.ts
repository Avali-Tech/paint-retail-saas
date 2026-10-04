import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/** True when something accepts connections on the port, over IPv4 or IPv6 loopback. */
export async function portInUse(port: number): Promise<boolean> {
  const answers = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        resolve(false);
      });
    });
  const [ipv4, ipv6] = await Promise.all([answers('127.0.0.1'), answers('::1')]);
  return ipv4 || ipv6;
}

/**
 * Waits until `url` answers 2xx. Gives up after `timeoutMs`, or as soon as
 * `stillRunning` says the process behind it has exited.
 */
export async function waitForUrl(
  url: string,
  {
    timeoutMs = 120_000,
    intervalMs = 250,
    stillRunning = (): boolean => true,
  }: { timeoutMs?: number; intervalMs?: number; stillRunning?: () => boolean } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!stillRunning()) throw new Error(`stopped before ${url} answered`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(`${url} did not answer within ${String(Math.round(timeoutMs / 1000))} s`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Creates the documents bucket in the local S3 store (SeaweedFS accepts
 * unsigned requests). Retries while the store starts; an existing bucket is fine.
 */
export async function createBucket(
  storageUrl: string,
  bucket: string,
  { attempts = 60, intervalMs = 500 } = {},
): Promise<void> {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${storageUrl}/${bucket}`, { method: 'PUT' });
      if (response.ok || response.status === 409) return;
      last = `answered ${String(response.status)}`;
    } catch (error) {
      last = String(error);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`Could not create the ${bucket} bucket at ${storageUrl}: ${last}`);
}

/** Splits a stream of text chunks into whole lines. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = '';
  return (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = String(lines.pop());
    for (const line of lines) onLine(line);
  };
}
