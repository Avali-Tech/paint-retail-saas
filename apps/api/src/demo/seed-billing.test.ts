import type { ReconciliationRunView } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { DemoApiError } from './api-client.js';
import { approverFor, assertReconciled, creditFollowUp } from './seed-billing.js';

describe('creditFollowUp', () => {
  const refused = (statusCode: number, body: object) =>
    new DemoApiError('POST', '/invoices/1/issue', statusCode, JSON.stringify(body));

  it('asks for approval at the level the check names, and pays when credit is blocked', () => {
    expect(
      creditFollowUp(
        refused(409, { code: 'credit_approval_required', credit: { approval: 'owner' } }),
      ),
    ).toEqual({ approve: 'owner' });
    expect(
      creditFollowUp(
        refused(409, { code: 'credit_approval_stale', credit: { approval: 'manager' } }),
      ),
    ).toEqual({ approve: 'manager' });
    expect(creditFollowUp(refused(409, { code: 'credit_blocked' }))).toBe('pay');
  });

  it('throws anything else again', () => {
    const other = refused(409, { message: 'Not enough stock of APX-1L at this store' });
    expect(() => creditFollowUp(other)).toThrow(other);
    const invalid = refused(400, { code: 'credit_blocked' });
    expect(() => creditFollowUp(invalid)).toThrow(invalid);
    expect(() => creditFollowUp(new Error('network'))).toThrow('network');
  });
});

describe('approverFor', () => {
  it('sends owner-level sales to the owner and the rest to the branch manager', () => {
    expect(approverFor('owner', 'managerAmp')).toBe('owner');
    expect(approverFor('manager', 'managerAmp')).toBe('managerAmp');
  });
});

const run = (findings: unknown[]) => ({ findings }) as unknown as ReconciliationRunView;

describe('assertReconciled', () => {
  it('passes books in balance and stops on anything else', () => {
    expect(() => {
      assertReconciled({ run: run([]) });
    }).not.toThrow();
    expect(() => {
      assertReconciled({ run: null });
    }).toThrow('Demo seed: no reconciliation');
    expect(() => {
      assertReconciled({ run: run([{ kind: 'party_balance' }]) });
    }).toThrow('Demo seed: the books do not reconcile: [{"kind":"party_balance"}]');
  });
});
