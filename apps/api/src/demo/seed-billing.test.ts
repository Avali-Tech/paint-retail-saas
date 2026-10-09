import type { ReconciliationRunView } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { assertReconciled } from './seed-billing.js';

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
