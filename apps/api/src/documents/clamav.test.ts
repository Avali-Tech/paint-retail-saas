import { describe, expect, it } from 'vitest';
import { parseClamdReply, ScannerUnavailableError } from './clamav.js';

describe('parseClamdReply', () => {
  it('reads a clean result', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ clean: true });
  });

  it('names the virus that was found', () => {
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      clean: false,
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it.each([
    [
      'INSTREAM size limit exceeded. ERROR\0',
      'ClamAV could not scan the file: INSTREAM size limit exceeded. ERROR',
    ],
    ['', 'ClamAV could not scan the file: no reply'],
    ['stream:  FOUND', 'ClamAV could not scan the file: stream:  FOUND'],
  ])('treats anything else as a failed scan: %j', (reply, message) => {
    expect(() => parseClamdReply(reply)).toThrow(new ScannerUnavailableError(message));
  });
});
