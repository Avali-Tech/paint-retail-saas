import { describe, expect, it } from 'vitest';
import { s3ClientOptions } from './object-storage.js';

const base = {
  bucket: 'docs',
  region: 'ap-south-1',
  endpoint: null,
  credentials: null,
  clamav: { host: 'clamav', port: 3310 },
};

describe('s3ClientOptions', () => {
  it('uses Amazon S3 and the server role by default', () => {
    expect(s3ClientOptions(base)).toEqual({ region: 'ap-south-1' });
  });

  it('uses path-style requests and keys for an S3-compatible endpoint', () => {
    const credentials = { accessKeyId: 'id', secretAccessKey: 'secret' };

    expect(s3ClientOptions({ ...base, endpoint: 'http://localhost:8333', credentials })).toEqual({
      region: 'ap-south-1',
      endpoint: 'http://localhost:8333',
      forcePathStyle: true,
      credentials,
    });
  });
});
