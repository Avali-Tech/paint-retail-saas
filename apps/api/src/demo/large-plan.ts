import {
  CATEGORIES,
  lineCode,
  mrpPaise,
  packLabel,
  packPrices,
  subcategoryFor,
  toolSizes,
  type CategoryKey,
} from './catalogue.js';
import {
  gstinFor,
  internalEan13,
  LOCALITIES,
  panFor,
  personName,
  STREETS,
  type PanHolder,
} from './identity.js';
import { surname, type CustomerType, type PartyRole, type Segment } from './plan.js';
import type { Random } from './random.js';

/**
 * How big the large shop is (`DEMO_SIZE=large`, for performance testing, not
 * client demos). It is added on top of the full demo's story, in bulk.
 */
export interface LargeScale {
  /** Stores opened besides the demo's three (each with a manager and a salesperson). */
  readonly extraStores: number;
  readonly products: number;
  readonly parties: number;
  /** About how many stock ledger entries: opening stock, receipts, sales and write-offs. */
  readonly ledgerEntries: number;
  /** Share of products each store stocks. */
  readonly stockedShare: number;
  readonly purchaseOrders: number;
  readonly leads: number;
  readonly projects: number;
  readonly activities: number;
  readonly documents: number;
  readonly notifications: number;
  readonly loyaltyAccounts: number;
  readonly loyaltyEntries: number;
  /** How many days back the bulk history goes. */
  readonly historyDays: number;
  /** Other (small) businesses onboarded from the platform console, for its list of businesses. */
  readonly otherBusinesses: number;
}

/** The large shop: about 10,000 products and pack sizes, 5,000 parties and 100,000 ledger entries. */
export const LARGE_SCALE: LargeScale = {
  extraStores: 5,
  products: 5_000,
  parties: 5_000,
  ledgerEntries: 100_000,
  stockedShare: 0.4,
  purchaseOrders: 2_500,
  leads: 6_000,
  projects: 800,
  activities: 30_000,
  documents: 5_000,
  notifications: 15_000,
  loyaltyAccounts: 1_500,
  loyaltyEntries: 15_000,
  historyDays: 180,
  otherBusinesses: 150,
};

/** The same shape at about 1/50 of the size, for the integration test. */
export const LARGE_SHAPED_TEST_SCALE: LargeScale = {
  extraStores: 2,
  products: 100,
  parties: 120,
  ledgerEntries: 2_000,
  stockedShare: 0.5,
  purchaseOrders: 50,
  leads: 120,
  projects: 20,
  activities: 600,
  documents: 100,
  notifications: 300,
  loyaltyAccounts: 30,
  loyaltyEntries: 300,
  historyDays: 30,
  otherBusinesses: 3,
};

/** Stores the large shop can open, by code. */
export const EXTRA_STORES = [
  { code: 'MDP', name: 'Madhapur' },
  { code: 'MYP', name: 'Miyapur' },
  { code: 'MLK', name: 'Malkajgiri' },
  { code: 'KMP', name: 'Kompally' },
  { code: 'BJH', name: 'Banjara Hills' },
  { code: 'TRN', name: 'Tarnaka' },
  { code: 'GCB', name: 'Gachibowli' },
] as const;

/** Brands a large dealer stocks besides the demo's six, with their SKU codes. */
export const EXTRA_BRANDS = [
  ['Nippon Paint', 'NP'],
  ['Jotun', 'JT'],
  ['Kansai', 'KS'],
  ['JSW Paints', 'JS'],
  ['Shalimar', 'SH'],
  ['British Paints', 'BP'],
  ['Sheenlac', 'SL'],
  ['Dr. Fixit', 'DF'],
  ['Snowcem', 'SC'],
  ['Esdee', 'ED'],
  ['MRF Vapocure', 'MV'],
  ['Sirca', 'SR'],
  ['Pidilite', 'PD'],
  ['Astral', 'AS'],
] as const;

const SERIES = [
  'Silk',
  'Shield',
  'Weather',
  'Aqua',
  'Ultra',
  'Prime',
  'Royal',
  'Eco',
  'Max',
  'Supreme',
  'Velvet',
  'Classic',
  'Gloss',
  'Matt',
  'Pro',
  'Duro',
  'Sheen',
  'Satin',
  'Easy',
  'Hydro',
] as const;

