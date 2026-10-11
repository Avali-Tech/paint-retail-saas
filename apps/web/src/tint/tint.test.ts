import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api/client.js';
import { fakeFetch, json } from '../test-support/fake-api.js';
import { billReducer, newBill, type BillLine } from '../pos/bill.js';
import { item } from '../pos/test-support/pos-fixtures.js';
import { tintRecord } from './test-support/tint-fixtures.js';
import {
  EMPTY_ROW,
  choiceFromRecord,
  formOf,
  isTintableProduct,
  lineTint,
  parseTintForm,
  shadeLabel,
  withViewTint,
  withTint,
  type TintChoice,
  type TintForm,
} from './tint.js';
import { tintEndpoints } from './tint-api.js';

const IVORY: TintChoice = {
  shadeCode: 'X 132',
  shadeName: 'Ivory Mist',
  brandId: null,
  machine: null,
  formula: [],
  tintChargePaise: 5_000,
  colorantCostPaise: null,
  note: null,
};

const line = (overrides: Partial<BillLine> = {}): BillLine => ({
  ...item({ unitPricePaise: 200_000, tintable: true }),
  quantity: 2,
  discount: null,
  ...overrides,
});

function endpoints(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes);
  const api = createApiClient({
    baseUrl: '/api',
    fetch: fake.fetch,
    getToken: () => 'tok',
    onUnauthorized: vi.fn(),
  });
  return { ...fake, tint: tintEndpoints(api) };
}

describe('tint on a line', () => {
  it('knows a tintable product only by round 5a’s flag', () => {
    expect(isTintableProduct({ isTintable: true })).toBe(true);
    expect(isTintableProduct({ isTintable: false })).toBe(false);
    expect(isTintableProduct({ name: 'Hinge' })).toBe(false);
  });

  it('adds the tinting charge to the base price, and takes it off again', () => {
    const tinted = withTint(line(), IVORY);
    expect(tinted.unitPricePaise).toBe(205_000);
    expect(tinted.tint).toEqual({ ...IVORY, basePricePaise: 200_000 });
    // A new charge replaces the old one; the base price stays.
    const dearer = withTint(tinted, { ...IVORY, tintChargePaise: 8_000 });
    expect(dearer.unitPricePaise).toBe(208_000);
    const plain = withTint(dearer, null);
    expect(plain).toMatchObject({ unitPricePaise: 200_000, tint: null });
  });

  it('keeps a tinted line apart when the same base is scanned again', () => {
    let bill = billReducer(newBill('b'), { type: 'add', item: item(), quantity: 1 });
    bill = billReducer(bill, { type: 'tint', index: 0, tint: IVORY });
    expect(bill.lines[0]?.unitPricePaise).toBe(1_050_000);
    bill = billReducer(bill, { type: 'add', item: item(), quantity: 1 });
    bill = billReducer(bill, { type: 'add', item: item(), quantity: 1 });
    expect(bill.lines.map((l) => [l.quantity, l.tint?.shadeCode ?? null])).toEqual([
      [1, 'X 132'],
      [2, null],
    ]);
    expect(billReducer(bill, { type: 'tint', index: 0, tint: null }).lines[0]?.tint).toBeNull();
  });

  it('copies a past record and names its shade', () => {
    expect(choiceFromRecord(tintRecord())).toEqual({
      shadeCode: 'X 132',
      shadeName: 'Ivory Mist',
      brandId: 'brand-asian',
      machine: 'Counter 1',
      formula: tintRecord().formula,
      tintChargePaise: 5_000,
      colorantCostPaise: 3_000,
      note: null,
    });
    expect(shadeLabel(IVORY)).toBe('X 132 · Ivory Mist');
    expect(shadeLabel({ shadeCode: 'Y 7', shadeName: null })).toBe('Y 7');
  });

  it('sends only what was chosen with the line, and leaves the packs to the server', () => {
    expect(lineTint(IVORY)).toEqual({
      shadeCode: 'X 132',
      shadeName: 'Ivory Mist',
      tintChargePaise: 5_000,
      formula: [],
    });
    expect(lineTint(choiceFromRecord(tintRecord()))).toEqual({
      shadeCode: 'X 132',
      shadeName: 'Ivory Mist',
      brandId: 'brand-asian',
      machine: 'Counter 1',
      colorantCostPaise: 3_000,
      tintChargePaise: 5_000,
      formula: tintRecord().formula,
    });
    expect(lineTint({ ...IVORY, shadeName: null })).not.toHaveProperty('shadeName');
  });
});

describe('saved lines', () => {
  it('reads a line’s tint back, taking the charge out of the base; the server’s word wins', () => {
    const back = withViewTint(line({ unitPricePaise: 205_000 }), tintRecord());
    expect(back).toMatchObject({
      unitPricePaise: 205_000,
      tintable: true,
      tint: { shadeCode: 'X 132', basePricePaise: 200_000 },
    });
    // Untinted on the server: a shade remembered on this device is dropped.
    const remembered = line({ tint: { ...IVORY, basePricePaise: 200_000 } });
    expect(withViewTint(remembered, undefined)).toEqual({ ...remembered, tint: null });
  });
});

