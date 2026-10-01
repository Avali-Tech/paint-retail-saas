import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { DocumentsConfig } from '../config.js';

/** S3 client settings: Amazon S3 with the server's IAM role, or an S3-compatible endpoint. */
export function s3ClientOptions(config: DocumentsConfig): S3ClientConfig {
  return {
    region: config.region,
    ...(config.endpoint === null ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
    ...(config.credentials === null ? {} : { credentials: config.credentials }),
  };
}

/** Stores document bytes in one bucket. */
export class ObjectStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  static fromConfig(config: DocumentsConfig): ObjectStorage {
    return new ObjectStorage(new S3Client(s3ClientOptions(config)), config.bucket);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const { Body } = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    // Every stored document has a body.
    const body = Body as { transformToByteArray(): Promise<Uint8Array> };
    return Buffer.from(await body.transformToByteArray());
  }
}
