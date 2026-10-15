import { describe, expect, it } from 'vitest';
import {
  AGEING_BUCKETS,
  ageReceivables,
  bucketFor,
  creditUtilisation,
  dueSummary,
  emptyTotals,
  groupAgeing,
  outstandingOn,
  sumTotals,
  unappliedOn,
  type Credit,
  type DatedAmount,
  type Receivable,
} from './ageing.js';
import { addDays } from './dates.js';

const AS_OF = '2026-10-11';

function bill(overrides: Partial<Receivable> = {}): Receivable {
  return {
    id: 'inv-1',
    kind: 'invoice',
    partyId: 'party-1',
    storeId: 'store-1',
    number: 'AMP/26-27/000001',
    raisedOn: '2026-09-01',
    dueOn: '2026-10-01',
    totalPaise: 100_000,
    cancelledOn: null,
    allocations: [],
    ...overrides,
  };
}

function credit(overrides: Partial<Credit> = {}): Credit {
  return {
    id: 'pay-1',
    kind: 'payment',
    partyId: 'party-1',
    storeId: 'store-1',
    number: 'RC-000001',
    receivedOn: '2026-09-15',
    amountPaise: 40_000,
    voidedOn: null,
    allocations: [],
    ...overrides,
  };
}

const at = (on: string, amountPaise: number): DatedAmount => ({ on, amountPaise });

describe('bucketFor', () => {
  it('puts each day past due in its bucket, counting 0–30 from the due date itself', () => {
    const cases: [number, string][] = [
      [-30, 'not_due'],
      [-1, 'not_due'],
      [0, 'days_0_30'],
      [30, 'days_0_30'],
      [31, 'days_31_60'],
      [60, 'days_31_60'],
      [61, 'days_61_90'],
      [90, 'days_61_90'],
      [91, 'days_90_plus'],
      [4000, 'days_90_plus'],
    ];
    for (const [days, bucket] of cases) expect([days, bucketFor(days)]).toEqual([days, bucket]);
    expect(AGEING_BUCKETS).toEqual([
      'not_due',
      'days_0_30',
      'days_31_60',
      'days_61_90',
      'days_90_plus',
    ]);
  });
});

describe('outstandingOn', () => {
  it('is the total less allocations that took effect by the date', () => {
    const partly = bill({ allocations: [at('2026-09-15', 30_000), at('2026-10-20', 50_000)] });
    expect(outstandingOn(partly, '2026-09-14')).toBe(100_000);
    expect(outstandingOn(partly, '2026-09-15')).toBe(70_000);
    expect(outstandingOn(partly, '2026-10-20')).toBe(20_000);
  });

  it('is nothing before the bill was raised, and nothing once it is cancelled', () => {
    const cancelled = bill({ raisedOn: '2026-10-05', cancelledOn: '2026-10-06' });
    expect(outstandingOn(cancelled, '2026-10-04')).toBe(0);
    expect(outstandingOn(cancelled, '2026-10-05')).toBe(100_000);
    expect(outstandingOn(cancelled, '2026-10-06')).toBe(0);
  });

  it('reopens a bill when a bounced cheque undoes its allocation', () => {
    const reopened = bill({ allocations: [at('2026-09-20', 100_000), at('2026-09-25', -100_000)] });
    expect(outstandingOn(reopened, '2026-09-21')).toBe(0);
    expect(outstandingOn(reopened, '2026-09-25')).toBe(100_000);
  });

  it('refuses amounts that are not whole paise', () => {
    expect(() => outstandingOn(bill({ totalPaise: 10.5 }), AS_OF)).toThrow(RangeError);
    expect(() => outstandingOn(bill({ allocations: [at(AS_OF, 0.1)] }), AS_OF)).toThrow(RangeError);
    expect(() => outstandingOn(bill({ allocations: [at('soon', 1)] }), AS_OF)).toThrow(RangeError);
  });
});

