import { bearer, uniquePhone, type TestApp } from './test-app.js';

/** A date in India, `days` from today, as YYYY-MM-DD. */
export const istDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });

export interface Business {
  readonly owner: string;
  /** Branch manager at Hyderabad. */
  readonly manager: string;
  /** Store employee at Hyderabad: stock yes, purchasing, leads and projects no. */
  readonly cashier: string;
  readonly stores: { readonly hyd: string; readonly pune: string; readonly sec: string };
  readonly supplier: string;
  readonly variants: { readonly a: string; readonly b: string; readonly c: string };
}

/**
 * A small paint business with something in every state, for dashboard and
 * report tests:
 * - stock: HYD 13 × APX-1L (12 at ₹100, 1 free) and 3 × APX-4L at ₹400; PUN 17 × APX-1L
 *   at ₹110 and 5 × APX-10L without a cost; SEC nothing
 * - reorder rules at HYD: APX-1L at its reorder level, APX-4L below its
 *   minimum, APX-10L out of stock
 * - transfers from PUN: two requested (by HYD and SEC), one approved, one
 *   dispatched to HYD
 * - purchase orders at HYD: one open (10 × ₹400), one partly received (3 of
 *   5 × ₹100 still due); one cancelled at PUN
 * - leads: HYD new (₹1,000) and lost, PUN qualified; an HYD opportunity
 *   (₹5,000 at 20 %); projects: HYD identified (₹9,000), PUN survey
 * - follow-ups: one overdue at HYD, one due today business-wide, one upcoming
 */
