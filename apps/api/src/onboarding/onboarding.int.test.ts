import { migrateDatabase, schema } from '@paint/db';
import { toCsv, type SetupChecklistView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

const { organizationLogos, paymentGatewayAccounts, salesSettings } = schema;

let database: TestDatabase;
let t: TestApp;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
});

interface Owner {
  readonly token: string;
  readonly organizationId: string;
  readonly memberId: string;
}

async function signup(name: string): Promise<Owner> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  const { token, organizationId } = response.json<{ token: string; organizationId: string }>();
  const { memberId } = (await api(token).get('/auth/me')).json<{ memberId: string }>();
  return { token, organizationId, memberId };
}

const progress = async (owner: Owner) =>
  (await api(owner.token).get('/onboarding')).json<SetupChecklistView>();
const done = (checklist: SetupChecklistView) =>
  Object.fromEntries(checklist.steps.map((step) => [step.key, step.done]));

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('getting started checklist', () => {
  it('starts with nothing done, in the order to do it', async () => {
    const owner = await signup('Fresh Paints');

    const checklist = await progress(owner);

    expect(checklist).toMatchObject({ completed: 0, total: 9 });
    expect(checklist.steps.map((step) => [step.key, step.count])).toEqual([
      ['stores_gst', 0],
      ['products', 0],
      ['customers', 0],
      ['opening_stock', 0],
      ['team', 1],
      ['credit_rules', 0],
      ['billing_live', 0],
      ['invoice_print', 0],
      ['payment_links', 0],
    ]);
    expect((await t.app.inject({ method: 'GET', url: '/onboarding' })).statusCode).toBe(401);
  });

  it('ticks off each step from the business’s own records', async () => {
    const owner = await signup('Setup Paints');
    const other = await signup('Other Paints');
    const o = api(owner.token);
    const store = (await o.post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
      id: string;
    }>().id;
    // A godown needs no GST; a store without its GST state keeps the step open.
    await o.post('/stores', { name: 'Godown', code: 'GDN', type: 'godown' });
    const before = await progress(owner);
    expect(before.steps[0]).toEqual({ key: 'stores_gst', done: false, count: 0 });
    await o.put('/gst-registrations/business', { legalName: 'Setup Paints LLP' });
    await o.put(`/gst-registrations/stores/${store}`, {
      registrationType: 'unregistered',
      stateCode: '36',
    });

    const roles = (await o.get('/roles')).json<{ id: string; key: string }[]>();
    await o.post('/members', {
      fullName: 'Cashier',
      phone: uniquePhone(),
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === 'store_employee')?.id,
      storeIds: [store],
    });
    await o.post('/imports/products', {
      csv: toCsv([
        ['brand', 'product', 'type', 'hsn_code', 'tax_category', 'sku', 'pack_size', 'unit'],
        ['Asian Paints', 'Apex', 'exterior_paint', '3209', 'Paints 18%', 'APX-1L', '1', 'l'],
      ]),
    });
    await o.post('/imports/parties', {
      csv: toCsv([
        ['name', 'roles', 'phone'],
        ['Depot', 'supplier', uniquePhone()],
        ['Painter', 'painter;customer', uniquePhone()],
      ]),
    });
    const halfway = await progress(owner);
    expect(done(halfway)).toEqual({
      stores_gst: true,
      products: true,
      customers: true,
      opening_stock: false,
      team: true,
      credit_rules: false,
      billing_live: false,
      invoice_print: false,
      payment_links: false,
    });
    expect(halfway.steps.find((step) => step.key === 'customers')?.count).toBe(1);

    await o.post('/imports/opening-stock', {
      csv: toCsv([
        ['store', 'sku', 'quantity'],
        ['HYD', 'APX-1L', '10'],
      ]),
    });
    await o.put('/credit-rules', {
      normalUpToPercent: 80,
      managerUpToPercent: 100,
      holdAfterOverdueDays: 45,
    });
    await o.put('/sales/settings', { invoiceTerms: ['Goods once sold are not taken back.'] });
    // Going live, connecting Razorpay and uploading a logo need outside services:
    // their rows are written as those flows write them.
    await t.connection.db
      .update(salesSettings)
      .set({ billingLiveOn: '2026-10-01' })
      .where(eq(salesSettings.organizationId, owner.organizationId));
    await t.connection.db.insert(paymentGatewayAccounts).values({
      organizationId: owner.organizationId,
      gateway: 'razorpay',
      webhookRef: owner.organizationId.replaceAll('-', '').slice(0, 22),
      keyIdHint: 'abcd',
      keySecretHint: 'efgh',
      webhookSecretHint: 'ijkl',
      live: false,
      credentialsSealed: 'v1:test:sealed',
      connectedAt: new Date(),
    });
    await t.connection.db.insert(organizationLogos).values({
      organizationId: owner.organizationId,
      storageKey: `${owner.organizationId}/branding/logo-1`,
      contentType: 'image/png',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      width: 10,
      height: 10,
      uploadedByMemberId: owner.memberId,
    });

    const finished = await progress(owner);
    expect(finished).toMatchObject({ completed: 9, total: 9 });
    expect(finished.steps.find((step) => step.key === 'invoice_print')?.count).toBe(2);
    expect((await progress(other)).completed).toBe(0);
  });
});
