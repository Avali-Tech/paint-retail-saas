import { crc32 } from 'node:zlib';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

/**
 * The EICAR test file: harmless, but every virus scanner reports it. Built at
 * run time so this source file is not itself flagged.
 */
export const EICAR = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
);

/** A tiny but real PDF. */
export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/** The 8-byte PNG signature followed by some data. */
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR test image'),
]);

/** Creates a bucket in the test object store and returns S3 settings for the app. */
export async function testBucket(endpoint: string, scannerAddress: string, name: string) {
  const s3 = new S3Client({
    endpoint,
    region: 'ap-south-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await s3.send(new CreateBucketCommand({ Bucket: name }));
  s3.destroy();
  const [host = '', port = ''] = scannerAddress.split(':');
  return {
    STORAGE_BUCKET: name,
    STORAGE_ENDPOINT: endpoint,
    STORAGE_ACCESS_KEY_ID: 'test',
    STORAGE_SECRET_ACCESS_KEY: 'test',
    CLAMAV_HOST: host,
    CLAMAV_PORT: port,
  };
}

/** A multipart/form-data body, as a browser sends a form with a file. */
export function multipartBody(
  fields: Record<string, string>,
  files: { name?: string; fileName: string; data: Buffer; contentType?: string }[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----paint${String(Date.now())}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name ?? 'file'}"; filename="${file.fileName}"\r\nContent-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** A ZIP archive (stored, uncompressed) holding the given files — e.g. a .docx. */
export function zipArchive(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
