import { ageReceivables, type Credit, type Receivable } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import {
  ageingRows,
  partyOf,
  receivablesSummary,
  storeOf,
  type AgeingLookups,
  type PartyInfo,
} from './ageing-rows.js';

const AS_OF = '2026-10-11';

const bill = (id: string, partyId: string, storeId: string | null, dueOn: string, total: number) =>
  ({
    id,
    kind: 'invoice',
    partyId,
    storeId,
    number: id,
    raisedOn: '2026-09-01',
    dueOn,
    totalPaise: total,
    cancelledOn: null,
    allocations: [],
  }) satisfies Receivable;

const advance = (id: string, partyId: string, storeId: string | null, amount: number) =>
  ({
    id,
    kind: 'payment',
    partyId,
    storeId,
    number: id,
    receivedOn: '2026-09-01',
    amountPaise: amount,
    voidedOn: null,
    allocations: [],
  }) satisfies Credit;

const party = (
  name: string,
  salespersonId: string | null,
  limitPaise: number | null,
): PartyInfo => ({
  name,
  phone: null,
  salespersonId,
  salespersonName: salespersonId === null ? null : `Person ${salespersonId}`,
  limitPaise,
});

const result = ageReceivables({
  asOf: AS_OF,
  receivables: [
    bill('a', 'p1', 's1', '2026-10-20', 1_000),
    bill('b', 'p2', 's2', '2026-09-01', 2_000),
    bill('c', 'p3', null, '2026-10-11', 500),
  ],
  credits: [advance('x', 'p4', 'gone', 300)],
});

const lookups: AgeingLookups = {
  parties: new Map([
    ['p1', party('Zed', 'm1', 5_000)],
    ['p2', party('Amar', 'm1', null)],
    ['p3', party('Amar', null, null)],
    ['p4', party('Bina', null, null)],
    ['p5', party('Credit only', null, 1_000)],
  ]),
  stores: new Map([
    ['s1', { name: 'Ameerpet', code: 'AMP' }],
    ['s2', { name: 'Kukatpally', code: 'KKP' }],
  ]),
};

describe('ageingRows', () => {
  it('groups by customer, largest balance first, ties by name', () => {
    const rows = ageingRows(result, 'customer', lookups);
    expect(rows.map((row) => [row.id, row.name, row.totals.netPaise, row.maxDaysPastDue])).toEqual([
      ['p2', 'Amar', 2_000, 40],
      ['p1', 'Zed', 1_000, null],
      ['p3', 'Amar', 500, 0],
      ['p4', 'Bina', -300, null],
    ]);
    expect(rows[1]).toMatchObject({ limitPaise: 5_000, customers: 1, code: null });
  });

  it('groups by salesperson, nobody last when they owe least', () => {
    const rows = ageingRows(result, 'salesperson', lookups);
    expect(rows.map((row) => [row.id, row.name, row.customers, row.totals.netPaise])).toEqual([
      ['m1', 'Person m1', 2, 3_000],
      [null, null, 2, 200],
    ]);
  });

  it('groups by store, naming a store it cannot find by nothing', () => {
    const rows = ageingRows(result, 'store', lookups);
    expect(rows.map((row) => [row.id, row.code, row.name])).toEqual([
      ['s2', 'KKP', 'Kukatpally'],
      ['s1', 'AMP', 'Ameerpet'],
      [null, null, null],
      ['gone', null, null],
    ]);
  });

  it('orders equal balances by name, rows without one first, then by id', () => {
    const even = ageReceivables({
      asOf: AS_OF,
      receivables: [
        bill('a', 'p2', 's1', AS_OF, 100),
        bill('b', 'p3', null, AS_OF, 100),
        bill('c', 'p1', 's2', AS_OF, 100),
      ],
      credits: [],
    });
    expect(ageingRows(even, 'store', lookups).map((row) => row.id)).toEqual([null, 's1', 's2']);
    expect(ageingRows(even, 'customer', lookups).map((row) => row.id)).toEqual(['p2', 'p3', 'p1']);
  });

  it('finds stores and parties of the result', () => {
    expect(storeOf(lookups, null)).toBeNull();
    expect(storeOf(lookups, 'gone')).toBeNull();
    expect(storeOf(lookups, 's1')).toEqual({ name: 'Ameerpet', code: 'AMP' });
    expect(partyOf(lookups, 'p4').name).toBe('Bina');
  });

  it('refuses a party missing from the lookups (a programming error)', () => {
    expect(() => ageingRows(result, 'customer', { ...lookups, parties: new Map() })).toThrow(
      'missing from the lookups',
    );
  });
});

describe('receivablesSummary', () => {
  it('counts who owes, the credit in use, and the top customers with what is overdue', () => {
    const summary = receivablesSummary(result, lookups);
    expect(summary).toMatchObject({
      asOf: AS_OF,
      dueTodayPaise: 500,
      dueThisWeekPaise: 500,
      overduePaise: 2_000,
      customers: 3,
      credit: { limitPaise: 6_000, usedPaise: 1_000, utilisationBps: 1_667, overLimit: 0 },
    });
    expect(summary.topCustomers.map((c) => [c.partyId, c.overduePaise])).toEqual([
      ['p2', 2_000],
      ['p1', 0],
      ['p3', 0],
    ]);
  });
});
