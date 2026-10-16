import { describe, expect, it } from 'vitest';
import { LITRES, MONSOON } from '../test-support/scheme-fixtures.js';
import { newPlan, readPlan } from './price-hike-form.js';
import {
  NEW_BENEFIT,
  NEW_SCHEME,
  parseLitres,
  parsePercent,
  parseTarget,
  readScheme,
  schemeValues,
  type BenefitValues,
  type SchemeValues,
} from './scheme-form.js';

const filled: SchemeValues = {
  ...NEW_SCHEME,
  brandId: 'brand-apex',
  name: '  Monsoon slab ',
  brandReference: ' APX/Q2/26 ',
  startsOn: '2026-07-01',
  endsOn: '2026-09-30',
  settlementDays: '30',
  note: '',
  categoryIds: ['cat-emulsions'],
  slabs: [
    {
      target: '50000',
      benefits: [
        { ...NEW_BENEFIT, kind: 'rebate', percent: '1' },
        { ...NEW_BENEFIT, kind: 'points', label: ' Goa trip ', points: '1' },
      ],
    },
    {
      target: '100000',
      benefits: [
        { ...NEW_BENEFIT, kind: 'per_litre', rupeesPerLitre: '2' },
        { ...NEW_BENEFIT, kind: 'free_goods', variantId: 'v-ult-10', units: '1', perLitres: '100' },
        { ...NEW_BENEFIT, kind: 'free_goods', variantId: 'v-ult-20', units: '2', perLitres: ' ' },
      ],
    },
  ],
};

const withBenefit = (benefit: Partial<BenefitValues>): SchemeValues => ({
  ...filled,
  slabs: [{ target: '1000', benefits: [{ ...NEW_BENEFIT, ...benefit }] }],
});

describe('scheme form', () => {
  it('reads percents, litres and targets as typed', () => {
    expect(parsePercent('1.5')).toBe(150);
    expect(parsePercent('0')).toBeNull();
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('1.234')).toBeNull();
    expect(parseLitres('0.5')).toBe(500);
    expect(parseLitres('0')).toBeNull();
    expect(parseLitres('abc')).toBeNull();
    expect(parseTarget('1,250.50', 'value')).toBe(125_050);
    expect(parseTarget('0', 'value')).toBeNull();
    expect(parseTarget('nope', 'value')).toBeNull();
    expect(parseTarget('250', 'litres')).toBe(250_000);
  });

  it('turns the fields into the scheme the API takes', () => {
    expect(readScheme(filled)).toEqual({
      input: {
        brandId: 'brand-apex',
        name: 'Monsoon slab',
        brandReference: 'APX/Q2/26',
        startsOn: '2026-07-01',
        endsOn: '2026-09-30',
        measure: 'value',
        mode: 'retro',
        settlementDays: 30,
        dateBasis: 'grn_date',
        note: null,
        productIds: [],
        categoryIds: ['cat-emulsions'],
        slabs: [
          {
            target: 50_000_00,
            benefits: [
              { kind: 'rebate', basisPoints: 100 },
              { kind: 'points', label: 'Goa trip', points: 1 },
            ],
          },
          {
            target: 1_00_000_00,
            benefits: [
              { kind: 'per_litre', paisePerLitre: 200 },
              { kind: 'free_goods', variantId: 'v-ult-10', units: 1, perMillilitres: 100_000 },
              { kind: 'free_goods', variantId: 'v-ult-20', units: 2, perMillilitres: null },
            ],
          },
        ],
      },
    });
    const defaults = readScheme({ ...filled, settlementDays: '' });
    expect('input' in defaults && defaults.input.settlementDays).toBeNull();
  });

  it.each([
    [{ brandId: '' }, 'schemes.invalid.brand'],
    [{ name: ' ' }, 'schemes.invalid.name'],
    [{ name: 'x'.repeat(121) }, 'schemes.invalid.name'],
    [{ startsOn: '' }, 'schemes.invalid.dates'],
    [{ endsOn: 'soon' }, 'schemes.invalid.dates'],
    [{ endsOn: '2026-06-30' }, 'schemes.invalid.dates'],
    [{ settlementDays: '400' }, 'schemes.invalid.settlement'],
    [{ slabs: [{ target: '0', benefits: [NEW_BENEFIT] }] }, 'schemes.invalid.target'],
    [
      {
        slabs: [
          { target: '200', benefits: [{ ...NEW_BENEFIT, percent: '1' }] },
          { target: '100', benefits: [{ ...NEW_BENEFIT, percent: '1' }] },
        ],
      },
      'schemes.invalid.rising',
    ],
    [{ slabs: [{ target: '100', benefits: [] }] }, 'schemes.invalid.noBenefit'],
  ] as const)('refuses %o', (changes, problem) => {
    expect(readScheme({ ...filled, ...changes })).toEqual({ problem });
  });

  it.each([
    [{ kind: 'rebate', percent: '' }, 'schemes.invalid.percent'],
    [{ kind: 'per_litre', rupeesPerLitre: '0' }, 'schemes.invalid.rupeesPerLitre'],
    [{ kind: 'per_litre', rupeesPerLitre: 'two' }, 'schemes.invalid.rupeesPerLitre'],
    [{ kind: 'free_goods', variantId: '' }, 'schemes.invalid.variant'],
    [{ kind: 'free_goods', variantId: 'v', units: '0' }, 'schemes.invalid.units'],
    [{ kind: 'free_goods', variantId: 'v', units: 'x' }, 'schemes.invalid.units'],
    [
      { kind: 'free_goods', variantId: 'v', units: '1', perLitres: '0' },
      'schemes.invalid.perLitres',
    ],
    [{ kind: 'points', label: ' ' }, 'schemes.invalid.label'],
    [{ kind: 'points', label: 'x'.repeat(61) }, 'schemes.invalid.label'],
    [{ kind: 'points', label: 'Gift', points: '0' }, 'schemes.invalid.points'],
  ] as const)('refuses the benefit %o', (benefit, problem) => {
    expect(readScheme(withBenefit(benefit))).toEqual({ problem });
  });

  it('gives back a stored scheme’s fields, which read back to the same scheme', () => {
    const values = schemeValues(MONSOON);
    expect(values).toMatchObject({
      brandId: 'brand-apex',
      brandReference: 'APX/Q2/26',
      settlementDays: '30',
      note: 'Circular of 28 June',
      categoryIds: ['cat-emulsions'],
    });
    expect(values.slabs[1]?.benefits.map((benefit) => benefit.kind)).toEqual([
      'per_litre',
      'free_goods',
      'free_goods',
    ]);
    const read = readScheme(values);
    expect('input' in read && read.input.slabs).toEqual(
      MONSOON.slabs.map((slab) => ({
        target: slab.target,
        benefits: slab.benefits.map((benefit) => {
          if (benefit.kind !== 'free_goods') return benefit;
          const { variantTitle: _title, ...rest } = benefit;
          return rest;
        }),
      })),
    );
    const litres = schemeValues(LITRES);
    expect(litres).toMatchObject({
      brandReference: '',
      settlementDays: '',
      note: '',
      productIds: ['p-silk'],
      slabs: [{ target: '100', benefits: [{ kind: 'per_litre', rupeesPerLitre: '5.00' }] }],
    });
  });
});

