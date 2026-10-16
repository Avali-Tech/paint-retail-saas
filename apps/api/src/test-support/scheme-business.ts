import { schema } from '@paint/db';
import { eq } from 'drizzle-orm';
import { bearer, uniquePhone, type TestApp } from './test-app.js';

/**
 * A paint business buying from two brands, for brand scheme tests (P2-M33). Every GRN
 * is moved onto a fixed India day, so tests never depend on today:
 *
 * - Apex Paints: Ultima 10 L and 20 L (category Emulsions), Wall Putty 40 kg (Putty).
 *   - 2026-07-10 at HYD: 10 × Ultima 20 L at ₹4,000 plus 1 free (AD/101, invoice 2026-07-09);
 *   - 2026-07-15 at HYD: 10 × Wall Putty at ₹500 (AD/103, no invoice date; no litres);
 *   - 2026-08-05 at SEC: 6 × Ultima 10 L at ₹2,500 (AD/102, invoiced 2026-06-28);
 *   - 2026-10-02 at HYD: 2 × Ultima 10 L at ₹2,500 (after the quarter).
 * - Berger: Silk 20 L (Emulsions); 2026-07-20 at HYD: 5 at ₹3,000.
 *
 * So for July–September by GRN date Apex has ₹60,000 and 260 L (20 free); by
 * invoice date ₹45,000 and 220 L.
 */
export interface SchemeBusiness {
  readonly owner: string;
  readonly organizationId: string;
  readonly ownerMemberId: string;
  /** Inventory manager at HYD: purchasing yes, schemes:manage no. */
  readonly buyer: string;
  /** Store employee at HYD: no purchasing. */
  readonly cashier: string;
  readonly stores: { readonly hyd: string; readonly sec: string };
  readonly supplier: string;
  readonly brands: { readonly apex: string; readonly berger: string };
  readonly categories: { readonly emulsions: string; readonly putty: string };
  readonly products: { readonly ultima: string; readonly putty: string; readonly silk: string };
  readonly variants: {
    readonly ultima10: string;
    readonly ultima20: string;
    readonly putty40: string;
    readonly silk20: string;
  };
  readonly grns: { readonly g1: string; readonly g2: string; readonly g3: string };
}

export async function seedSchemeBusiness(t: TestApp): Promise<SchemeBusiness> {
  const post = async (token: string, url: string, payload: object) => {
    const response = await t.app.inject({ method: 'POST', url, headers: bearer(token), payload });
    if (response.statusCode >= 400) throw new Error(`${url}: ${response.body}`);
    return response.json<{ id: string } & Record<string, unknown>>();
  };
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: 'Scheme Paints',
      fullName: 'Suma Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  const owner = signup.json<{ token: string }>().token;
  const me = (await t.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(owner) })).json<{
    organization: { id: string };
    memberId: string;
  }>();
  const hyd = (await post(owner, '/stores', { name: 'Hyderabad', code: 'HYD' })).id;
  const sec = (await post(owner, '/stores', { name: 'Secunderabad', code: 'SEC' })).id;
  const roles = (await t.app.inject({ method: 'GET', url: '/roles', headers: bearer(owner) })).json<
    { id: string; key: string }[]
  >();
  const hire = async (roleKey: string) => {
    const phone = uniquePhone();
    await post(owner, '/members', {
      fullName: `Staff ${roleKey}`,
      phone,
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === roleKey)?.id,
      storeIds: [hyd],
    });
    const login = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Staff@2026' },
    });
    return login.json<{ token: string }>().token;
  };
  const buyer = await hire('inventory_manager');
  const cashier = await hire('store_employee');

  const apex = (await post(owner, '/brands', { name: 'Apex Paints' })).id;
  const berger = (await post(owner, '/brands', { name: 'Berger' })).id;
  const emulsions = (await post(owner, '/categories', { name: 'Emulsions' })).id;
  const puttyCategory = (await post(owner, '/categories', { name: 'Putty' })).id;
  const variantsOf = (product: Record<string, unknown>) =>
    Object.fromEntries(
      (product.variants as { id: string; sku: string }[]).map((variant) => [
        variant.sku,
        variant.id,
      ]),
    );
  const ultima = await post(owner, '/products', {
    brandId: apex,
    categoryId: emulsions,
    name: 'Ultima',
    type: 'exterior_paint',
    hsnCode: '3209',
    variants: [
      { sku: 'ULT-10L', packSize: 10, unit: 'l' },
      { sku: 'ULT-20L', packSize: 20, unit: 'l' },
    ],
  });
  const putty = await post(owner, '/products', {
    brandId: apex,
    categoryId: puttyCategory,
    name: 'Wall Putty',
    type: 'putty',
    hsnCode: '3214',
    variants: [{ sku: 'PUT-40KG', packSize: 40, unit: 'kg' }],
  });
  const silk = await post(owner, '/products', {
    brandId: berger,
    categoryId: emulsions,
    name: 'Silk',
    type: 'interior_paint',
    hsnCode: '3209',
    variants: [{ sku: 'SLK-20L', packSize: 20, unit: 'l' }],
  });
  const ultimaVariants = variantsOf(ultima);
  const ultima10 = String(ultimaVariants['ULT-10L']);
  const ultima20 = String(ultimaVariants['ULT-20L']);
  const putty40 = String(variantsOf(putty)['PUT-40KG']);
  const silk20 = String(variantsOf(silk)['SLK-20L']);
  const supplier = (
    await post(owner, '/parties', {
      kind: 'organization',
      displayName: 'Deccan Distributors',
      roles: ['supplier'],
    })
  ).id;

  const receive = async (day: string, storeId: string, payload: object) => {
    const grn = await post(owner, '/goods-receipts', { storeId, supplierId: supplier, ...payload });
    await t.connection.db
      .update(schema.goodsReceipts)
      .set({ receivedAt: new Date(`${day}T12:00:00+05:30`) })
      .where(eq(schema.goodsReceipts.id, grn.id));
    return grn.id;
  };
  const g1 = await receive('2026-07-10', hyd, {
    supplierInvoiceNumber: 'AD/101',
    supplierInvoiceDate: '2026-07-09',
    lines: [{ variantId: ultima20, quantity: 10, freeQuantity: 1, unitCostPaise: 4_000_00 }],
  });
  await receive('2026-07-15', hyd, {
    supplierInvoiceNumber: 'AD/103',
    lines: [{ variantId: putty40, quantity: 10, unitCostPaise: 500_00 }],
  });
  const g2 = await receive('2026-08-05', sec, {
    supplierInvoiceNumber: 'AD/102',
    supplierInvoiceDate: '2026-06-28',
    lines: [{ variantId: ultima10, quantity: 6, unitCostPaise: 2_500_00 }],
  });
  const g3 = await receive('2026-10-02', hyd, {
    supplierInvoiceNumber: 'AD/104',
    lines: [{ variantId: ultima10, quantity: 2, unitCostPaise: 2_500_00 }],
  });
  await receive('2026-07-20', hyd, {
    supplierInvoiceNumber: 'BG/201',
    lines: [{ variantId: silk20, quantity: 5, unitCostPaise: 3_000_00 }],
  });

  return {
    owner,
    organizationId: me.organization.id,
    ownerMemberId: me.memberId,
    buyer,
    cashier,
    stores: { hyd, sec },
    supplier,
    brands: { apex, berger },
    categories: { emulsions, putty: puttyCategory },
    products: { ultima: ultima.id, putty: putty.id, silk: silk.id },
    variants: { ultima10, ultima20, putty40, silk20 },
    grns: { g1, g2, g3 },
  };
}