describe('unappliedOn', () => {
  it('is the amount less its allocations, including refunds paid from it', () => {
    const advance = credit({ allocations: [at('2026-09-20', 10_000), at('2026-09-30', 5_000)] });
    expect(unappliedOn(advance, '2026-09-14')).toBe(0);
    expect(unappliedOn(advance, '2026-09-15')).toBe(40_000);
    expect(unappliedOn(advance, '2026-09-20')).toBe(30_000);
    expect(unappliedOn(advance, AS_OF)).toBe(25_000);
  });

  it('is nothing from the day a cheque bounced, its allocations undone', () => {
    const bounced = credit({
      voidedOn: '2026-09-25',
      allocations: [at('2026-09-15', 30_000), at('2026-09-25', -30_000)],
    });
    expect(unappliedOn(bounced, '2026-09-24')).toBe(10_000);
    expect(unappliedOn(bounced, '2026-09-25')).toBe(0);
  });
});

describe('ageReceivables', () => {
  it('ages each bill from its due date and totals the buckets', () => {
    const result = ageReceivables({
      asOf: AS_OF,
      receivables: [
        bill({ id: 'a', dueOn: '2026-10-20' }), // not yet due
        bill({ id: 'b', dueOn: AS_OF, totalPaise: 1_000 }), // due today
        bill({ id: 'c', dueOn: '2026-08-12', totalPaise: 2_000 }), // 60 days
        bill({ id: 'd', dueOn: '2026-07-13', totalPaise: 3_000 }), // 90 days
        bill({ id: 'e', dueOn: '2026-07-12', totalPaise: 4_000 }), // 91 days
        bill({ id: 'f', kind: 'charge', dueOn: null, raisedOn: '2026-09-11', totalPaise: 500 }),
        bill({ id: 'paid', allocations: [at('2026-09-02', 100_000)] }),
      ],
      credits: [],
    });
    expect(result.totals).toEqual({
      buckets: {
        not_due: 100_000,
        days_0_30: 1_500,
        days_31_60: 2_000,
        days_61_90: 3_000,
        days_90_plus: 4_000,
      },
      outstandingPaise: 110_500,
      unappliedPaise: 0,
      netPaise: 110_500,
    });
    expect(result.receivables.map((r) => [r.id, r.daysPastDue, r.bucket])).toEqual([
      ['e', 91, 'days_90_plus'],
      ['d', 90, 'days_61_90'],
      ['c', 60, 'days_31_60'],
      ['f', 30, 'days_0_30'],
      ['b', 0, 'days_0_30'],
      ['a', -9, 'not_due'],
    ]);
    expect(result.receivables.find((r) => r.id === 'f')?.effectiveDueOn).toBe('2026-09-11');
  });

  it('orders bills due the same day by when they were raised, then by id', () => {
    const result = ageReceivables({
      asOf: AS_OF,
      receivables: [
        bill({ id: 'z', raisedOn: '2026-09-02' }),
        bill({ id: 'y', raisedOn: '2026-09-02' }),
        bill({ id: 'x', raisedOn: '2026-09-03' }),
        bill({ id: 'w', raisedOn: '2026-09-01' }),
      ],
      credits: [
        credit({ id: 'q', receivedOn: '2026-09-16' }),
        credit({ id: 'p', receivedOn: '2026-09-16' }),
        credit({ id: 'o', receivedOn: '2026-09-15' }),
      ],
    });
    expect(result.receivables.map((r) => r.id)).toEqual(['w', 'y', 'z', 'x']);
    expect(result.credits.map((c) => c.id)).toEqual(['o', 'p', 'q']);
  });

  it('keeps partial payments on the bill and nets an advance against the balance', () => {
    const result = ageReceivables({
      asOf: AS_OF,
      receivables: [bill({ allocations: [at('2026-09-15', 40_000)] })],
      credits: [
        credit({ allocations: [at('2026-09-15', 40_000)] }),
        credit({ id: 'pay-2', amountPaise: 25_000, receivedOn: '2026-10-05' }),
      ],
    });
    expect(result.receivables.map((r) => r.outstandingPaise)).toEqual([60_000]);
    expect(result.credits.map((c) => [c.id, c.unappliedPaise])).toEqual([['pay-2', 25_000]]);
    expect(result.totals).toMatchObject({
      outstandingPaise: 60_000,
      unappliedPaise: 25_000,
      netPaise: 35_000,
    });
  });

  it('nets to a credit balance when the party has paid ahead of every bill', () => {
    const result = ageReceivables({
      asOf: AS_OF,
      receivables: [],
      credits: [credit({ amountPaise: 9_999 })],
    });
    expect(result.totals).toEqual({ ...emptyTotals(), unappliedPaise: 9_999, netPaise: -9_999 });
  });

  it('applies a credit note to its invoice and keeps the excess as credit', () => {
    const note = credit({
      id: 'cn-1',
      kind: 'credit_note',
      receivedOn: '2026-10-02',
      amountPaise: 120_000,
      allocations: [at('2026-10-02', 100_000)],
    });
    const result = ageReceivables({
      asOf: AS_OF,
      receivables: [bill({ allocations: [at('2026-10-02', 100_000)] })],
      credits: [note],
    });
    expect(result.receivables).toEqual([]);
    expect(result.credits.map((c) => [c.kind, c.unappliedPaise])).toEqual([
      ['credit_note', 20_000],
    ]);
    expect(result.totals.netPaise).toBe(-20_000);
  });

  it('ages an opening balance from the day it has been overdue since', () => {
    const opening = bill({
      id: 'open',
      kind: 'opening',
      number: null,
      storeId: null,
      raisedOn: '2026-10-01',
      dueOn: '2026-06-01',
      totalPaise: 50_000,
    });
    const result = ageReceivables({ asOf: AS_OF, receivables: [opening], credits: [] });
    expect(result.receivables[0]).toMatchObject({ daysPastDue: 132, bucket: 'days_90_plus' });
    expect(
      ageReceivables({ asOf: '2026-09-30', receivables: [opening], credits: [] }).receivables,
    ).toEqual([]);
  });

  it('refuses a total that is no longer a safe whole number of paise', () => {
    const huge = bill({ totalPaise: Number.MAX_SAFE_INTEGER });
    expect(() =>
      ageReceivables({
        asOf: AS_OF,
        receivables: [],
        credits: [credit(), credit({ amountPaise: Number.MAX_SAFE_INTEGER })],
      }),
    ).toThrow(RangeError);
    expect(() => ageReceivables({ asOf: AS_OF, receivables: [huge, huge], credits: [] })).toThrow(
      RangeError,
    );
  });
});

