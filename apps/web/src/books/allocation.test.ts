import type { OpenDocumentView } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { billKey, checkAllocations, oldestFirst } from './allocation.js';

const bill = (overrides: Partial<OpenDocumentView>): OpenDocumentView => ({
  documentId: 'inv-1',
  partyLedgerId: null,
  kind: 'invoice',
  number: 'AMP/26-27/000001',
  issuedOn: '2026-09-01',
  dueOn: '2026-10-01',
  totalPaise: 50_000,
  allocatedPaise: 0,
  outstandingPaise: 50_000,
  ...overrides,
});
const OPENING = bill({
  documentId: null,
  partyLedgerId: 'led-1',
  kind: 'opening',
  number: null,
  outstandingPaise: 20_000,
});
const OLD = bill({});
const NEW = bill({ documentId: 'inv-2', number: 'AMP/26-27/000002', outstandingPaise: 80_000 });
const BILLS = [OPENING, OLD, NEW];

describe('allocation', () => {
  it('keys a bill by its document or its ledger entry', () => {
    expect(BILLS.map(billKey)).toEqual(['led-1', 'inv-1', 'inv-2']);
  });

  it('fills the oldest bills first until the money runs out', () => {
    expect(oldestFirst(BILLS, 1_00_000)).toEqual({
      'led-1': '200.00',
      'inv-1': '500.00',
      'inv-2': '300.00',
    });
    expect(oldestFirst(BILLS, 10_000)).toEqual({ 'led-1': '100.00', 'inv-1': '', 'inv-2': '' });
    expect(oldestFirst([], 10_000)).toEqual({});
  });

  it('turns the amounts into rows and leaves the rest as an advance', () => {
    const check = checkAllocations(BILLS, { 'led-1': '200', 'inv-1': ' ', 'inv-2': '0' }, 30_000);
    expect(check).toEqual({
      allocations: [{ partyLedgerId: 'led-1', amountPaise: 20_000 }],
      allocatedPaise: 20_000,
      advancePaise: 10_000,
      problems: {},
      ok: true,
    });
    expect(checkAllocations(BILLS, { 'inv-1': '500' }, 50_000).allocations).toEqual([
      { documentId: 'inv-1', amountPaise: 50_000 },
    ]);
  });

  it('refuses amounts that are not rupees, more than a bill owes, or more than the money', () => {
    const check = checkAllocations(BILLS, { 'led-1': 'abc', 'inv-1': '600', 'inv-2': '-1' }, 0);
    expect(check.problems).toEqual({ 'led-1': 'invalid', 'inv-1': 'tooMuch', 'inv-2': 'invalid' });
    expect(check.ok).toBe(false);
    const over = checkAllocations(BILLS, { 'inv-2': '800' }, 50_000);
    expect(over).toMatchObject({ advancePaise: -30_000, problems: {}, ok: false });
  });
});