const CATEGORY_WORDS: Readonly<Record<CategoryKey, readonly string[]>> = {
  interior: ['Interior Emulsion', 'Luxury Emulsion', 'Wall Finish'],
  exterior: ['Exterior Emulsion', 'Weathercoat', 'Exterior Finish'],
  enamel: ['Gloss Enamel', 'Satin Enamel', 'Synthetic Enamel'],
  primer: ['Wall Primer', 'Metal Primer', 'Cement Primer'],
  putty: ['Wall Putty', 'Acrylic Putty'],
  wood: ['Melamine', 'PU Finish', 'Wood Stain'],
  waterproofing: ['Damp Proof', 'Roof Coat', 'Waterproof Coat'],
  tools: ['Flat Brush', 'Paint Roller', 'Masking Tape', 'Sandpaper'],
};

/** Weights for each category: emulsions sell most. */
const CATEGORY_WEIGHTS: Weights<CategoryKey> = [
  ['interior', 26],
  ['exterior', 18],
  ['enamel', 12],
  ['primer', 12],
  ['putty', 8],
  ['wood', 8],
  ['waterproofing', 8],
  ['tools', 8],
];

type Weights<T> = readonly [readonly [T, number], ...(readonly [T, number])[]];

/** Picks one value, each as likely as its weight. */
export function weighted<T>(random: Random, entries: Weights<T>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random.next() * total;
  let [chosen] = entries[0];
  for (const [value, weight] of entries) {
    chosen = value;
    roll -= weight;
    if (roll < 0) break;
  }
  return chosen;
}

export interface LargeVariantPlan {
  readonly sku: string;
  readonly packSize: number;
  readonly unit: 'l' | 'kg' | 'piece';
  readonly label: string | null;
  readonly mrpPaise: number;
  readonly sellingPricePaise: number;
  readonly costPaise: number;
  readonly barcode: string;
}

export interface LargeProductPlan {
  /** The brand's name. */
  readonly brand: string;
  readonly category: CategoryKey;
  readonly subcategory: string | null;
  readonly name: string;
  readonly type: (typeof CATEGORIES)[CategoryKey]['type'];
  readonly hsnCode: string;
  readonly variants: readonly LargeVariantPlan[];
}

/**
 * Product families with one to four pack sizes each (about two on average),
 * prices as Indian dealers charge, and barcodes after the demo's own.
 */
export function buildLargeCatalogue(
  random: Random,
  count: number,
  brands: readonly (readonly [name: string, code: string])[],
): LargeProductPlan[] {
  let barcode = 100_000;
  return Array.from({ length: count }, (_, index): LargeProductPlan => {
    const [brand, code] = random.pick(brands);
    const category = weighted(random, CATEGORY_WEIGHTS);
    const spec = CATEGORIES[category];
    const word = random.pick(CATEGORY_WORDS[category]);
    const name = `${random.pick(SERIES)} ${word} ${String(1_000 + index)}`;
    const base = `L${code}${String(index).padStart(5, '0')}`;
    const variant = (packSize: number, label: string | null, mrp: number): LargeVariantPlan => {
      barcode += 1;
      return {
        sku: `${base}-${label === null ? packLabel(packSize, spec.unit) : lineCode(label)}`,
        packSize,
        unit: spec.unit,
        label,
        mrpPaise: mrp,
        ...packPrices(random, mrp),
        barcode: internalEan13(barcode),
      };
    };
    // Tools come in labelled sizes (brush widths, grits); paint in pack sizes.
    const sizes = toolSizes(word);
    let variants: LargeVariantPlan[];
    if (sizes) {
      variants = random
        .sample(sizes, Math.min(sizes.length, random.int(1, 3)))
        .sort((a, b) => sizes.indexOf(a) - sizes.indexOf(b))
        .map(([label, rupees]) => variant(1, label, mrpPaise(rupees, 1, 'piece')));
    } else {
      const packs = random
        .sample(spec.packs, Math.min(spec.packs.length, random.int(1, 3)))
        .sort((a, b) => a - b);
      const rupeesPerUnit = random.int(120, 900);
      variants = packs.map((packSize) =>
        variant(packSize, null, mrpPaise(rupeesPerUnit, packSize, spec.unit)),
      );
    }
    return {
      brand,
      category,
      subcategory: subcategoryFor(category, word),
      name,
      type: spec.type,
      hsnCode: spec.hsnCode,
      variants,
    };
  });
}

