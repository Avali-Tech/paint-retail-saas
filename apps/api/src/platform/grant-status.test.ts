import { describe, expect, it } from 'vitest';
import { grantStatus } from './grant-status.js';

const now = new Date('2026-10-01T10:00:00Z');
const base = { approvedAt: null, declinedAt: null, expiresAt: null, endedAt: null };
const approved = { ...base, approvedAt: new Date('2026-10-01T09:00:00Z') };

describe('grantStatus', () => {
  it.each([
    [base, 'pending'],
    [{ ...base, declinedAt: now }, 'declined'],
    [{ ...base, endedAt: now }, 'ended'],
    [{ ...approved, expiresAt: new Date('2026-10-01T11:00:00Z') }, 'active'],
    [{ ...approved, expiresAt: new Date('2026-10-01T10:00:00Z') }, 'expired'],
    [{ ...approved, expiresAt: new Date('2026-10-01T11:00:00Z'), endedAt: now }, 'ended'],
  ] as const)('%o is %s', (grant, status) => {
    expect(grantStatus(grant, now)).toBe(status);
  });

  it('uses the current time by default', () => {
    expect(grantStatus({ ...approved, expiresAt: new Date(Date.now() + 60_000) })).toBe('active');
  });
});
