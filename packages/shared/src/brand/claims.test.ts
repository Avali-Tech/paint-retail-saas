import { describe, expect, it } from 'vitest';
import { claimsAgeing, schemeClaim, type ReceivedBenefit, type SchemeClaim } from './claims.js';
import type { SlabBenefits } from './scheme.js';
import { litresScheme } from './test-support/fixtures.js';

const expected: SlabBenefits = {
  rebatePaise: 6_000_00,
  perLitrePaise: 4_000_00,
  creditPaise: 10_000_00,
  freeGoods: [
    { variantId: 'v-20l', units: 5 },
    { variantId: 'v-1l', units: 2 },
  ],
  points: [{ label: 'trip', points: 1 }],
};

const money = (id: string, amountPaise: number, receivedOn = '2026-11-01'): ReceivedBenefit => ({
  kind: 'money',
  id,
  schemeId: 'scheme-1',
  receivedOn,
  amountPaise,
});

const goods = (variantId: string, units: number): ReceivedBenefit => ({
  kind: 'free_goods',
  id: `g-${variantId}`,
  schemeId: 'scheme-1',
  receivedOn: '2026-10-15',
  variantId,
  units,
});

const points = (label: string, count: number): ReceivedBenefit => ({
  kind: 'points',
  id: `p-${label}`,
  schemeId: 'scheme-1',
  receivedOn: '2026-10-15',
  label,
  points: count,
});

describe('schemeClaim', () => {
  it('nets what the brand issued against what the slabs make', () => {
    const claim = schemeClaim(
      litresScheme(),
      expected,
      [
        money('cn-1', 7_000_00),
        money('cn-2', 500_00),
        money('cn-other', 99_00, '2026-11-01'),
        { ...money('cn-x', 1_000_00), schemeId: 'scheme-2' },
        money('cn-late', 2_500_00, '2026-12-31'),
        goods('v-20l', 5),
        goods('v-4l', 1),
        points('gift', 10),
      ],
      '2026-12-01',
    );
    expect(claim).toEqual<SchemeClaim>({
      schemeId: 'scheme-1',
      brandId: 'brand-a',
      asOf: '2026-12-01',
      final: true,
      // 45 days after 30 September.
      dueOn: '2026-11-14',
      daysPastDue: 17,
      bucket: 'days_0_30',
      status: 'open',
      money: { expectedPaise: 10_000_00, receivedPaise: 7_599_00, outstandingPaise: 2_401_00 },
      freeGoods: [
        { variantId: 'v-1l', expectedUnits: 2, receivedUnits: 0, outstandingUnits: 2 },
        { variantId: 'v-20l', expectedUnits: 5, receivedUnits: 5, outstandingUnits: 0 },
        { variantId: 'v-4l', expectedUnits: 0, receivedUnits: 1, outstandingUnits: -1 },
      ],
      points: [
        { label: 'gift', expected: 0, received: 10, outstanding: -10 },
        { label: 'trip', expected: 1, received: 0, outstanding: 1 },
      ],
    });
  });

  it('is provisional and not yet due during the period, with its own settlement days', () => {
    const claim = schemeClaim(litresScheme({ settlementDays: 0 }), expected, [], '2026-09-30');
    expect(claim).toMatchObject({
      final: false,
      dueOn: '2026-09-30',
      daysPastDue: 0,
      bucket: 'days_0_30',
    });
    const early = schemeClaim(litresScheme(), expected, [], '2026-08-01');
    expect(early).toMatchObject({ final: false, bucket: 'not_due', daysPastDue: -105 });
  });

  it('is settled when everything came, and an excess when more did', () => {
    const all = [money('cn', 10_000_00), goods('v-20l', 5), goods('v-1l', 2), points('trip', 1)];
    const settled = schemeClaim(litresScheme(), expected, all, '2027-03-01');
    expect(settled).toMatchObject({ status: 'settled', bucket: null });
    const excess = schemeClaim(
      litresScheme(),
      expected,
      [...all, money('cn-extra', 1)],
      '2027-03-01',
    );
    expect(excess).toMatchObject({ status: 'excess', bucket: null });
    expect(excess.money.outstandingPaise).toBe(-1);
  });

  it('refuses fractional entries', () => {
    const scheme = litresScheme();
    expect(() => schemeClaim(scheme, expected, [money('x', 0.5)], '2026-12-01')).toThrow(
      'Received amount',
    );
    expect(() => schemeClaim(scheme, expected, [goods('v', 0.5)], '2026-12-01')).toThrow(
      'Received units',
    );
    expect(() => schemeClaim(scheme, expected, [points('x', 0.5)], '2026-12-01')).toThrow(
      'Received points',
    );
  });
});

describe('claimsAgeing', () => {
  it('lists every bucket with open claims and the money owed', () => {
    const scheme = litresScheme();
    const claims = [
      schemeClaim(scheme, expected, [money('a', 4_000_00)], '2026-12-01'),
      schemeClaim(scheme, expected, [], '2027-03-01'),
      // Owes goods only: open, with no money.
      schemeClaim(scheme, expected, [money('b', 10_000_00)], '2027-03-01'),
      // Owes goods and was overpaid: open, adding no money.
      schemeClaim(scheme, expected, [money('c', 11_000_00)], '2027-03-01'),
      schemeClaim(
        scheme,
        expected,
        [money('d', 10_000_00), goods('v-20l', 5), goods('v-1l', 2), points('trip', 1)],
        '2027-03-01',
      ),
    ];
    expect(claimsAgeing(claims)).toEqual([
      { bucket: 'not_due', claims: 0, outstandingPaise: 0 },
      { bucket: 'days_0_30', claims: 1, outstandingPaise: 6_000_00 },
      { bucket: 'days_31_60', claims: 0, outstandingPaise: 0 },
      { bucket: 'days_61_90', claims: 0, outstandingPaise: 0 },
      { bucket: 'days_90_plus', claims: 3, outstandingPaise: 10_000_00 },
    ]);
  });
});
