import {
  isValidBarcode,
  isValidGstin,
  isValidHsn,
  isValidPan,
  isValidPincode,
  panFromGstin,
} from '@paint/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogue,
  CATEGORIES,
  LINES,
  lineCode,
  mrpPaise,
  packLabel,
  subcategoryFor,
  toolSizes,
  type ProductPlan,
} from './catalogue.js';
import {
  ANDHRA_PRADESH,
  gstinFor,
  internalEan13,
  LOCALITIES,
  panFor,
  PhoneBook,
  TELANGANA,
} from './identity.js';
import { buildPlan, nearestStore, surname, type DemoPlan } from './plan.js';
import {
  openingQuantity,
  purchaseQuantity,
  reorderLevels,
  schemeFreeQuantity,
} from './quantities.js';
import { Random } from './random.js';

const full = buildPlan('full');
const small = buildPlan('small');
const variantsOf = (plan: DemoPlan) => plan.catalogue.flatMap((product) => product.variants);

describe('Random', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = new Random(7);
    const b = new Random(7);
    const draws = (random: Random) => [
      random.next(),
      random.int(1, 6),
      random.digits(4),
      random.letters(3),
    ];
    expect(draws(a)).toEqual(draws(b));
    expect(new Random(8).next()).not.toBe(new Random(7).next());
  });

  it('stays within its ranges', () => {
    const random = new Random(1);
    for (let index = 0; index < 500; index++) {
      const value = random.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
      expect(random.next()).toBeLessThan(1);
    }
    expect(random.digits(6)).toMatch(/^\d{6}$/);
    expect(random.letters(4)).toMatch(/^[A-Z]{4}$/);
    expect([true, false]).toContain(random.chance(0.5));
  });

  it('samples and shuffles without losing or repeating anything', () => {
    const random = new Random(3);
    const items = [1, 2, 3, 4, 5, 6];
    expect(random.shuffle(items).sort()).toEqual(items);
    const sample = random.sample(items, 4);
    expect(new Set(sample).size).toBe(4);
    expect(random.pick(['only'])).toBe('only');
    expect(() => random.pick([])).toThrow('empty');
  });
});

describe('identity', () => {
  it('builds GSTINs that pass the GSTN checksum, in Telangana, around the PAN', () => {
    const random = new Random(11);
    for (const holder of ['P', 'F', 'C'] as const) {
      const pan = panFor(random, 'Sharma Paints', holder);
      expect(isValidPan(pan)).toBe(true);
      expect(pan.charAt(3)).toBe(holder);
      expect(pan.charAt(4)).toBe('S');
      const gstin = gstinFor(pan);
      expect(isValidGstin(gstin)).toBe(true);
      expect(gstin.startsWith(TELANGANA)).toBe(true);
      expect(panFromGstin(gstin)).toBe(pan);
    }
    expect(panFor(new Random(1), '123', 'F').charAt(4)).toBe('X');
  });

  it('hands out distinct Indian mobile numbers', () => {
    const phones = new PhoneBook(new Random(2));
    const seen = Array.from({ length: 300 }, () => phones.next());
    expect(new Set(seen).size).toBe(300);
    for (const phone of seen) expect(phone).toMatch(/^\+919\d{9}$/);
  });

  it('makes in-store EAN-13 barcodes with a valid check digit', () => {
    for (const sequence of [1, 2, 42, 999, 123_456]) {
      const code = internalEan13(sequence);
      expect(code).toMatch(/^2\d{12}$/);
      expect(isValidBarcode(code)).toBe(true);
    }
  });

  it('finds surnames and the nearest store', () => {
    expect(surname('Venkat Reddy')).toBe('Reddy');
    expect(nearestStore(LOCALITIES[0])).toBe('AMP');
    expect(nearestStore(LOCALITIES[7])).toBe('KPL');
    expect(nearestStore(LOCALITIES[11])).toBe('SEC');
  });
});