describe('groupAgeing and sumTotals', () => {
  it('totals per group in first-seen order, credits in their own group', () => {
    const result = ageReceivables({
      asOf: AS_OF,
      receivables: [
        bill({ id: 'a', partyId: 'p1', dueOn: '2026-10-20' }),
        bill({ id: 'b', partyId: 'p2', storeId: 'store-2', totalPaise: 7_000 }),
        bill({ id: 'c', partyId: 'p1', totalPaise: 3_000 }),
      ],
      credits: [credit({ partyId: 'p3', storeId: 'store-2', amountPaise: 1_000 })],
    });
    const byParty = groupAgeing(
      result,
      (r) => r.partyId,
      (c) => c.partyId,
    );
    expect([...byParty.keys()]).toEqual(['p2', 'p1', 'p3']);
    expect(byParty.get('p1')).toMatchObject({
      buckets: { not_due: 100_000, days_0_30: 3_000 },
      netPaise: 103_000,
    });
    expect(byParty.get('p3')).toEqual({
      ...emptyTotals(),
      unappliedPaise: 1_000,
      netPaise: -1_000,
    });
    const byStore = groupAgeing(
      result,
      (r) => r.storeId,
      (c) => c.storeId,
    );
    expect(byStore.get('store-2')).toMatchObject({ outstandingPaise: 7_000, netPaise: 6_000 });

    const all = [...byParty.values()].reduce(sumTotals, emptyTotals());
    expect(all).toEqual(result.totals);
  });
});

