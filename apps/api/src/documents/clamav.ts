import { createConnection } from 'node:net';

export type ScanResult =
  { readonly clean: true } | { readonly clean: false; readonly signature: string };

/** ClamAV could not be reached or could not scan; the upload must not be saved. */
export class ScannerUnavailableError extends Error {
  override readonly name = 'ScannerUnavailableError';
}

export interface VirusScanner {
  scan(data: Buffer): Promise<ScanResult>;
}

/** Reads clamd's reply to INSTREAM: "stream: OK" or "stream: <signature> FOUND". */
export function parseClamdReply(reply: string): ScanResult {
  // eslint-disable-next-line no-control-regex
  const text = reply.replace(/\u0000/g, '').trim();
  if (text === 'stream: OK') return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found?.[1]) return { clean: false, signature: found[1] };
  throw new ScannerUnavailableError(`ClamAV could not scan the file: ${text || 'no reply'}`);
}

const CHUNK_BYTES = 64 * 1024;

/** Streams files to ClamAV's daemon (clamd) over TCP with the INSTREAM command. */
export class ClamavScanner implements VirusScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const reply: Buffer[] = [];
      const socket = createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy(new Error('no reply in time'));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
          const chunk = data.subarray(offset, offset + CHUNK_BYTES);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        // A zero-length chunk ends the stream.
        socket.end(Buffer.alloc(4));
      });
      socket.on('data', (chunk: Buffer) => reply.push(chunk));
      socket.on('error', (error) => {
        reject(new ScannerUnavailableError(`ClamAV is unavailable: ${error.message}`));
      });
      socket.on('end', () => {
        // Resolving with a promise passes on parseClamdReply's error, if any.
        resolve(Promise.resolve(Buffer.concat(reply).toString('utf8')).then(parseClamdReply));
      });
    });
  }
}
