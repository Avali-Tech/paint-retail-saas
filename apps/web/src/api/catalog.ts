import type { ProductPaintChanges, ProductPaintFields } from '@paint/shared';
import type { ApiClient } from './client.js';
import type { Page } from './page.js';

// Brands, categories, products and their variants. Shapes mirror apps/api/src/catalog.

export const PRODUCT_TYPES = [
  'interior_paint',
  'exterior_paint',
  'primer',
  'putty',
  'enamel',
  'wood_finish',
  'waterproofing',
  'texture',
  'thinner',
  'tool',
  'other',
  'colorant',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const UNITS = ['ml', 'l', 'g', 'kg', 'piece', 'set', 'm'] as const;
export type Unit = (typeof UNITS)[number];

export interface Brand {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  /** Inactive categories keep their products but take no new ones. */
  readonly isActive: boolean;
}

export interface Variant {
  readonly id: string;
  readonly sku: string;
  readonly packSize: number;
  readonly unit: Unit;
  /** Tells same-sized packs apart, e.g. "2 inch" or "Grit 120"; null when not needed. */
  readonly label: string | null;
  readonly mrpPaise: number | null;
  readonly sellingPricePaise: number | null;
  /** g per ml (round 8a); null when not known. */
  readonly densityGPerMl: number | null;
  readonly isActive: boolean;
  readonly barcodes: string[];
}

/** Paint fields (coverage, coats, tintable) are null / false for hardware. */
export interface Product extends ProductPaintFields {
  readonly id: string;
  readonly name: string;
  readonly type: ProductType;
  readonly description: string | null;
  readonly hsnCode: string;
  /** Today's rate of its tax category. */
  readonly gstRatePercent: number;
  readonly taxCategory: { readonly id: string; readonly name: string } | null;
  readonly isActive: boolean;
  readonly brand: { readonly id: string; readonly name: string };
  readonly category: Category | null;
  readonly variants: Variant[];
}

export interface VariantInput {
  readonly sku: string;
  readonly packSize: number;
  readonly unit: Unit;
  readonly label?: string | null;
  readonly mrpPaise?: number;
  readonly sellingPricePaise?: number;
  readonly densityGPerMl?: number;
  readonly barcodes: string[];
}

export interface VariantChanges {
  readonly sku?: string;
  readonly label?: string | null;
  readonly mrpPaise?: number | null;
  readonly sellingPricePaise?: number | null;
  readonly densityGPerMl?: number | null;
  readonly isActive?: boolean;
  readonly barcodes?: string[];
}

/** POST /products: a new product family with its first pack sizes. */
export interface NewProduct extends ProductPaintChanges {
  readonly brandId: string;
  readonly categoryId?: string;
  readonly name: string;
  readonly type: ProductType;
  readonly description?: string;
  readonly hsnCode: string;
  /** Left out: the default category, until the business registers for GST. */
  readonly taxCategoryId?: string;
  readonly variants: VariantInput[];
}

/** PATCH /products/:id: only what changes; null clears the category, description or a paint number. */
export interface ProductChanges extends ProductPaintChanges {
  readonly brandId?: string;
  readonly categoryId?: string | null;
  readonly name?: string;
  readonly type?: ProductType;
  readonly description?: string | null;
  readonly hsnCode?: string;
  readonly taxCategoryId?: string;
  readonly isActive?: boolean;
}

export interface ProductQuery {
  readonly q?: string;
  readonly brandId?: string;
  readonly categoryId?: string;
  readonly type?: ProductType;
  readonly includeInactive?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export function catalogEndpoints(api: ApiClient) {
  return {
    brands: () => api.get<Brand[]>('/brands'),
    createBrand: (name: string) => api.post<Brand>('/brands', { name }),
    updateBrand: (id: string, changes: { name?: string; isActive?: boolean }) =>
      api.patch<Brand>(`/brands/${id}`, changes),
    categories: () => api.get<Category[]>('/categories'),
    createCategory: (input: { name: string; parentId?: string }) =>
      api.post<Category>('/categories', input),
    renameCategory: (id: string, name: string) =>
      api.patch<Category>(`/categories/${id}`, { name }),
    /** Inactive categories keep their products but take no new ones. */
    setCategoryActive: (id: string, isActive: boolean) =>
      api.patch<Category>(`/categories/${id}`, { isActive }),
    products: (query: ProductQuery, signal?: AbortSignal) =>
      api.get<Page<Product>>('/products', { query: { ...query }, signal }),
    product: (id: string, signal?: AbortSignal) => api.get<Product>(`/products/${id}`, { signal }),
    /** Discontinued packs answer 404 unless `includeInactive`. */
    lookup: (code: string, includeInactive: boolean) =>
      api.get<{ product: Product; variant: Variant }>('/products/lookup', {
        query: { code, includeInactive },
      }),
    createProduct: (input: NewProduct) => api.post<Product>('/products', input),
    updateProduct: (id: string, changes: ProductChanges) =>
      api.patch<Product>(`/products/${id}`, changes),
    addVariant: (productId: string, input: VariantInput) =>
      api.post<Product>(`/products/${productId}/variants`, input),
    updateVariant: (variantId: string, changes: VariantChanges) =>
      api.patch<Product>(`/variants/${variantId}`, changes),
  };
}
