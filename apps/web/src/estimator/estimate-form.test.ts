import { describe, expect, it } from 'vitest';
import { found } from '../test-support/found.js';
import {
  checkDraft,
  draftOf,
  estimateRequest,
  liveTiers,
  newDraft,
  productIdsOf,
  wastageBpsOf,
  type EstimateDraft,
} from './estimate-form.js';
import { blankRoom } from './rooms.js';
import {
  APCOLITE,
  ESTIMATE,
  NO_COVERAGE,
  PAINT_PRODUCTS,
  PRIMER,
  PUTTY,
  ROYALE,
  TRACTOR,
} from './test-support/estimate-fixtures.js';

const ROOM = { ...blankRoom('room-1', 'Hall'), lengthFt: '14', widthFt: '12' };
const DRAFT: EstimateDraft = { ...newDraft('store-amp', 'Hall'), rooms: [ROOM] };
const BY_ID = new Map(PAINT_PRODUCTS.map((product) => [product.id, product]));

describe('wastageBpsOf', () => {
  it('reads 0 to 50 %, to 2 decimals', () => {
    expect(wastageBpsOf('5')).toBe(500);
    expect(wastageBpsOf(' 7.25 ')).toBe(725);
    expect(wastageBpsOf('0')).toBe(0);
    expect(wastageBpsOf('50.01')).toBeNull();
    expect(wastageBpsOf('-1')).toBeNull();
    expect(wastageBpsOf('')).toBeNull();
  });
});

describe('checkDraft', () => {
  it('adds up the rooms', () => {
    const check = checkDraft(DRAFT);
    expect(check.problem).toBeNull();
    expect(check.surfaces).toHaveLength(1);
    expect(check.wastageBps).toBe(500);
    expect(check.rooms.map((room) => room.result)).toEqual([check.surfaces]);
  });

  it('names the first thing stopping a save', () => {
    expect(checkDraft({ ...DRAFT, storeId: '' }).problem).toBe('store');
    expect(checkDraft({ ...DRAFT, rooms: [] }).problem).toBe('noRooms');
    const broken = checkDraft({ ...DRAFT, rooms: [ROOM, blankRoom('room-2', 'Bed')] });
    expect(broken.problem).toBe('rooms');
    expect(broken.rooms.map((room) => room.result)[1]).toBe('size');
    const many = Array.from({ length: 51 }, (_, index) => ({
      ...ROOM,
      key: `r${String(index)}`,
      ceiling: true,
    }));
    expect(checkDraft({ ...DRAFT, rooms: many }).problem).toBe('tooMany');
    expect(checkDraft({ ...DRAFT, wastage: 'lots' }).problem).toBe('wastage');
  });
});

describe('estimateRequest', () => {
  it('sends the chosen tiers, with primer and putty on each', () => {
    const draft: EstimateDraft = {
      ...DRAFT,
      party: { id: 'party-1', name: 'Apex Builders' },
      title: ' Reddy residence ',
      tiers: { good: TRACTOR, better: null, best: ROYALE },
      primer: PRIMER,
      putty: PUTTY,
    };
    expect(estimateRequest(draft, checkDraft(draft))).toEqual({
      storeId: 'store-amp',
      partyId: 'party-1',
      title: 'Reddy residence',
      wastageBps: 500,
      surfaces: checkDraft(draft).surfaces,
      options: [
        {
          tier: 'good',
          productId: TRACTOR.id,
          primerProductId: PRIMER.id,
          puttyProductId: PUTTY.id,
        },
        {
          tier: 'best',
          productId: ROYALE.id,
          primerProductId: PRIMER.id,
          puttyProductId: PUTTY.id,
        },
      ],
    });
  });

  it('leaves out what is not given', () => {
    const draft = { ...DRAFT, wastage: 'x', tiers: { good: APCOLITE, better: null, best: null } };
    expect(estimateRequest(draft, checkDraft(draft))).toEqual({
      storeId: 'store-amp',
      surfaces: checkDraft(draft).surfaces,
      options: [{ tier: 'good', productId: APCOLITE.id }],
    });
  });
});

describe('draftOf', () => {
  it('reads a saved estimate back into the form', () => {
    const draft = draftOf(ESTIMATE, BY_ID);
    expect(draft).toMatchObject({
      storeId: 'store-amp',
      party: { id: 'party-1', name: 'Apex Builders' },
      title: 'Reddy residence',
      wastage: '5',
      tiers: { good: TRACTOR, better: null, best: ROYALE },
      primer: PRIMER,
      putty: PUTTY,
    });
    expect(draft.rooms).toHaveLength(1);
    expect(productIdsOf(ESTIMATE)).toEqual([TRACTOR.id, PRIMER.id, PUTTY.id, ROYALE.id]);
  });

  it('copes with no party, title, options or loaded product', () => {
    const bare = { ...ESTIMATE, party: null, title: null, options: [] };
    expect(draftOf(bare, new Map())).toMatchObject({
      party: null,
      title: '',
      primer: null,
      putty: null,
    });
    const lone = {
      ...ESTIMATE,
      options: [
        {
          ...found(ESTIMATE.options[0]),
          primerProduct: null,
          puttyProduct: null,
        },
      ],
    };
    expect(draftOf(lone, new Map())).toMatchObject({ tiers: { good: null }, primer: null });
    expect(productIdsOf(lone)).toEqual([TRACTOR.id]);
  });
});

describe('liveTiers', () => {
  it('prices each chosen tier on the rooms typed', () => {
    const draft: EstimateDraft = {
      ...DRAFT,
      rooms: [{ ...ROOM, condition: 'new' }],
      tiers: { good: TRACTOR, better: NO_COVERAGE, best: null },
      primer: PRIMER,
      putty: PUTTY,
    };
    const [good, better] = liveTiers(draft, checkDraft(draft));
    expect(good).toMatchObject({
      tier: 'good',
      paintMl: 8_453,
      primerMl: 3_757,
      puttyGrams: 35_501,
    });
    expect(better).toEqual({ tier: 'better', problem: 'noCoverage', purpose: 'paint' });
    expect(liveTiers({ ...draft, primer: null, putty: null }, checkDraft(draft))[0]).toMatchObject({
      primerMl: 0,
      puttyGrams: 0,
    });
    expect(
      liveTiers({ ...draft, wastage: '' }, checkDraft({ ...draft, wastage: '' }))[0],
    ).toMatchObject({
      paintMl: 8_453,
    });
  });
});
