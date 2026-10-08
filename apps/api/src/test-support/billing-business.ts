import { postStockMovements, withTenant } from '@paint/db';
import {
  gstinCheckCharacter,
  type IssuedInvoiceView,
  type PaymentModeView,
  type TaxCategoryOptions,
  type TaxDocumentView,
} from '@paint/shared';
import { sql } from 'drizzle-orm';
import { bearer, uniquePhone, type TestApp } from './test-app.js';

/**
 * A business ready to bill and take payments, for the integration tests of
 * payments and registers: two GST-registered stores (AMP, KKP), one not
 * registered (UNR), a product with stock everywhere, customers and staff.
 */

export type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;

export function api(t: TestApp, token: string, headers: Record<string, string> = {}) {
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => t.app.inject({ method, url, headers: { ...bearer(token), ...headers }, payload });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: object = {}) => call('POST', url, payload),
    put: (url: string, payload: object) => call('PUT', url, payload),
    patch: (url: string, payload: object) => call('PATCH', url, payload),
  };
}

/** The reply, after checking it succeeded (its body in the error otherwise). */
export function ok(reply: Reply): Reply {
  if (reply.statusCode >= 400) throw new Error(`${String(reply.statusCode)}: ${reply.body}`);
  return reply;
}

export const issuesOf = (reply: Reply) =>
  reply.json<{ issues: { path: string; message: string }[] }>().issues.map((issue) => issue.path);

const PAN = 'AABCS1429B';
const gstin = (state: string, entity: string) => {
  const first14 = `${state}${PAN}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

export interface BillingBusiness {
  readonly t: TestApp;
  readonly owner: string;
  readonly organizationId: string;
  readonly stores: { amp: string; kkp: string; unr: string };
  /** ₹118.00 a litre, inclusive of 18%. */
  readonly apex: string;
  readonly parties: { contractor: string; homeowner: string };
  readonly modes: Record<'cash' | 'upi' | 'card' | 'bank' | 'cheque', PaymentModeView>;
  member(roleKey: string, storeIds: string[]): Promise<string>;
  /** An issued invoice for `quantity` litres at a store (Ameerpet by default). */
  invoice(options?: {
    partyId?: string;
    quantity?: number;
    storeId?: string;
    issue?: object;
    token?: string;
  }): Promise<IssuedInvoiceView>;
  draft(body: object, token?: string): Promise<TaxDocumentView>;
}

let businesses = 0;
export async function billingBusiness(t: TestApp): Promise<BillingBusiness> {
  businesses += 1;
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: `Rangoli Paints ${String(businesses)}`,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Rangoli@2026',
    },
  });
  const { token: owner, organizationId } = signup.json<{ token: string; organizationId: string }>();
  const o = api(t, owner);
  const store = async (name: string, code: string) =>
    ok(await o.post('/stores', { name, code })).json<{ id: string }>().id;
  const stores = {
    amp: await store('Ameerpet', 'AMP'),
    kkp: await store('Kukatpally', 'KKP'),
    unr: await store('Godown counter', 'UNR'),
  };
  ok(await o.put('/gst-registrations/business', { legalName: 'Rangoli Paints Private Limited' }));
  for (const storeId of [stores.amp, stores.kkp]) {
    ok(
      await o.put(`/gst-registrations/stores/${storeId}`, {
        registrationType: 'regular',
        stateCode: '36',
        gstin: gstin('36', '1'),
        addressLine: '1-2-3 Main Road',
        city: 'Hyderabad',
        pincode: '500016',
      }),
    );
  }
  const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
  const paints = String(options.categories.find((c) => c.key === 'paints')?.id);
  const brandId = ok(await o.post('/brands', { name: 'Asian Paints' })).json<{ id: string }>().id;
  const [apexVariant] = ok(
    await o.post('/products', {
      brandId,
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '32091090',
      taxCategoryId: paints,
      variants: [{ sku: 'APX-1L', packSize: 1, unit: 'l', sellingPricePaise: 11_800 }],
    }),
  ).json<{ variants: { id: string }[] }>().variants;
  const apex = String(apexVariant?.id);
  await withTenant(t.connection.db, organizationId, (tx) =>
    postStockMovements(
      tx,
      Object.values(stores).map((storeId) => ({
        organizationId,
        storeId,
        variantId: apex,
        movementType: 'opening' as const,
        quantity: 10_000,
      })),
    ),
  );
  const party = async (body: object) =>
    ok(await o.post('/parties', { roles: ['customer'], ...body })).json<{ id: string }>().id;
  const parties = {
    contractor: await party({
      displayName: 'Deccan Contractors',
      phone: uniquePhone(),
      roles: ['contractor'],
    }),
    homeowner: await party({ displayName: 'Suresh', phone: uniquePhone(), placeOfSupply: '36' }),
  };
  const modeList = ok(await o.get('/payment-modes')).json<PaymentModeView[]>();
  const mode = (kind: string): PaymentModeView => {
    const found = modeList.find((m) => m.kind === kind);
    if (!found) throw new Error(`No ${kind} mode`);
    return found;
  };
  const modes = {
    cash: mode('cash'),
    upi: mode('upi'),
    card: mode('card'),
    bank: mode('bank_transfer'),
    cheque: mode('cheque'),
  };
  const roles = ok(await o.get('/roles')).json<{ id: string; key: string }[]>();
  const draft = async (body: object, token = owner) =>
    ok(
      await api(t, token).post('/invoices', { storeId: stores.amp, ...body }),
    ).json<TaxDocumentView>();
  return {
    t,
    owner,
    organizationId,
    stores,
    apex,
    parties,
    modes,
    draft,
    async invoice({ partyId, quantity = 1, storeId = stores.amp, issue = {}, token = owner } = {}) {
      const document = await draft(
        { storeId, partyId, lines: [{ variantId: apex, quantity }] },
        token,
      );
      return ok(
        await api(t, token).post(`/invoices/${document.id}/issue`, issue),
      ).json<IssuedInvoiceView>();
    },
    async member(roleKey, storeIds) {
      const phone = uniquePhone();
      ok(
        await o.post('/members', {
          fullName: `Staff ${roleKey}`,
          phone,
          password: 'Staff@2026',
          roleId: roles.find((role) => role.key === roleKey)?.id,
          storeIds,
        }),
      );
      const login = await t.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { identifier: phone, password: 'Staff@2026' },
      });
      return login.json<{ token: string }>().token;
    },
  };
}

/** Today in India from the database clock, never the Node clock. */
export async function dbToday(t: TestApp, daysAhead = 0): Promise<string> {
  const result = await t.connection.db.execute<{ day: string }>(
    sql`select ((now() at time zone 'Asia/Kolkata')::date + ${daysAhead}::int)::text as day`,
  );
  return String(result.rows[0]?.day);
}
