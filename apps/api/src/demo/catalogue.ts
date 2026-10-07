import { internalEan13 } from './identity.js';
import type { Random } from './random.js';

/** Brands with the short code used in SKUs. */
export const BRAND_CODES = {
  'Asian Paints': 'AP',
  Berger: 'BG',
  Nerolac: 'NL',
  Dulux: 'DX',
  Indigo: 'IG',
  'Birla Opus': 'BO',
} as const;
export type BrandName = keyof typeof BRAND_CODES;
export const BRAND_NAMES = Object.keys(BRAND_CODES) as BrandName[];

type ProductType =
  | 'interior_paint'
  | 'exterior_paint'
  | 'primer'
  | 'putty'
  | 'enamel'
  | 'wood_finish'
  | 'waterproofing'
  | 'tool';
type Unit = 'l' | 'kg' | 'piece';
/** Keys of the tax categories every business starts with (migration 0052). */
export type DemoTaxCategory = 'paints' | 'varnishes' | 'putty' | 'brushes_rollers';

interface CategorySpec {
  readonly name: string;
  readonly type: ProductType;
  /** HSN headings: paints 3208 (solvent-based) and 3209 (water-based), putty 3214, brushes and rollers 9603. */
  readonly hsnCode: string;
  readonly taxCategory: DemoTaxCategory;
  readonly unit: Unit;
  readonly packs: readonly number[];
  /** Subcategories, by keyword in the product name. */
  readonly subcategories?: readonly { readonly name: string; readonly keyword: string }[];
}

/** A hardware size sold by the piece: its label and MRP in rupees. */
export type ToolSize = readonly [label: string, rupees: number];

/**
 * Hardware is one product with a variant per size, each a single piece told apart by its
 * label: a 2 inch and a 3 inch brush, sandpaper grits, tape widths. Keyed by the keyword
 * that also picks the subcategory.
 */
export const TOOL_SIZES: Readonly<Record<string, readonly ToolSize[]>> = {
  Brush: [
    ['1 inch', 60],
    ['2 inch', 95],
    ['3 inch', 130],
    ['4 inch', 190],
  ],
  Roller: [
    ['7 inch', 260],
    ['9 inch', 340],
  ],
  Sandpaper: [
    ['Grit 80', 15],
    ['Grit 120', 15],
    ['Grit 180', 15],
    ['Grit 220', 20],
  ],
  Tape: [
    ['24 mm', 45],
    ['48 mm', 85],
  ],
};

export const CATEGORIES = {
  interior: {
    name: 'Interior Emulsion',
    type: 'interior_paint',
    hsnCode: '3209',
    taxCategory: 'paints',
    unit: 'l',
    packs: [1, 4, 10, 20],
  },
  exterior: {
    name: 'Exterior Emulsion',
    type: 'exterior_paint',
    hsnCode: '3209',
    taxCategory: 'paints',
    unit: 'l',
    packs: [1, 4, 10, 20],
  },
  enamel: {
    name: 'Enamel',
    type: 'enamel',
    hsnCode: '3208',
    taxCategory: 'paints',
    unit: 'l',
    packs: [0.5, 1, 4],
  },
  primer: {
    name: 'Primer',
    type: 'primer',
    hsnCode: '3209',
    taxCategory: 'paints',
    unit: 'l',
    packs: [1, 4, 10, 20],
  },
  putty: {
    name: 'Putty',
    type: 'putty',
    hsnCode: '3214',
    taxCategory: 'putty',
    unit: 'kg',
    packs: [1, 5, 20, 40],
  },
  wood: {
    name: 'Wood Finish',
    type: 'wood_finish',
    hsnCode: '3208',
    taxCategory: 'varnishes',
    unit: 'l',
    packs: [0.5, 1, 4],
  },
  waterproofing: {
    name: 'Waterproofing',
    type: 'waterproofing',
    // Waterproofing coatings: 3824 (chemical preparations), 18% like paints.
    hsnCode: '3824',
    taxCategory: 'paints',
    unit: 'l',
    packs: [1, 4, 10, 20],
  },
  tools: {
    name: 'Tools',
    type: 'tool',
    hsnCode: '9603',
    taxCategory: 'brushes_rollers',
    unit: 'piece',
    packs: [1],
    subcategories: [
      { name: 'Brushes', keyword: 'Brush' },
      { name: 'Rollers', keyword: 'Roller' },
      { name: 'Sandpaper', keyword: 'Sandpaper' },
      { name: 'Tapes', keyword: 'Tape' },
    ],
  },
} as const satisfies Record<string, CategorySpec>;
export type CategoryKey = keyof typeof CATEGORIES;