describe('catalogue', () => {
  const check = (products: readonly ProductPlan[]) => {
    const variants = products.flatMap((product) => product.variants);
    expect(new Set(variants.map((variant) => variant.sku)).size).toBe(variants.length);
    expect(new Set(variants.map((variant) => variant.barcode)).size).toBe(variants.length);
    for (const product of products) {
      const spec = CATEGORIES[product.category];
      // Tools come as single pieces in labelled sizes; paint in the category's packs.
      const sized = product.category === 'tools';
      expect(product.variants.map((variant) => variant.packSize)).toEqual(
        sized ? product.variants.map(() => 1) : spec.packs,
      );
      expect(product.type).toBe(spec.type);
      expect(product.taxCategory).toBe(spec.taxCategory);
      expect(isValidHsn(product.hsnCode)).toBe(true);
      // Paint by the litre has a coverage; putty (by the kg) and tools have no paint fields.
      expect(product.paint.coverageSqftPerLitre !== null).toBe(spec.unit === 'l');
      if (product.paint.isTintable) expect(spec.unit).toBe('l');
      for (const variant of product.variants) {
        expect(variant.unit).toBe(spec.unit);
        expect(isValidBarcode(variant.barcode)).toBe(true);
        expect(variant.sku).toMatch(/^[A-Z0-9][A-Z0-9._/-]{1,39}$/);
        // Money is whole paise; MRPs end in ₹5 steps; dealers sell under MRP and above cost.
        for (const paise of [variant.mrpPaise, variant.sellingPricePaise, variant.costPaise]) {
          expect(Number.isInteger(paise)).toBe(true);
        }
        expect(variant.mrpPaise % 500).toBe(0);
        expect(variant.sellingPricePaise).toBeLessThanOrEqual(variant.mrpPaise);
        expect(variant.sellingPricePaise).toBeGreaterThan(variant.costPaise);
        expect(variant.costPaise).toBeGreaterThan(0);
      }
      // A bigger pack costs more in all, but less per litre or kg.
      for (let index = 1; !sized && index < product.variants.length; index++) {
        const [smaller, bigger] = [product.variants[index - 1], product.variants[index]];
        if (!smaller || !bigger) continue;
        expect(bigger.mrpPaise).toBeGreaterThan(smaller.mrpPaise);
        expect(bigger.mrpPaise / bigger.packSize).toBeLessThanOrEqual(
          smaller.mrpPaise / smaller.packSize,
        );
      }
    }
  };

  it('has every brand and category with sane packs and prices', () => {
    check(full.catalogue);
    expect(full.catalogue).toHaveLength(LINES.length);
    expect(new Set(full.catalogue.map((p) => p.brand)).size).toBe(6);
    expect(new Set(full.catalogue.map((p) => p.category))).toEqual(
      new Set(Object.keys(CATEGORIES)),
    );
    expect(variantsOf(full).length).toBeGreaterThan(250);
  });

  it('keeps every brand and category in the small catalogue', () => {
    check(small.catalogue);
    expect(new Set(small.catalogue.map((p) => p.brand)).size).toBe(6);
    expect(new Set(small.catalogue.map((p) => p.category)).size).toBe(
      Object.keys(CATEGORIES).length,
    );
    expect(small.catalogue.length).toBeLessThan(full.catalogue.length / 2);
  });

  it('prices a 20-litre bucket of a ₹500/litre emulsion like a shop would', () => {
    expect(mrpPaise(500, 20, 'l')).toBe(9_000_00);
    expect(mrpPaise(500, 1, 'l')).toBe(500_00);
    expect(mrpPaise(32, 20, 'kg')).toBe(575_00);
    expect(mrpPaise(95, 1, 'piece')).toBe(95_00);
    expect(() => mrpPaise(500, 3, 'l')).toThrow('No price factor');
  });

  it('puts tools in subcategories and names SKUs from the line', () => {
    const brushes = full.catalogue.filter((product) => product.subcategory === 'Brushes');
    expect(brushes.length).toBeGreaterThan(0);
    expect(
      full.catalogue.filter((p) => p.category !== 'tools').every((p) => p.subcategory === null),
    ).toBe(true);
    expect(lineCode('Royale Luxury Emulsion')).toBe('RLE');
    expect(lineCode('Flat Brush 2 inch')).toBe('FB2I');
    expect(lineCode('Luxol Hi-Gloss Enamel')).toBe('LHGE');
    expect(packLabel(0.5, 'l')).toBe('500ML');
    expect(packLabel(20, 'kg')).toBe('20KG');
    expect(packLabel(1, 'piece')).toBe('PC');
  });

  it('sells hardware as one product with a labelled single piece per size', () => {
    const sizes = (name: string) =>
      full.catalogue
        .find((product) => product.name === name)
        ?.variants.map(({ label, packSize, unit }) => [label, packSize, unit].join(' '));
    expect(sizes('Flat Paint Brush')).toEqual([
      '1 inch 1 piece',
      '2 inch 1 piece',
      '3 inch 1 piece',
      '4 inch 1 piece',
    ]);
    expect(sizes('Paint Roller')).toEqual(['7 inch 1 piece', '9 inch 1 piece']);
    expect(sizes('Sandpaper Sheet')).toEqual([
      'Grit 80 1 piece',
      'Grit 120 1 piece',
      'Grit 180 1 piece',
      'Grit 220 1 piece',
    ]);
    expect(sizes('Masking Tape')).toEqual(['24 mm 1 piece', '48 mm 1 piece']);
    const tape = full.catalogue.find((product) => product.name === 'Masking Tape');
    expect(tape?.subcategory).toBe('Tapes');
    expect(tape?.variants.map((variant) => variant.sku)).toEqual(['BG-MT-24M', 'BG-MT-48M']);
    expect(toolSizes('Exterior Emulsion')).toBeUndefined();
    expect(subcategoryFor('interior', 'Royale Brush Finish')).toBeNull();
    expect(subcategoryFor('tools', 'Sandpaper Sheet')).toBe('Sandpaper');
    // Paint packs carry no label.
    expect(
      full.catalogue
        .filter((product) => product.category !== 'tools')
        .every((product) => product.variants.every((variant) => variant.label === null)),
    ).toBe(true);
  });

  it('is the same every time', () => {
    expect(buildCatalogue(new Random(5))).toEqual(buildCatalogue(new Random(5)));
  });
});

