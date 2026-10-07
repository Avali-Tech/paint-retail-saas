import { call, type Business } from './support.js';

// Catalogue, stock and purchasing data for end-to-end tests, created through the
// real API the way a business would set itself up.

export interface CreatedProduct {
  readonly productId: string;
  readonly variants: { readonly id: string; readonly sku: string }[];
}

let brandCounter = 0;

/** A brand with one product and the given pack sizes (1 l at ₹500 by default). */
export async function createProduct(
  business: Business,
  {
    brand = `Brand ${String((brandCounter += 1))}`,
    name = 'Apex Ultima',
    variants = [{ sku: 'APX-1L', packSize: 1, mrpPaise: 50_000, sellingPricePaise: 45_000 }],
  }: {
    brand?: string;
    name?: string;
    variants?: {
      sku: string;
      packSize: number;
      unit?: string;
      label?: string;
      mrpPaise?: number;
      sellingPricePaise?: number;
      barcodes?: string[];
    }[];
  } = {},
): Promise<CreatedProduct> {
  const created = await call<{ id: string }>('POST', '/brands', {
    token: business.token,
    body: { name: brand },
  });
  const product = await call<{ id: string; variants: { id: string; sku: string }[] }>(
    'POST',
    '/products',
    {
      token: business.token,
      body: {
        brandId: created.id,
        name,
        type: 'interior_paint',
        hsnCode: '3209',
        gstRatePercent: 18,
        variants: variants.map((variant) => ({ unit: 'l', barcodes: [], ...variant })),
      },
    },
  );
  return {
    productId: product.id,
    variants: product.variants.map((variant) => ({ id: variant.id, sku: variant.sku })),
  };
}

/** Opening stock at a store, at a cost per unit. */
export async function openingStock(
  business: Business,
  storeId: string,
  lines: { variantId: string; quantity: number; unitCostPaise?: number }[],
): Promise<void> {
  await call('POST', '/stock/movements', {
    token: business.token,
    body: { storeId, type: 'opening', lines },
  });
}

/** A supplier (a party with the supplier role) who provides the given products. */
export async function createSupplier(
  business: Business,
  name: string,
  variantIds: readonly string[] = [],
): Promise<string> {
  const supplier = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { kind: 'organization', displayName: name, roles: ['supplier'] },
  });
  if (variantIds.length > 0) {
    await call('PUT', `/suppliers/${supplier.id}/products`, {
      token: business.token,
      body: { products: variantIds.map((variantId) => ({ variantId, supplierSku: null })) },
    });
  }
  return supplier.id;
}

/** Min / reorder level / max for a product at a store. */
export async function reorderRule(
  business: Business,
  rule: {
    storeId: string;
    variantId: string;
    minQuantity: number;
    reorderLevel: number;
    maxQuantity: number;
  },
): Promise<void> {
  await call('PUT', '/reorder-rules', { token: business.token, body: { rules: [rule] } });
}
