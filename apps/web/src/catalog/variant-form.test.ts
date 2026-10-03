import { describe, expect, it } from 'vitest';
import { createI18n } from '../i18n/i18n.js';
import { variant } from '../test-support/inventory-fixtures.js';
import {
  EMPTY_VARIANT,
  splitBarcodes,
  toVariantChanges,
  toVariantInput,
  variantDraft,
  variantSchema,
} from './variant-form.js';

const { t } = createI18n('en');
const schema = variantSchema(t);
const draft = { ...EMPTY_VARIANT, sku: 'apx-1l', packSize: '1', mrp: '500', sellingPrice: '450' };

const problems = (values: typeof draft) => {
  const result = schema.safeParse(values);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('variant form', () => {
  it('accepts a valid pack size', () => {
    expect(problems(draft)).toEqual([]);
    expect(problems({ ...draft, mrp: '', sellingPrice: '' })).toEqual([]);
  });

  it('checks the SKU, size, prices and barcodes like the API', () => {
    expect(
      problems({
        ...draft,
        sku: 'a',
        packSize: '0',
        mrp: 'x',
        sellingPrice: 'y',
        barcodes: '8901234567890',
      }),
    ).toEqual([
      'sku: Use 2 to 40 letters, digits or . _ / -',
      'packSize: Enter a size above zero and up to 10,00,000, with at most 3 decimals',
      'mrp: Enter an amount in rupees',
      'sellingPrice: Enter an amount in rupees',
    ]);
    expect(problems({ ...draft, packSize: 'big', barcodes: '8901234567890' })).toEqual([
      'packSize: Enter a size above zero and up to 10,00,000, with at most 3 decimals',
    ]);
    expect(problems({ ...draft, barcodes: '8901234567890, 8901234567893' })).toEqual([
      'barcodes: Barcode 8901234567893 is not valid (check digit or characters)',
    ]);
    for (const packSize of ['1000000.5', '1.2345']) {
      expect(problems({ ...draft, packSize })).toEqual([
        'packSize: Enter a size above zero and up to 10,00,000, with at most 3 decimals',
      ]);
    }
    expect(problems({ ...draft, packSize: '1000000' })).toEqual([]);
    const eleven = Array.from({ length: 11 }, (_, index) => `CODE-${String(index)}`).join(' ');
    expect(problems({ ...draft, barcodes: eleven })).toEqual([
      'barcodes: Up to 10 barcodes per pack size',
    ]);
    expect(problems({ ...draft, sellingPrice: '600' })).toEqual([
      'sellingPrice: Selling price cannot exceed the MRP',
    ]);
  });

  it('reads barcodes separated by commas, semicolons, bars or spaces, once each', () => {
    expect(splitBarcodes(' A1, B2;C3 | D4  A1 ')).toEqual(['A1', 'B2', 'C3', 'D4']);
    expect(splitBarcodes('  ')).toEqual([]);
  });

  it('turns a draft into the API bodies', () => {
    expect(toVariantInput({ ...draft, barcodes: '8901234567890' })).toEqual({
      sku: 'APX-1L',
      packSize: 1,
      unit: 'l',
      mrpPaise: 50_000,
      sellingPricePaise: 45_000,
      barcodes: ['8901234567890'],
    });
    expect(toVariantInput({ ...draft, mrp: '', sellingPrice: '' })).toEqual({
      sku: 'APX-1L',
      packSize: 1,
      unit: 'l',
      barcodes: [],
    });
    expect(toVariantChanges({ ...draft, mrp: '', isActive: false })).toEqual({
      sku: 'APX-1L',
      mrpPaise: null,
      sellingPricePaise: 45_000,
      barcodes: [],
      isActive: false,
    });
  });

  it('fills the form from a saved pack size', () => {
    expect(variantDraft(variant({ mrpPaise: null }))).toEqual({
      sku: 'APX-1L',
      packSize: '1',
      unit: 'l',
      mrp: '',
      sellingPrice: '450.00',
      barcodes: '8901234567890',
      isActive: true,
    });
  });
});
