import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Envelope encryption of each business's gateway credentials at rest ([PO-40]; spec
 * §6.2 PL-14). Every sealing makes a fresh 256-bit data key, encrypts the credentials
 * with it (AES-256-GCM), and wraps the data key with the master key
 * (GATEWAY_CREDENTIALS_KEY, AES-256-GCM). Both are bound to the business (associated
 * data), so a sealed value copied to another business does not open. The database
 * holds only `v1:<master key id>:<wrapped data key>:<sealed credentials>`; the master
 * key lives in AWS Secrets Manager. A rotated-out key can still open what it sealed
 * (GATEWAY_CREDENTIALS_PREVIOUS_KEY) until the credentials are saved again.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Thrown when sealed credentials cannot be opened; says nothing about why or what. */
export class VaultError extends Error {
  override readonly name = 'VaultError';
  constructor() {
    super('Gateway credentials could not be opened');
  }
}

/** A short, stable name for a master key (an HMAC of it: it reveals nothing of the key). */
export function masterKeyId(key: Buffer): string {
  return createHmac('sha256', key)
    .update('paint:gateway-credentials:key-id')
    .digest('hex')
    .slice(0, 12);
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');

function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

export class CredentialVault {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly currentId: string;

  constructor(
    private readonly current: Buffer,
    previous: Buffer | null = null,
  ) {
    this.currentId = masterKeyId(current);
    this.keys = new Map([
      ...(previous === null ? [] : [[masterKeyId(previous), previous] as const]),
      [this.currentId, current] as const,
    ]);
  }

  /** Seals a business's credentials with a fresh data key, wrapped by the current key. */
  seal(organizationId: string, credentials: Readonly<Record<string, string>>): string {
    const dataKey = randomBytes(32);
    const wrapped = encrypt(this.current, dataKey, `${VERSION}:key:${organizationId}`);
    const body = encrypt(
      dataKey,
      Buffer.from(JSON.stringify(credentials), 'utf8'),
      `${VERSION}:data:${organizationId}`,
    );
    return [VERSION, this.currentId, b64(wrapped), b64(body)].join(':');
  }

  /** Opens what `seal` made for the same business; VaultError otherwise. */
  open(organizationId: string, sealed: string): Record<string, string> {
    const [version, keyId, wrapped, body, extra] = sealed.split(':');
    const key = this.keys.get(String(keyId));
    if (version !== VERSION || key === undefined || extra !== undefined) throw new VaultError();
    try {
      const dataKey = decrypt(
        key,
        Buffer.from(String(wrapped), 'base64url'),
        `${VERSION}:key:${organizationId}`,
      );
      const plaintext = decrypt(
        dataKey,
        Buffer.from(String(body), 'base64url'),
        `${VERSION}:data:${organizationId}`,
      );
      return JSON.parse(plaintext.toString('utf8')) as Record<string, string>;
    } catch {
      throw new VaultError();
    }
  }

  /** Whether a sealed value was sealed with the current key (else it awaits re-sealing). */
  isCurrent(sealed: string): boolean {
    return sealed.split(':')[1] === this.currentId;
  }
}
