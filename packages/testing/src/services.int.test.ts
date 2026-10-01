import { Socket } from 'node:net';
import { describe, expect, inject, it } from 'vitest';
import { startTestObjectStorage, startTestVirusScanner } from './index.js';

/** Sends one clamd command and returns its reply. */
function clamd(address: string, command: string): Promise<string> {
  const [host = '', port = ''] = address.split(':');
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let reply = '';
    socket.on('data', (chunk) => (reply += chunk.toString()));
    socket.on('end', () => {
      resolve(reply.replace(/\0$/, ''));
    });
    socket.on('error', reject);
    socket.connect(Number(port), host, () => socket.write(`z${command}\0`));
  });
}

describe('object storage', () => {
  it('is provided to every integration test, and answers the S3 API', async () => {
    const response = await fetch(inject('objectStorageEndpoint'));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('ListAllMyBucketsResult');
  });

  it('starts a fresh store and stops it', async () => {
    const storage = await startTestObjectStorage();
    expect((await fetch(storage.endpoint)).status).toBe(200);

    await storage.stop();

    await expect(fetch(storage.endpoint)).rejects.toThrow();
  });
});

describe('virus scanner', () => {
  it('is provided to every integration test, and answers clamd commands', async () => {
    expect(await clamd(inject('virusScannerAddress'), 'PING')).toBe('PONG');
    expect(await clamd(inject('virusScannerAddress'), 'VERSION')).toMatch(/^ClamAV 1\.5\.4\//);
  });

  it('starts a fresh scanner and stops it', async () => {
    const scanner = await startTestVirusScanner();
    const address = `${scanner.host}:${String(scanner.port)}`;
    expect(await clamd(address, 'PING')).toBe('PONG');

    await scanner.stop();

    await expect(clamd(address, 'PING')).rejects.toThrow();
    // Loading signatures takes 10–60 s depending on how busy the machine is.
  }, 180_000);
});