describe('dueSummary', () => {
  it('splits what is overdue from what falls due today and this week', () => {
    const result = ageReceivables({
      asOf: AS_OF,
      receivables: [
        bill({ id: 'late', dueOn: '2026-10-10', totalPaise: 1 }),
        bill({ id: 'today', dueOn: AS_OF, totalPaise: 10 }),
        bill({ id: 'sixth', dueOn: addDays(AS_OF, 6), totalPaise: 100 }),
        bill({ id: 'next-week', dueOn: addDays(AS_OF, 7), totalPaise: 1_000 }),
      ],
      credits: [],
    });
    expect(dueSummary(result)).toEqual({
      dueTodayPaise: 10,
      dueThisWeekPaise: 110,
      overduePaise: 1,
    });
  });
});

describe('creditUtilisation', () => {
  it('compares what credit customers owe with their limits', () => {
    expect(
      creditUtilisation([
        { limitPaise: 3_000_000, netPaise: 1_800_000 },
        { limitPaise: 1_000_000, netPaise: 1_200_000 },
        { limitPaise: 1_000_000, netPaise: -50_000 }, // an advance uses none of it
        { limitPaise: 0, netPaise: 900_000 }, // no credit given: not counted
      ]),
    ).toEqual({
      limitPaise: 5_000_000,
      usedPaise: 3_000_000,
      utilisationBps: 6_000,
      overLimit: 1,
    });
  });

  it('rounds half up and has no ratio without limits', () => {
    expect(creditUtilisation([]).utilisationBps).toBeNull();
    expect(creditUtilisation([{ limitPaise: 30_000, netPaise: 1 }]).utilisationBps).toBe(0);
    expect(creditUtilisation([{ limitPaise: 20_000, netPaise: 1 }]).utilisationBps).toBe(1);
    expect(creditUtilisation([{ limitPaise: 3, netPaise: 2 }]).utilisationBps).toBe(6_667);
  });

  it('stays exact for very large businesses', () => {
    const big = Number.MAX_SAFE_INTEGER - 1;
    expect(creditUtilisation([{ limitPaise: big, netPaise: big }]).utilisationBps).toBe(10_000);
    expect(() => creditUtilisation([{ limitPaise: 1.5, netPaise: 0 }])).toThrow(RangeError);
    expect(() => creditUtilisation([{ limitPaise: 1, netPaise: 0.5 }])).toThrow(RangeError);
  });
});

