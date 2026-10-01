import { createServer, type Server } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EICAR, PDF, testBucket } from '../test-support/files.js';
import { ClamavScanner, ScannerUnavailableError } from './clamav.js';
import { ObjectStorage } from './object-storage.js';

const [host = '', port = ''] = inject('virusScannerAddress').split(':');

/** A TCP server for scanner failure cases: it either never answers or hangs up at once. */
async function fakeServer(
  behaviour: 'silent' | 'hang-up',
): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    if (behaviour === 'hang-up') socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, server };
}

describe('ClamavScanner', () => {
  const scanner = new ClamavScanner(host, Number(port));

  it('passes a clean file', async () => {
    expect(await scanner.scan(PDF)).toEqual({ clean: true });
  });

  it('streams large files in chunks', async () => {
    expect(await scanner.scan(Buffer.alloc(3 * 1024 * 1024, 'a'))).toEqual({ clean: true });
  });

  it('names the virus in an infected file', async () => {
    const result = await scanner.scan(EICAR);

    expect(result.clean).toBe(false);
    expect(result).toMatchObject({ signature: expect.stringMatching(/EICAR/i) });
  });

  it('reports ClamAV as unavailable when it cannot be reached', async () => {
    const closed = await fakeServer('silent');
    await new Promise((resolve) => closed.server.close(resolve));

    await expect(new ClamavScanner('127.0.0.1', closed.port).scan(PDF)).rejects.toThrow(
      ScannerUnavailableError,
    );
  });

  it('gives up when ClamAV does not answer in time, or hangs up without a reply', async () => {
    const silent = await fakeServer('silent');
    const hangUp = await fakeServer('hang-up');
    try {
      await expect(new ClamavScanner('127.0.0.1', silent.port, 200).scan(PDF)).rejects.toThrow(
        'ClamAV is unavailable: no reply in time',
      );
      await expect(new ClamavScanner('127.0.0.1', hangUp.port).scan(PDF)).rejects.toThrow(
        'ClamAV could not scan the file: no reply',
      );
    } finally {
      silent.server.close();
      hangUp.server.close();
    }
  });
});

describe('ObjectStorage', () => {
  let storage: ObjectStorage;
  let s3: S3Client;

  beforeAll(async () => {
    const env = await testBucket(
      inject('objectStorageEndpoint'),
      inject('virusScannerAddress'),
      'storage-test',
    );
    s3 = new S3Client({
      endpoint: env.STORAGE_ENDPOINT,
      region: 'ap-south-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    storage = new ObjectStorage(s3, env.STORAGE_BUCKET);
  });

  afterAll(() => {
    s3.destroy();
  });

  it('stores and returns the exact bytes', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);

    await storage.put('org/a/documents/1', bytes, 'application/octet-stream');

    expect(await storage.get('org/a/documents/1')).toEqual(bytes);
  });

  it('builds a client from settings', () => {
    expect(
      ObjectStorage.fromConfig({
        bucket: 'docs',
        region: 'ap-south-1',
        endpoint: null,
        credentials: null,
        clamav: { host: 'clamav', port: 3310 },
      }),
    ).toBeInstanceOf(ObjectStorage);
  });
});