/** A product family as sold in Indian paint shops, with its MRP per litre / kg / piece in rupees. */
interface Line {
  readonly brand: BrandName;
  readonly name: string;
  readonly category: CategoryKey;
  readonly rupeesPerUnit: number;
}

const line = (
  brand: BrandName,
  category: CategoryKey,
  entries: readonly (readonly [string, number])[],
): Line[] => entries.map(([name, rupeesPerUnit]) => ({ brand, name, category, rupeesPerUnit }));

export const LINES: readonly Line[] = [
  ...line('Asian Paints', 'interior', [
    ['Royale Luxury Emulsion', 620],
    ['Royale Glitz', 780],
    ['Apcolite Premium Emulsion', 420],
    ['Tractor Emulsion', 230],
    ['Tractor Uno', 160],
  ]),
  ...line('Asian Paints', 'exterior', [
    ['Apex Ultima', 520],
    ['Apex Weatherproof', 380],
    ['Ace Exterior Emulsion', 250],
    ['Ultima Protek', 760],
  ]),
  ...line('Asian Paints', 'enamel', [
    ['Apcolite Premium Gloss Enamel', 450],
    ['Tractor Synthetic Enamel', 300],
  ]),
  ...line('Asian Paints', 'primer', [
    ['Trucare Interior Wall Primer', 190],
    ['Trucare Exterior Wall Primer', 230],
    ['Red Oxide Metal Primer', 280],
  ]),
  ...line('Asian Paints', 'putty', [
    ['Trucare Wall Putty', 32],
    ['Trucare Acrylic Putty', 85],
  ]),
  ...line('Asian Paints', 'wood', [
    ['Woodtech Melamyne', 650],
    ['Woodtech PU Palette', 1100],
  ]),
  ...line('Asian Paints', 'waterproofing', [
    ['SmartCare Damp Proof', 420],
    ['SmartCare Hydroloc', 360],
    ['SmartCare Crack Seal', 240],
  ]),
  // Tools are priced per size (TOOL_SIZES), so their rupees per unit is unused.
  ...line('Asian Paints', 'tools', [
    ['Flat Paint Brush', 0],
    ['Paint Roller', 0],
    ['Sandpaper Sheet', 0],
  ]),
  ...line('Berger', 'interior', [
    ['Silk Glamor', 610],
    ['Easy Clean', 480],
    ['Rangoli Total Care', 320],
    ['Bison Acrylic Emulsion', 210],
  ]),
  ...line('Berger', 'exterior', [
    ['WeatherCoat Long Life', 720],
    ['WeatherCoat All Guard', 560],
    ['Walmasta', 230],
  ]),
  ...line('Berger', 'enamel', [
    ['Luxol Hi-Gloss Enamel', 430],
    ['Butterfly Enamel', 260],
  ]),
  ...line('Berger', 'primer', [
    ['Bison Wall Primer', 170],
    ['WeatherCoat Exterior Primer', 240],
  ]),
  ...line('Berger', 'putty', [['Berger Wall Putty', 30]]),
  ...line('Berger', 'wood', [['Imperia PU Wood Finish', 1050]]),
  ...line('Berger', 'waterproofing', [['Dampstop Advanced', 400]]),
  ...line('Berger', 'tools', [['Masking Tape', 0]]),
  ...line('Nerolac', 'interior', [
    ['Impressions HD', 640],
    ['Beauty Gold Washable', 360],
    ['Beauty Smooth Finish', 280],
    ['Pearls Emulsion', 220],
  ]),
  ...line('Nerolac', 'exterior', [
    ['Excel Total', 700],
    ['Excel Mica Marble', 520],
    ['Suraksha Exterior', 240],
  ]),
  ...line('Nerolac', 'enamel', [['Synthetic Hi-Gloss Enamel', 380]]),
  ...line('Nerolac', 'primer', [
    ['Nerolac Wall Primer', 170],
    ['Excel Exterior Primer', 230],
  ]),
  ...line('Nerolac', 'putty', [['Nerolac Wall Putty', 31]]),
  ...line('Dulux', 'interior', [
    ['Velvet Touch Pearl Glo', 650],
    ['Super Clean 3in1', 470],
    ['Promise Interior', 250],
  ]),
  ...line('Dulux', 'exterior', [
    ['Weathershield Max', 690],
    ['Weathershield Powerflexx', 760],
    ['Promise Exterior', 260],
  ]),
  ...line('Dulux', 'enamel', [['Dulux Gloss Enamel', 420]]),
  ...line('Dulux', 'primer', [
    ['Dulux Wall Primer', 180],
    ['Weathershield Exterior Primer', 240],
  ]),
  ...line('Dulux', 'putty', [['Dulux Wall Putty', 30]]),
  ...line('Dulux', 'waterproofing', [['Aquatech Waterproofing', 410]]),
  ...line('Indigo', 'interior', [
    ['Platinum Interior Emulsion', 560],
    ['Bright Ceiling Coat', 240],
  ]),
  ...line('Indigo', 'exterior', [
    ['Dirt Proof Exterior Emulsion', 610],
    ['Platinum Exterior Emulsion', 540],
  ]),
  ...line('Indigo', 'enamel', [['Indigo Satin Enamel', 400]]),
  ...line('Indigo', 'primer', [['Indigo Wall Primer', 170]]),
  ...line('Indigo', 'wood', [['Indigo PU Wood Coat', 980]]),
  ...line('Birla Opus', 'interior', [
    ['One Pure Elegance', 680],
    ['Calista Ever Wash', 480],
    ['Style Wash', 240],
  ]),
  ...line('Birla Opus', 'exterior', [
    ['One True Vision', 760],
    ['Calista Weather Guard', 540],
    ['Style Exterior', 250],
  ]),
  ...line('Birla Opus', 'enamel', [['Opus Gloss Enamel', 410]]),
  ...line('Birla Opus', 'primer', [
    ['Opus Interior Primer', 170],
    ['Opus Exterior Primer', 230],
  ]),
  ...line('Birla Opus', 'putty', [['Opus Wall Putty', 33]]),
  ...line('Birla Opus', 'waterproofing', [['Opus Damp Shield', 400]]),
];

