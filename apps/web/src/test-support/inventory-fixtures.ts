import type { Brand, Category, Product, Variant } from '../api/catalog.js';
import type { Page } from '../api/page.js';
import type { LowStockItem, ReorderRule, StockRow, Store } from '../api/stock.js';

// Catalogue and stock data for component tests.

export const page = <T>(items: T[], total = items.length): Page<T> => ({ items, total });

const store = (id: string, code: string, name: string): Store => ({
  id,
  code,
  name,
  type: 'store',
  city: null,
  state: null,
  gstin: null,
  isActive: true,
});

export const HYD = store('store-hyd', 'HYD', 'Hyderabad');
export const PUN = store('store-pun', 'PUN', 'Pune');
export const STORES: Store[] = [HYD, PUN];

export const BRANDS: Brand[] = [
  { id: 'brand-asian', name: 'Asian Paints', isActive: true },
  { id: 'brand-old', name: 'Old Brand', isActive: false },
];

export const CATEGORIES: Category[] = [
  { id: 'cat-emulsion', name: 'Emulsions', parentId: null },
  { id: 'cat-interior', name: 'Interior emulsions', parentId: 'cat-emulsion' },
];

export const variant = (overrides: Partial<Variant> = {}): Variant => ({
  id: 'variant-1l',
  sku: 'APX-1L',
  packSize: 1,
  unit: 'l',
  mrpPaise: 50_000,
  sellingPricePaise: 45_000,
  isActive: true,
  barcodes: ['8901234567890'],
  ...overrides,
});

export const product = (overrides: Partial<Product> = {}): Product => ({
  id: 'product-apex',
  name: 'Apex Ultima',
  type: 'exterior_paint',
  description: null,
  hsnCode: '3209',
  gstRatePercent: 18,
  isActive: true,
  brand: { id: 'brand-asian', name: 'Asian Paints' },
  category: null,
  variants: [
    variant(),
    variant({
      id: 'variant-4l',
      sku: 'APX-4L',
      packSize: 4,
      mrpPaise: 170_000,
      sellingPricePaise: null,
      barcodes: [],
    }),
  ],
  ...overrides,
});

export const APEX = product();

export const stockRow = (overrides: Partial<StockRow> = {}): StockRow => ({
  store: { id: HYD.id, code: HYD.code, name: HYD.name },
  variant: { id: 'variant-1l', sku: 'APX-1L', packSize: 1, unit: 'l' },
  product: { id: APEX.id, name: APEX.name },
  brand: { id: 'brand-asian', name: 'Asian Paints' },
  onHand: 12,
  reserved: 2,
  available: 10,
  avgCostPaise: 40_000,
  valuePaise: 480_000,
  ...overrides,
});

export const rule = (overrides: Partial<ReorderRule> = {}): ReorderRule => ({
  store: { id: HYD.id, code: HYD.code },
  variant: { id: 'variant-1l', sku: 'APX-1L' },
  product: { name: APEX.name },
  brand: { name: 'Asian Paints' },
  minQuantity: 2,
  reorderLevel: 5,
  maxQuantity: 20,
  ...overrides,
});

export const lowItem = (overrides: Partial<LowStockItem> = {}): LowStockItem => ({
  ...rule(),
  onHand: 1,
  available: 1,
  severity: 'below_minimum',
  suggestedQuantity: 19,
  ...overrides,
});