describe('plan', () => {
  it('is deterministic', () => {
    expect(buildPlan('full')).toEqual(full);
    expect(buildPlan('full', 99)).not.toEqual(full);
  });

  it('has three Hyderabad branches sharing the business GSTIN', () => {
    expect(full.stores.map((store) => store.name)).toEqual([
      'Ameerpet',
      'Kukatpally',
      'Secunderabad',
    ]);
    expect(new Set(full.stores.map((store) => store.gstin)).size).toBe(1);
    expect(isValidGstin(full.stores[0]?.gstin ?? '')).toBe(true);
    expect(full.stores[0]?.gstin.startsWith(TELANGANA)).toBe(true);
  });

  it('has a couple of customers in Andhra Pradesh for inter-state sales', () => {
    for (const plan of [full, small]) {
      const andhra = plan.parties.filter((party) => party.stateCode === ANDHRA_PRADESH);
      expect(andhra.map((party) => [party.key, party.city])).toEqual([
        ['retail-1', 'Guntur'],
        ['builder-1', 'Vijayawada'],
      ]);
      const builder = andhra.find((party) => party.key === 'builder-1');
      expect(builder?.gstin?.startsWith(ANDHRA_PRADESH)).toBe(true);
      expect(isValidGstin(builder?.gstin ?? '')).toBe(true);
      expect(andhra.find((party) => party.key === 'retail-1')?.gstin).toBeNull();
      const others = plan.parties.filter((party) => party.stateCode !== ANDHRA_PRADESH);
      expect(
        others.every((party) => party.stateCode === TELANGANA && party.city === 'Hyderabad'),
      ).toBe(true);
    }
  });

  it('has a team in every role with unique mobiles', () => {
    const team = [full.owner, ...full.team];
    expect(new Set(team.map((person) => person.phone)).size).toBe(team.length);
    expect(new Set(team.map((person) => person.roleKey))).toEqual(
      new Set([
        'owner',
        'org_admin',
        'branch_manager',
        'inventory_manager',
        'sales_executive',
        'crm_executive',
        'store_employee',
      ]),
    );
    expect(team.filter((person) => person.twoFactor)).toHaveLength(1);
    expect(
      team.filter((person) => !person.hasPassword).every((p) => p.roleKey === 'store_employee'),
    ).toBe(true);
  });

  it('has 60–100 parties with valid GSTINs, PIN codes and unique mobiles', () => {
    for (const plan of [full, small]) {
      const phones = [
        ...plan.parties.map((party) => party.phone),
        ...[plan.owner, ...plan.team].map((person) => person.phone),
      ];
      expect(new Set(phones).size).toBe(phones.length);
      for (const party of plan.parties) {
        expect(isValidPincode(party.pincode)).toBe(true);
        if (party.gstin !== null) expect(isValidGstin(party.gstin)).toBe(true);
        if (party.kind === 'person') expect(party.gstin).toBeNull();
      }
      const gstins = plan.parties.flatMap((party) => (party.gstin ? [party.gstin] : []));
      expect(new Set(gstins).size).toBe(gstins.length);
    }
    const customers = full.parties.filter((party) => party.segment !== 'supplier');
    expect(customers.length).toBeGreaterThanOrEqual(60);
    expect(customers.length).toBeLessThanOrEqual(100);
    expect(
      full.parties.filter((party) => party.segment === 'supplier').map((p) => p.brand),
    ).toHaveLength(6);
  });

  it('includes two near-duplicates pointing at their originals', () => {
    const duplicates = full.parties.filter((party) => party.duplicateOf !== null);
    expect(duplicates).toHaveLength(2);
    for (const duplicate of duplicates) {
      const original = full.parties.find((party) => party.key === duplicate.duplicateOf);
      expect(original).toBeDefined();
      expect(duplicate.alternatePhone).toBe(original?.phone);
      expect(duplicate.displayName).not.toBe(original?.displayName);
      expect(duplicate.gstin).toBeNull();
    }
  });
});

