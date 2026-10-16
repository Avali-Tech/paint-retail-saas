import { describe, expect, it } from 'vitest';
import { CredentialVault, VaultError, masterKeyId } from './credential-vault.js';

const KEY = Buffer.alloc(32, 1);
const OLD = Buffer.alloc(32, 2);
const ORG = '7a1d3e2c-0000-4000-8000-000000000001';
const OTHER = '7a1d3e2c-0000-4000-8000-000000000002';
const SECRETS = {
  keyId: 'rzp_live_ILgsfZCZoFIKMb',
  keySecret: 'thisIsTheKeySecret123456',
  webhookSecret: 'whsec-of-the-shop',
};

describe('CredentialVault', () => {
  it('seals credentials so the stored text holds none of them, and opens them again', () => {
    const vault = new CredentialVault(KEY);
    const sealed = vault.seal(ORG, SECRETS);
    expect(sealed).toMatch(/^v1:[0-9a-f]{12}:[\w-]+:[\w-]+$/);
    for (const value of Object.values(SECRETS)) expect(sealed).not.toContain(value);
    expect(vault.open(ORG, sealed)).toEqual(SECRETS);
    expect(vault.isCurrent(sealed)).toBe(true);
  });

  it('uses a fresh data key and nonce each time', () => {
    const vault = new CredentialVault(KEY);
    expect(vault.seal(ORG, SECRETS)).not.toBe(vault.seal(ORG, SECRETS));
  });

  it('refuses what another business sealed, a changed byte, another key and other formats', () => {
    const vault = new CredentialVault(KEY);
    const sealed = vault.seal(ORG, SECRETS);
    expect(() => vault.open(OTHER, sealed)).toThrow(VaultError);
    const parts = sealed.split(':');
    const body = Buffer.from(String(parts[3]), 'base64url');
    body[body.length - 1] = Number(body.at(-1)) ^ 1;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join(':');
    expect(() => vault.open(ORG, tampered)).toThrow(VaultError);
    expect(() => new CredentialVault(OLD).open(ORG, sealed)).toThrow(VaultError);
    expect(() => vault.open(ORG, `v2${sealed.slice(2)}`)).toThrow(VaultError);
    expect(() => vault.open(ORG, `${sealed}:more`)).toThrow(VaultError);
    expect(() => vault.open(ORG, 'plain text')).toThrow('Gateway credentials could not be opened');
  });

  it('opens what the previous key sealed after a rotation, and says it awaits re-sealing', () => {
    const sealed = new CredentialVault(OLD).seal(ORG, SECRETS);
    const rotated = new CredentialVault(KEY, OLD);
    expect(rotated.open(ORG, sealed)).toEqual(SECRETS);
    expect(rotated.isCurrent(sealed)).toBe(false);
    expect(rotated.isCurrent(rotated.seal(ORG, SECRETS))).toBe(true);
  });

  it('names a key without revealing it', () => {
    expect(masterKeyId(KEY)).toMatch(/^[0-9a-f]{12}$/);
    expect(masterKeyId(KEY)).not.toBe(masterKeyId(OLD));
    expect(KEY.toString('hex')).not.toContain(masterKeyId(KEY));
  });
});
