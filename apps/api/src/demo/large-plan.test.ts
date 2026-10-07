import { isValidBarcode, isValidGstin } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { BRAND_CODES } from './catalogue.js';
import {
  buildLargeCatalogue,
  buildLargeParties,
  EXTRA_BRANDS,
  EXTRA_STORES,
  LARGE_SCALE,
  LARGE_SHAPED_TEST_SCALE,
  weighted,
} from './large-plan.js';
import { Random } from './random.js';

const brands: [string, string][] = [
  ...Object.entries(BRAND_CODES),
  ...EXTRA_BRANDS.map(([name, code]): [string, string] => [name, code]),
];

describe('the large shop', () => {
  it('is about 10,000 products and pack sizes, 5,000 parties and 100,000 ledger entries', () => {
    expect(LARGE_SCALE).toMatchObject({ parties: 5_000, ledgerEntries: 100_000 });
    // 3 to 10 stores in all, within the standard plan's limit.
    expect(3 + LARGE_SCALE.extraStores).toBeLessThanOrEqual(10);
    expect(LARGE_SCALE.extraStores).toBeLessThanOrEqual(EXTRA_STORES.length);
    // The test's shape keeps every kind of row, just fewer of each (the share stocked is a ratio).
    const { stockedShare: _share, ...sizes } = LARGE_SHAPED_TEST_SCALE;
    for (const [key, value] of Object.entries(sizes)) {
      expect(value, key).toBeGreaterThan(0);
      expect(value, key).toBeLessThanOrEqual(LARGE_SCALE[key as keyof typeof LARGE_SCALE]);
    }
  });

  it('picks values as often as their weights say', () => {
    const random = new Random(1);
    const picks = Array.from({ length: 4_000 }, () =>
      weighted(random, [
        ['a', 3],
        ['b', 1],
      ] as const),
    );
    const share = picks.filter((pick) => pick === 'a').length / picks.length;
    expect(share).toBeGreaterThan(0.72);
    expect(share).toBeLessThan(0.78);
    expect(weighted(new Random(2), [['only', 1]] as const)).toBe('only');
  });

  it('builds a deterministic catalogue with unique SKUs, valid barcodes and sane prices', () => {
    const catalogue = buildLargeCatalogue(new Random(7), 2_000, brands);
    expect(buildLargeCatalogue(new Random(7), 2_000, brands)).toEqual(catalogue);
    const variants = catalogue.flatMap((product) => product.variants);
    // About two pack sizes a product.
    expect(variants.length / catalogue.length).toBeGreaterThan(1.6);
    expect(variants.length / catalogue.length).toBeLessThan(2.4);
    expect(new Set(variants.map((variant) => variant.sku)).size).toBe(variants.length);
    expect(new Set(variants.map((variant) => variant.barcode)).size).toBe(variants.length);
    expect(variants.every((variant) => isValidBarcode(variant.barcode))).toBe(true);
    expect(variants.every((variant) => /^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(variant.sku))).toBe(
      true,
    );
    expect(
      variants.every(
        (variant) =>
          variant.costPaise < variant.sellingPricePaise &&
          variant.sellingPricePaise <= variant.mrpPaise,
      ),
    ).toBe(true);
    // Names are unique within a brand, as the database requires.
    expect(new Set(catalogue.map((product) => `${product.brand}:${product.name}`)).size).toBe(
      catalogue.length,
    );
    expect(new Set(catalogue.map((product) => product.brand)).size).toBe(brands.length);
    const tools = catalogue.filter((product) => product.category === 'tools');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((product) => product.subcategory !== null)).toBe(true);
    // Tools are labelled single pieces (brush widths, grits); paint packs have no label.
    for (const product of catalogue) {
      const labelled = product.variants.every(
        (variant) => variant.label !== null && variant.packSize === 1 && variant.unit === 'piece',
      );
      expect(labelled, product.name).toBe(product.category === 'tools');
    }
    expect(new Set(tools.map((product) => product.subcategory))).toEqual(
      new Set(['Brushes', 'Rollers', 'Sandpaper', 'Tapes']),
    );
    expect(
      catalogue
        .filter((product) => product.category !== 'tools')
        .every((p) => p.subcategory === null),
    ).toBe(true);
  });

  it('builds parties of every kind with unique mobiles and valid, unused GSTINs', () => {
    const used = new Set<string>();
    const parties = buildLargeParties(new Random(9), 3_000, 8, used);
    expect(new Set(parties.map((party) => party.phone)).size).toBe(parties.length);
    expect(parties.every((party) => /^\+917\d{9}$/.test(party.phone))).toBe(true);
    const gstins = parties.flatMap((party) => party.gstin ?? []);
    expect(gstins.length).toBeGreaterThan(200);
    expect(new Set(gstins).size).toBe(gstins.length);
    expect(gstins.every((gstin) => isValidGstin(gstin))).toBe(true);
    expect(used.size).toBe(gstins.length);
    const segments = new Set(parties.map((party) => party.segment));
    expect([...segments].sort()).toEqual([
      'architect',
      'builder',
      'contractor',
      'dealer',
      'painter',
      'retail',
      'supplier',
    ]);
    const names = parties.map((party) => party.displayName);
    expect(names.some((name) => name.startsWith('Studio '))).toBe(true);
    expect(names.some((name) => name.startsWith('Ar. '))).toBe(true);
    // Suppliers and architects work with the whole business; everyone else has a home store.
    for (const party of parties) {
      const businessWide = party.segment === 'supplier' || party.segment === 'architect';
      expect(party.homeStore === null).toBe(businessWide);
      expect(party.homeStore ?? 0).toBeLessThan(8);
      expect(party.customerType === null).toBe(businessWide);
    }
  });

  it('never hands out a GSTIN that is already taken', () => {
    const [first] = buildLargeParties(new Random(11), 40, 3, new Set()).flatMap(
      (party) => party.gstin ?? [],
    );
    const taken = new Set([String(first)]);
    const again = buildLargeParties(new Random(11), 40, 3, taken);
    expect(again.map((party) => party.gstin)).not.toContain(first);
  });
});