export async function seedBusiness(t: TestApp): Promise<Business> {
  const api = (token: string) => ({
    get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
    post: async (url: string, payload: object = {}) => {
      const response = await t.app.inject({ method: 'POST', url, headers: bearer(token), payload });
      if (response.statusCode >= 400) throw new Error(`${url}: ${response.body}`);
      return response.json<{ id: string } & Record<string, unknown>>();
    },
    put: (url: string, payload: object) =>
      t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
  });
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: 'ABC Paints',
      fullName: 'Anil Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  const owner = signup.json<{ token: string }>().token;
  const o = api(owner);
  const hyd = (await o.post('/stores', { name: 'Hyderabad', code: 'HYD' })).id;
  const pune = (await o.post('/stores', { name: 'Pune', code: 'PUN' })).id;
  const sec = (await o.post('/stores', { name: 'Secunderabad', code: 'SEC' })).id;
  const roles = (await o.get('/roles')).json<{ id: string; key: string }[]>();
  const hire = async (roleKey: string) => {
    const phone = uniquePhone();
    await o.post('/members', {
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
  const manager = await hire('branch_manager');
  const cashier = await hire('store_employee');

  const brandId = (await o.post('/brands', { name: 'Asian Paints' })).id;
  const product = await o.post('/products', {
    brandId,
    name: 'Apex',
    type: 'exterior_paint',
    hsnCode: '3209',
    gstRatePercent: 18,
    variants: [
      { sku: 'APX-1L', packSize: 1, unit: 'l' },
      { sku: 'APX-4L', packSize: 4, unit: 'l' },
      { sku: 'APX-10L', packSize: 10, unit: 'l' },
    ],
  });
  const ids = (product.variants as { id: string; sku: string }[]).reduce<Record<string, string>>(
    (all, variant) => ({ ...all, [variant.sku]: variant.id }),
    {},
  );
  const a = String(ids['APX-1L']);
  const b = String(ids['APX-4L']);
  const c = String(ids['APX-10L']);
  const supplier = (
    await o.post('/parties', {
      kind: 'organization',
      displayName: 'Asian Depot',
      roles: ['supplier'],
    })
  ).id;
  const customer = (
    await o.post('/parties', {
      kind: 'organization',
      displayName: 'Sharma Builders',
      roles: ['customer'],
    })
  ).id;

  await o.post('/stock/movements', {
    storeId: hyd,
    type: 'opening',
    lines: [
      { variantId: a, quantity: 10, unitCostPaise: 10_000 },
      { variantId: b, quantity: 3, unitCostPaise: 40_000 },
    ],
  });
  await o.post('/stock/movements', {
    storeId: pune,
    type: 'opening',
    lines: [
      { variantId: a, quantity: 20, unitCostPaise: 11_000 },
      { variantId: c, quantity: 5 },
    ],
  });
  await o.post('/stock/movements', {
    storeId: pune,
    type: 'damage',
    note: 'Leaking tin',
    lines: [{ variantId: c, quantity: 0.5 }],
  });
  await o.post('/stock/movements', {
    storeId: pune,
    type: 'adjustment',
    note: 'Found in back room',
    lines: [{ variantId: c, quantity: 0.5 }],
  });
  await api(owner).put('/reorder-rules', {
    rules: [
      { storeId: hyd, variantId: a, minQuantity: 5, reorderLevel: 12, maxQuantity: 30 },
      { storeId: hyd, variantId: b, minQuantity: 4, reorderLevel: 6, maxQuantity: 10 },
      { storeId: hyd, variantId: c, minQuantity: 1, reorderLevel: 2, maxQuantity: 5 },
    ],
  });

  const transfer = (toStoreId: string, quantity: number) =>
    o.post('/transfers', { fromStoreId: pune, toStoreId, lines: [{ variantId: a, quantity }] });
  await transfer(hyd, 2);
  await transfer(sec, 1);
  const approved = await transfer(hyd, 1);
  await o.post(`/transfers/${approved.id}/approve`);
  const dispatched = await transfer(hyd, 3);
  await o.post(`/transfers/${dispatched.id}/approve`);
  await o.post(`/transfers/${dispatched.id}/dispatch`);

  await o.post('/purchase-orders', {
    supplierId: supplier,
    storeId: hyd,
    lines: [{ variantId: b, quantity: 10, unitCostPaise: 40_000 }],
  });
  const partly = await o.post('/purchase-orders', {
    supplierId: supplier,
    storeId: hyd,
    lines: [{ variantId: a, quantity: 5, unitCostPaise: 10_000 }],
  });
  await o.post('/goods-receipts', {
    purchaseOrderId: partly.id,
    supplierInvoiceNumber: 'AD/101',
    lines: [{ variantId: a, quantity: 2, freeQuantity: 1 }],
  });
  const cancelled = await o.post('/purchase-orders', {
    supplierId: supplier,
    storeId: pune,
    lines: [{ variantId: a, quantity: 1 }],
  });
  await o.post(`/purchase-orders/${cancelled.id}/cancel`, { reason: 'Not needed' });

  const lead = await o.post('/leads', {
    storeId: hyd,
    partyId: customer,
    title: 'Kondapur tower',
    source: 'phone_call',
    estimatedValuePaise: 100_000,
  });
  const lost = await o.post('/leads', {
    storeId: hyd,
    partyId: customer,
    title: 'Old enquiry',
    source: 'walk_in',
  });
  await o.post(`/leads/${lost.id}/lose`, { reason: 'No budget' });
  const punLead = await o.post('/leads', {
    storeId: pune,
    partyId: customer,
    title: 'Pune villa',
    source: 'referral',
  });
  await o.post(`/leads/${punLead.id}/stage`, { stage: 'qualified' });
  await o.post('/opportunities', {
    storeId: hyd,
    partyId: customer,
    title: 'Tower order',
    expectedValuePaise: 500_000,
  });
  await o.post('/projects', {
    storeId: hyd,
    customerPartyId: customer,
    name: 'Gachibowli Heights',
    city: 'Hyderabad',
    expectedOrderValuePaise: 900_000,
  });
  const punProject = await o.post('/projects', {
    storeId: pune,
    customerPartyId: customer,
    name: 'Pune office',
  });
  await o.post(`/projects/${punProject.id}/stage`, { stage: 'survey' });
  const follow = (recordType: string, recordId: string, dueAt: string) =>
    o.post('/activities', { recordType, recordId, type: 'follow_up', subject: 'Follow up', dueAt });
  await follow('lead', lead.id, `${istDate(-1)}T10:00:00+05:30`);
  await follow('party', customer, `${istDate(0)}T23:30:00+05:30`);
  await follow('lead', punLead.id, `${istDate(3)}T10:00:00+05:30`);

  return { owner, manager, cashier, stores: { hyd, pune, sec }, supplier, variants: { a, b, c } };
}