describe('the tint form', () => {
  const filled = (overrides: Partial<TintForm> = {}): TintForm => ({
    ...formOf(null),
    shadeCode: ' x  132 ',
    ...overrides,
  });

  it('starts empty, or from a tint', () => {
    expect(formOf(null)).toEqual({
      shadeCode: '',
      shadeName: '',
      brandId: null,
      machine: '',
      charge: '',
      cost: '',
      formula: [EMPTY_ROW],
      note: null,
    });
    expect(formOf(choiceFromRecord(tintRecord()))).toEqual({
      shadeCode: 'X 132',
      shadeName: 'Ivory Mist',
      brandId: 'brand-asian',
      machine: 'Counter 1',
      charge: '50.00',
      cost: '30.00',
      formula: [
        { colorant: 'XY', amount: '12.5', unit: 'ml' },
        { colorant: 'Fast Red', amount: '3', unit: 'shot' },
      ],
      note: null,
    });
    expect(formOf(IVORY)).toMatchObject({ shadeName: 'Ivory Mist', machine: '', charge: '50.00' });
    expect(formOf({ ...IVORY, tintChargePaise: 0, shadeName: null })).toMatchObject({
      shadeName: '',
      charge: '',
      cost: '',
      formula: [EMPTY_ROW],
    });
  });

  it('normalises the shade and leaves out what was not typed', () => {
    expect(parseTintForm(filled())).toEqual({
      ok: true,
      tint: {
        shadeCode: 'X 132',
        shadeName: null,
        brandId: null,
        machine: null,
        formula: [],
        tintChargePaise: 0,
        colorantCostPaise: null,
        note: null,
      },
    });
    expect(
      parseTintForm(
        filled({
          shadeName: ' Ivory ',
          machine: 'Counter 2',
          charge: '45.50',
          cost: '0',
          brandId: 'brand-asian',
          formula: [
            { colorant: ' XY ', amount: '1.250', unit: 'y' },
            EMPTY_ROW,
            { colorant: 'B', amount: '2', unit: 'g' },
          ],
        }),
      ),
    ).toEqual({
      ok: true,
      tint: {
        shadeCode: 'X 132',
        shadeName: 'Ivory',
        brandId: 'brand-asian',
        machine: 'Counter 2',
        formula: [
          { colorant: 'XY', amount: 1.25, unit: 'y' },
          { colorant: 'B', amount: 2, unit: 'g' },
        ],
        tintChargePaise: 4_550,
        colorantCostPaise: 0,
        note: null,
      },
    });
  });

  it('keeps a tint’s note, unedited, from the form back to the line request', () => {
    const read = choiceFromRecord(tintRecord({ note: 'Match the old wall' }));
    const parsed = parseTintForm({ ...formOf(read), machine: 'Counter 2' });
    expect(parsed).toMatchObject({ ok: true, tint: { note: 'Match the old wall' } });
    expect(parsed.ok && lineTint(parsed.tint)).toMatchObject({ note: 'Match the old wall' });
  });

  it('says what is wrong', () => {
    expect(
      parseTintForm(
        filled({
          shadeCode: '  ',
          shadeName: 'n'.repeat(81),
          machine: 'm'.repeat(81),
          charge: 'fifty',
          cost: '-5',
          formula: [{ colorant: 'XY', amount: '0', unit: 'ml' }],
        }),
      ),
    ).toEqual({
      ok: false,
      problems: {
        shadeCode: 'shadeCode',
        shadeName: 'tooLong',
        machine: 'tooLong',
        charge: 'amount',
        cost: 'amount',
        formula: 'formulaRow',
      },
    });
    const row = (colorant: string, amount = '1') => ({ colorant, amount, unit: 'ml' as const });
    expect(parseTintForm(filled({ formula: [row('', '2')] }))).toMatchObject({
      problems: { formula: 'formulaRow' },
    });
    expect(parseTintForm(filled({ formula: [row('c'.repeat(41))] }))).toMatchObject({
      problems: { formula: 'formulaRow' },
    });
    expect(
      parseTintForm(
        filled({ formula: Array.from({ length: 17 }, (_, i) => row(`C${String(i)}`)) }),
      ),
    ).toEqual({ ok: false, problems: { formula: 'tooManyColorants' } });
  });
});

describe('tint endpoints', () => {
  it('searches the shade history', async () => {
    const page = { items: [tintRecord()], total: 1 };
    const { tint, requests } = endpoints({ 'GET /tint-records': () => json(page) });
    expect(await tint.history({ partyId: 'p1', q: 'x 1', limit: 20 })).toEqual(page);
    expect(requests.map((r) => [r.path, r.query.toString()])).toEqual([
      ['/tint-records', 'partyId=p1&q=x+1&limit=20'],
    ]);
  });
});