/** Bigger packs cost less per litre or kg. */
export const PACK_PRICE_FACTOR: ReadonlyMap<number, number> = new Map([
  [0.5, 1.08],
  [1, 1],
  [4, 0.96],
  [5, 0.95],
  [10, 0.93],
  [20, 0.9],
  [40, 0.88],
]);

export interface VariantPlan {
  readonly sku: string;
  readonly packSize: number;
  readonly unit: Unit;
  /** What tells same-sized packs apart, e.g. "2 inch"; null for paint packs. */
  readonly label: string | null;
  readonly mrpPaise: number;
  readonly sellingPricePaise: number;
  /** What the dealer pays the distributor, per pack. */
  readonly costPaise: number;
  readonly barcode: string;
}

export interface ProductPlan {
  readonly brand: BrandName;
  readonly category: CategoryKey;
  /** Subcategory name, for tools. */
  readonly subcategory: string | null;
  readonly name: string;
  readonly type: ProductType;
  readonly hsnCode: string;
  readonly taxCategory: DemoTaxCategory;
  readonly variants: readonly VariantPlan[];
}

/** "Royale Luxury Emulsion" -> "RLE"; digits are kept ("Flat Brush 2 inch" -> "FB2I"). */
export function lineCode(name: string): string {
  return name
    .split(/[\s-]+/)
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0)))
    .join('')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** The sizes a tool comes in, by the keyword in its name ("Flat Paint Brush" -> brush sizes). */