export interface LargePartyPlan {
  readonly segment: Segment;
  readonly kind: 'person' | 'organization';
  readonly displayName: string;
  readonly legalName: string | null;
  readonly contactPerson: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly gstin: string | null;
  readonly addressLine: string;
  readonly pincode: string;
  /** Index into the business's stores; null for business-wide parties. */
  readonly homeStore: number | null;
  readonly roles: readonly PartyRole[];
  readonly customerType: CustomerType | null;
  readonly tags: readonly string[];
}

const SEGMENT_SHARES: Weights<Segment> = [
  ['retail', 62],
  ['painter', 14],
  ['contractor', 10],
  ['architect', 3],
  ['builder', 2],
  ['dealer', 7],
  ['supplier', 2],
];

const ORGANIZATION_STYLES: Readonly<Partial<Record<Segment, readonly string[]>>> = {
  contractor: ['Constructions', 'Painting Works', 'Interiors', 'Builders & Painters'],
  builder: ['Developers', 'Infra Projects', 'Homes', 'Estates'],
  dealer: ['Paint House', 'Hardware & Paints', 'Colour World', 'Paints & Sanitary'],
  supplier: ['Agencies', 'Distributors', 'Paint Traders', 'Trading Company'],
};

/**
 * Parties of every kind in realistic proportions. Mobile numbers start with 7
 * (the demo's own start with 9), so they never clash; GSTINs avoid `usedGstins`.
 */
export function buildLargeParties(
  random: Random,
  count: number,
  storeCount: number,
  usedGstins: Set<string>,
): LargePartyPlan[] {
  return Array.from({ length: count }, (_, index): LargePartyPlan => {
    const segment = weighted(random, SEGMENT_SHARES);
    const person = personName(random);
    const locality = random.pick(LOCALITIES);
    const styles = ORGANIZATION_STYLES[segment];
    const studio = segment === 'architect' && index % 2 === 0;
    const organization = styles !== undefined || studio;
    let displayName = person;
    if (styles !== undefined) {
      displayName = `${random.pick([surname(person), locality.area, 'Sri Sai', 'Balaji'])} ${random.pick(styles)}`;
    } else if (studio) {
      displayName = `Studio ${surname(person)} Architects`;
    } else if (segment === 'architect') {
      displayName = `Ar. ${person}`;
    }
    const holder: PanHolder | null = organization ? random.pick(['C', 'F'] as const) : null;
    let gstin: string | null = null;
    if (holder !== null && random.chance(0.8)) {
      do gstin = gstinFor(panFor(random, displayName, holder));
      while (usedGstins.has(gstin));
      usedGstins.add(gstin);
    }
    const businessWide = segment === 'supplier' || segment === 'architect';
    return {
      segment,
      kind: organization ? 'organization' : 'person',
      displayName,
      legalName:
        gstin === null ? null : `${displayName} ${holder === 'C' ? 'Private Limited' : 'LLP'}`,
      contactPerson: organization ? person : null,
      phone: `+917${random.digits(3)}${String(index).padStart(6, '0')}`,
      email: random.chance(0.3)
        ? `${person.toLowerCase().replace(/[^a-z]+/g, '.')}.${String(index)}@example.in`
        : null,
      gstin,
      addressLine: `${String(random.int(1, 999))}-${String(random.int(1, 99))}, ${random.pick(STREETS)}, ${locality.area}`,
      pincode: locality.pincode,
      homeStore: businessWide ? null : random.int(0, storeCount - 1),
      roles: ROLES[segment],
      customerType: CUSTOMER_TYPES[segment],
      tags: segment === 'retail' && random.chance(0.2) ? ['repeat'] : [],
    };
  });
}

const ROLES: Readonly<Record<Segment, readonly PartyRole[]>> = {
  retail: ['customer'],
  painter: ['painter', 'customer'],
  contractor: ['contractor', 'customer'],
  architect: ['architect'],
  builder: ['customer'],
  dealer: ['dealer', 'customer'],
  supplier: ['supplier'],
};

const CUSTOMER_TYPES: Readonly<Record<Segment, CustomerType | null>> = {
  retail: 'retail',
  painter: 'painter',
  contractor: 'contractor',
  architect: null,
  builder: 'builder',
  dealer: 'dealer',
  supplier: null,
};