describe('quantities', () => {
  const random = new Random(4);
  it('keeps more small tins than big buckets', () => {
    for (let index = 0; index < 50; index++) {
      expect(openingQuantity(random, { packSize: 1, unit: 'l' })).toBeGreaterThanOrEqual(12);
      expect(openingQuantity(random, { packSize: 20, unit: 'l' })).toBeLessThanOrEqual(12);
      expect(openingQuantity(random, { packSize: 4, unit: 'l' })).toBeLessThanOrEqual(30);
      expect(openingQuantity(random, { packSize: 10, unit: 'l' })).toBeLessThanOrEqual(16);
      expect(openingQuantity(random, { packSize: 1, unit: 'piece' })).toBeGreaterThanOrEqual(10);
    }
  });

  it('orders whole cartons', () => {
    expect([12, 24]).toContain(purchaseQuantity(random, { packSize: 1, unit: 'l' }));
    expect([12, 24]).toContain(purchaseQuantity(random, { packSize: 1, unit: 'piece' }));
    expect([6, 12]).toContain(purchaseQuantity(random, { packSize: 4, unit: 'l' }));
    expect([4, 8]).toContain(purchaseQuantity(random, { packSize: 10, unit: 'l' }));
    expect(purchaseQuantity(random, { packSize: 20, unit: 'l' })).toBeLessThanOrEqual(6);
  });

  it('sets minimum ≤ reorder level ≤ maximum, all positive', () => {
    for (const usual of [1, 3, 10, 48]) {
      const levels = reorderLevels(usual);
      expect(levels.minQuantity).toBeGreaterThanOrEqual(1);
      expect(levels.minQuantity).toBeLessThan(levels.reorderLevel);
      expect(levels.reorderLevel).toBeLessThan(levels.maxQuantity);
    }
    expect(schemeFreeQuantity(24)).toBe(2);
    expect(schemeFreeQuantity(11)).toBe(0);
  });
});