describe('price-hike planner form', () => {
  const plan = { ...newPlan('2026-10-23'), brandId: 'brand-apex', hike: '4.5' };

  it('starts a week ahead with the default rates, and reads the fields for the API', () => {
    expect(newPlan('2026-10-23')).toMatchObject({
      effectiveOn: '2026-10-23',
      window: '90',
      holding: '6',
      money: '12',
      deadStock: '4',
      cover: '90',
    });
    expect(readPlan(plan)).toEqual({
      input: {
        brandId: 'brand-apex',
        hikeBasisPoints: 450,
        effectiveOn: '2026-10-23',
        productIds: [],
        categoryIds: [],
        storeId: null,
        salesWindowDays: 90,
        holdingCostBps: 600,
        costOfMoneyBps: 1200,
        deadStockRiskBps: 400,
        maxCoverDays: 90,
      },
    });
    const store = readPlan({ ...plan, storeId: 'store-hyd', holding: '0' });
    expect('input' in store && [store.input.storeId, store.input.holdingCostBps]).toEqual([
      'store-hyd',
      0,
    ]);
  });

  it.each([
    [{ brandId: '' }, 'priceHike.invalid.brand'],
    [{ hike: '' }, 'priceHike.invalid.hike'],
    [{ hike: '51' }, 'priceHike.invalid.hike'],
    [{ window: '6' }, 'priceHike.invalid.window'],
    [{ window: 'x' }, 'priceHike.invalid.window'],
    [{ holding: 'x' }, 'priceHike.invalid.rate'],
    [{ money: '-1' }, 'priceHike.invalid.rate'],
    [{ deadStock: '' }, 'priceHike.invalid.rate'],
    [{ cover: '0' }, 'priceHike.invalid.cover'],
  ] as const)('refuses %o', (changes, problem) => {
    expect(readPlan({ ...plan, ...changes })).toEqual({ problem });
  });
});