export function toolSizes(name: string): readonly ToolSize[] | undefined {
  return Object.entries(TOOL_SIZES).find(([keyword]) => name.includes(keyword))?.[1];
}

/** The subcategory a product belongs in, by the keyword in its name; null outside tools. */
export function subcategoryFor(category: CategoryKey, name: string): string | null {
  const spec: CategorySpec = CATEGORIES[category];
  return spec.subcategories?.find((sub) => name.includes(sub.keyword))?.name ?? null;
}

/** Prices a pack as dealers do: 4–10 % under MRP to sell, 68–76 % of it to buy. */
export function packPrices(
  random: Random,
  mrp: number,
): { sellingPricePaise: number; costPaise: number } {
  return {
    sellingPricePaise: Math.round((mrp * random.int(90, 96)) / 10_000) * 100,
    costPaise: Math.round((mrp * random.int(68, 76)) / 10_000) * 100,
  };
}

/** "4" + "l" -> "4L"; 0.5 l -> "500ML". */
export function packLabel(packSize: number, unit: Unit): string {
  if (unit === 'piece') return 'PC';
  if (packSize < 1) return `${String(packSize * 1000)}ML`;
  return `${String(packSize)}${unit.toUpperCase()}`;
}

/** Rounds rupees to the nearest ₹5 and returns paise, as printed MRPs are. */
export function mrpPaise(rupeesPerUnit: number, packSize: number, unit: Unit): number {
  const factor = unit === 'piece' ? 1 : PACK_PRICE_FACTOR.get(packSize);
  if (factor === undefined) throw new Error(`No price factor for a ${String(packSize)} pack`);
  return Math.max(5, Math.round((rupeesPerUnit * packSize * factor) / 5) * 5) * 100;
}

/**
 * The catalogue: every line with its pack sizes, prices and barcodes. `every`
 * keeps one line in so many (the small demo for tests), always keeping at
 * least one line per category and per brand.
 */
export function buildCatalogue(random: Random, every = 1): ProductPlan[] {
  const kept = LINES.filter(
    (entry, index) =>
      index % every === 0 ||
      LINES.findIndex((other) => other.category === entry.category) === index ||
      LINES.findIndex((other) => other.brand === entry.brand) === index,
  );
  const usedSkus = new Set<string>();
  let barcode = 0;
  return kept.map((entry) => {
    const spec: CategorySpec = CATEGORIES[entry.category];
    let base = `${BRAND_CODES[entry.brand]}-${lineCode(entry.name)}`;
    while (usedSkus.has(base)) base = `${base}X`;
    usedSkus.add(base);
    const sizes = toolSizes(entry.name);
    const variants = sizes
      ? sizes.map(([label, rupees]): VariantPlan => {
          const mrp = mrpPaise(rupees, 1, 'piece');
          barcode += 1;
          return {
            sku: `${base}-${lineCode(label)}`,
            packSize: 1,
            unit: 'piece',
            label,
            mrpPaise: mrp,
            ...packPrices(random, mrp),
            barcode: internalEan13(barcode),
          };
        })
      : spec.packs.map((packSize): VariantPlan => {
          const mrp = mrpPaise(entry.rupeesPerUnit, packSize, spec.unit);
          barcode += 1;
          return {
            sku: `${base}-${packLabel(packSize, spec.unit)}`,
            packSize,
            unit: spec.unit,
            label: null,
            mrpPaise: mrp,
            ...packPrices(random, mrp),
            barcode: internalEan13(barcode),
          };
        });
    return {
      brand: entry.brand,
      category: entry.category,
      subcategory: subcategoryFor(entry.category, entry.name),
      name: entry.name,
      type: spec.type,
      hsnCode: spec.hsnCode,
      taxCategory: spec.taxCategory,
      variants,
    };
  });
}