// A party's books built from random events, checked against the ledger they would post.
describe('ageing matches the party ledger on every day', () => {
  /** A small deterministic generator (mulberry32), so a failure always reproduces. */
  function random(seed: number) {
    let state = seed;
    return (below: number) => {
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) % below;
    };
  }

  /** A bill or credit as these books build it: allocations and a bounce added as they happen. */
  type Building<T> = { -readonly [K in keyof T]: T[K] } & { allocations: DatedAmount[] };

  interface Built {
    receivables: Receivable[];
    credits: Credit[];
    ledger: DatedAmount[];
  }

  /** 60 days of invoices, payments (some by cheque, some bouncing), notes, refunds and charges. */
  function books(seed: number): Built {
    const roll = random(seed);
    const receivables: Building<Receivable>[] = [];
    const credits: Building<Credit>[] = [];
    const ledger: DatedAmount[] = [];
    const start = '2026-08-01';
    const open = (day: string) =>
      receivables.filter((r) => r.cancelledOn === null && outstandingOn(r, day) > 0);
    /** Allocates what is left of `source` to open bills, oldest first, on `day`. */
    const allocate = (source: Building<Credit>, day: string) => {
      let left = unappliedOn(source, day);
      for (const target of open(day)) {
        if (left === 0) break;
        const amount = Math.min(left, outstandingOn(target, day));
        target.allocations.push(at(day, amount));
        source.allocations.push(at(day, amount));
        left -= amount;
      }
    };
    receivables.push({
      ...bill({ id: 'opening', kind: 'opening', raisedOn: start, dueOn: '2026-05-01' }),
      allocations: [],
    });
    ledger.push(at(start, 100_000));
    for (let offset = 0; offset < 60; offset += 1) {
      const day = addDays(start, offset);
      const event = roll(10);
      const amount = 1_000 + roll(90_000);
      const id = String(offset);
      if (event <= 3) {
        const cancel = roll(8) === 0;
        const cancelledOn = cancel ? addDays(day, roll(2)) : null;
        receivables.push({
          ...bill({
            id: `inv-${id}`,
            raisedOn: day,
            dueOn: addDays(day, roll(45)),
            totalPaise: amount,
            cancelledOn,
          }),
          allocations: [],
        });
        ledger.push(at(day, amount));
        if (cancelledOn !== null) ledger.push(at(cancelledOn, -amount));
        // Any advance is used on the new bill, as issuing an invoice does.
        for (const source of credits) if (!cancel) allocate(source, day);
      } else if (event <= 6) {
        const payment: Building<Credit> = {
          ...credit({ id: `pay-${id}`, receivedOn: day, amountPaise: amount }),
          allocations: [],
        };
        credits.push(payment);
        ledger.push(at(day, -amount));
        allocate(payment, day);
        if (roll(4) === 0) {
          // The cheque bounces: its live allocations are undone and the party owes it again.
          const bouncedOn = addDays(day, 1 + roll(5));
          const undo = [...payment.allocations];
          payment.voidedOn = bouncedOn;
          for (const allocation of undo) {
            payment.allocations.push(at(bouncedOn, -allocation.amountPaise));
          }
          for (const target of receivables) {
            const taken = target.allocations.filter((a) => a.on === day);
            // Only this payment allocated on this day in these books.
            for (const allocation of taken)
              target.allocations.push(at(bouncedOn, -allocation.amountPaise));
          }
          ledger.push(at(bouncedOn, amount));
          // A bounce charge the party owes.
          receivables.push({
            ...bill({
              id: `charge-${id}`,
              kind: 'charge',
              raisedOn: bouncedOn,
              dueOn: null,
              totalPaise: 500,
            }),
            allocations: [],
          });
          ledger.push(at(bouncedOn, 500));
          offset += 6; // keep each bounce's allocations on their own days
        }
      } else if (event <= 8) {
        const note: Building<Credit> = {
          ...credit({ id: `cn-${id}`, kind: 'credit_note', receivedOn: day, amountPaise: amount }),
          allocations: [],
        };
        credits.push(note);
        ledger.push(at(day, -amount));
        allocate(note, day);
      } else {
        // A refund paid out of whatever a credit has left.
        const source = credits.find((c) => c.voidedOn === null && unappliedOn(c, day) > 0);
        if (source) {
          const refund = Math.min(unappliedOn(source, day), amount);
          source.allocations.push(at(day, refund));
          ledger.push(at(day, refund));
        }
      }
    }
    return { receivables, credits, ledger };
  }

  it('Σ buckets − unapplied credit = the ledger balance, as of each day', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { receivables, credits, ledger } = books(seed);
      for (let offset = -1; offset < 75; offset += 1) {
        const asOf = addDays('2026-08-01', offset);
        const result = ageReceivables({ asOf, receivables, credits });
        const balance = ledger.filter((e) => e.on <= asOf).reduce((s, e) => s + e.amountPaise, 0);
        const buckets = AGEING_BUCKETS.reduce((s, b) => s + result.totals.buckets[b], 0);
        expect({ seed, asOf, net: buckets - result.totals.unappliedPaise }).toEqual({
          seed,
          asOf,
          net: balance,
        });
        expect(result.receivables.every((r) => r.outstandingPaise > 0)).toBe(true);
        expect(result.credits.every((c) => c.unappliedPaise > 0)).toBe(true);
      }
    }
  });
});
