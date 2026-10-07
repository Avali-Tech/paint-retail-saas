import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuditPage } from '../audit/audit.service.js';
import type { LoyaltyView } from '../loyalty/loyalty.service.js';
import { istDate } from '../test-support/business.js';
import { multipartBody, PDF, testBucket } from '../test-support/files.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { PartyView } from './parties.service.js';
import { MERGE_HANDLED, type MergeResult } from './party-merge.service.js';

let database: TestDatabase;
let t: TestApp;
let owner: string;
/** Branch manager at Hyderabad: manages parties, but not every store. */
let manager: string;
let hyd: string;
let variantId: string;

const api = (token = owner) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
});
const idOf = async (reply: ReturnType<ReturnType<typeof api>['post']>) => {
  const response = await reply;
  if (response.statusCode >= 400) throw new Error(response.body);
  return response.json<{ id: string }>().id;
};
const message = (reply: { body: string }) =>
  (JSON.parse(reply.body) as { message: string }).message;
const merge = (duplicate: string, into: string, token = owner) =>
  api(token).post(`/parties/${duplicate}/merge`, { intoPartyId: into });
const party = (name: string, roles: string[] = ['customer', 'contractor']) =>
  idOf(api().post('/parties', { displayName: name, phone: uniquePhone(), roles }));

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  const env = await testBucket(
    inject('objectStorageEndpoint'),
    inject('virusScannerAddress'),
    'party-merge-test',
  );
  t = await startTestApp(database.connectionString, env);
  owner = (
    await t.app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organizationName: 'ABC Paints',
        fullName: 'Anil Owner',
        phone: uniquePhone(),
        password: 'Staff@2026',
      },
    })
  ).json<{ token: string }>().token;
  hyd = await idOf(api().post('/stores', { name: 'Hyderabad', code: 'HYD' }));
  const roles = (await api().get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await api().post('/members', {
    fullName: 'Hyd Manager',
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === 'branch_manager')?.id,
    storeIds: [hyd],
  });
  manager = (
    await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Staff@2026' },
    })
  ).json<{ token: string }>().token;
  const brandId = await idOf(api().post('/brands', { name: 'Asian Paints' }));
  variantId = String(
    (
      await api().post('/products', {
        brandId,
        name: 'Apex',
        type: 'exterior_paint',
        hsnCode: '3209',
        variants: [{ sku: 'APX-1L', packSize: 1, unit: 'l' }],
      })
    ).json<{ variants: { id: string }[] }>().variants[0]?.id,
  );
  await api().put('/loyalty-settings', {
    earnPoints: 1,
    earnPerPaise: 10_000,
    tiers: [],
    expiryDays: 365,
    minRedemptionPoints: 0,
  });
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('the merge guard', () => {
  it('handles every column that references a party', async () => {
    const references = await withPgClient(database.connectionString, async (client) => {
      const result = await client.query<{ reference: string }>(`
        SELECT c.conrelid::regclass::text || '.' || a.attname AS reference
        FROM pg_constraint c
        JOIN LATERAL unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'f'
          AND c.confrelid = 'parties'::regclass
          AND c.conrelid <> 'parties'::regclass
          AND a.attname <> 'organization_id'`);
      return result.rows.map((row) => row.reference);
    });

    // A new table that references parties must be handled by PartyMergeService.
    expect([...references].sort()).toEqual([...MERGE_HANDLED].sort());
  });
});

describe('merging a duplicate', () => {
  let duplicate: string;
  let survivor: string;
  let result: MergeResult;
  let duplicateLoyalty: LoyaltyView;

  beforeAll(async () => {
    duplicate = await party('Raj Contractor', ['customer', 'contractor', 'supplier']);
    survivor = await party('Raj Contractors', ['customer', 'painter']);
    const referrer = await party('Ravi Referrer');
    const lead = { storeId: hyd, title: 'Repaint', source: 'referral' };
    await api().post('/leads', { ...lead, partyId: duplicate });
    await api().post('/leads', { ...lead, partyId: referrer, referredByPartyId: duplicate });
    await api().post('/opportunities', {
      storeId: hyd,
      partyId: duplicate,
      title: 'Tower',
      expectedValuePaise: 100,
    });
    await idOf(
      api().post('/projects', {
        storeId: hyd,
        customerPartyId: referrer,
        name: 'Both on it',
        parties: [
          { partyId: duplicate, role: 'contractor' },
          { partyId: survivor, role: 'contractor' },
          { partyId: duplicate, role: 'painter' },
        ],
      }),
    );
    await api().post('/projects', { storeId: hyd, customerPartyId: duplicate, name: 'Villa' });
    await api().post('/contracts', {
      type: 'contractor_agreement',
      title: 'Rates',
      partyId: duplicate,
      startDate: istDate(0),
      endDate: istDate(300),
    });
    const line = [{ variantId, quantity: 1, unitCostPaise: 100 }];
    await api().post('/purchase-orders', { supplierId: duplicate, storeId: hyd, lines: line });
    await api().post('/goods-receipts', {
      storeId: hyd,
      supplierId: duplicate,
      supplierInvoiceNumber: 'RC-1',
      lines: line,
    });
    await api().post('/activities', {
      recordType: 'party',
      recordId: duplicate,
      type: 'call',
      subject: 'Called about rates',
    });
    const { payload, headers } = multipartBody(
      { recordType: 'party', recordId: duplicate, category: 'gst_certificate' },
      [{ fileName: 'GST.pdf', data: PDF }],
    );
    await t.app.inject({
      method: 'POST',
      url: '/documents',
      headers: { ...bearer(owner), ...headers },
      payload,
    });
    // Credit only on the duplicate, with another request waiting.
    const first = await idOf(
      api().post('/credit-requests', { partyId: duplicate, limitPaise: 30_000_00, creditDays: 30 }),
    );
    await api().post(`/credit-requests/${first}/approve`);
    await api().post('/credit-requests', {
      partyId: duplicate,
      limitPaise: 40_000_00,
      creditDays: 30,
    });
    // Loyalty on both: the duplicate's unused points move with their expiry.
    await api().post(`/parties/${duplicate}/loyalty`);
    await api().post(`/parties/${survivor}/loyalty`);
    await api().post(`/parties/${duplicate}/loyalty/awards`, { points: 300 });
    await api().post(`/parties/${duplicate}/loyalty/redemptions`, { points: 100 });
    await api().post(`/parties/${survivor}/loyalty/awards`, { points: 50 });

    const response = await merge(duplicate, survivor);
    expect(response.statusCode).toBe(200);
    result = response.json<MergeResult>();
    duplicateLoyalty = (await api().get(`/parties/${duplicate}/loyalty`)).json<LoyaltyView>();
  });

  it('moves every record to the surviving party, and says how many', () => {
    expect(result.party).toMatchObject({ id: survivor, displayName: 'Raj Contractors' });
    expect(result.party.roles).toEqual(['contractor', 'customer', 'painter', 'supplier']);
    expect(result.moved).toEqual({
      'leads.party_id': 1,
      'leads.referred_by_party_id': 1,
      'opportunities.party_id': 1,
      'projects.customer_party_id': 1,
      'contracts.party_id': 1,
      'purchase_orders.supplier_party_id': 1,
      'goods_receipts.supplier_party_id': 1,
      'credit_requests.party_id': 2,
      'credit_profiles.party_id': 1,
      'party_roles.party_id': 2,
      // The survivor already has a customer profile; the duplicate never had a supplier one.
      'customer_profiles.party_id': 0,
      'supplier_profiles.party_id': 0,
      'tax_documents.influencer_party_id': 0,
      'tax_documents.party_id': 0,
      'supplier_products.supplier_party_id': 1,
      // Already a contractor on the shared project: only the painter role moves.
      'project_parties.party_id': 1,
      'loyalty_accounts.party_id': 0,
      activities: 1,
      documents: 1,
    });
  });

  it('leaves the duplicate inactive, pointing at the survivor so old links resolve', async () => {
    const old = (await api().get(`/parties/${duplicate}`)).json<PartyView>();
    const search = (await api().get('/parties?q=raj')).json<{ items: PartyView[] }>();

    expect(old).toMatchObject({ isActive: false, mergedIntoId: survivor });
    expect(search.items.map((item) => item.id)).not.toContain(duplicate);
  });

  it('shows the survivor’s full history in the customer 360', async () => {
    const overview = (await api().get(`/parties/${survivor}/overview`)).json<{
      leads: { total: number };
      opportunities: { total: number };
      projects: { total: number };
      contracts: { total: number };
      activities: { total: number };
      documents: { total: number };
      credit: { status: string; limitPaise: number; pendingRequest: unknown };
    }>();

    expect(overview.leads.total).toBe(1);
    expect(overview.opportunities.total).toBe(1);
    expect(overview.projects.total).toBe(2);
    expect(overview.contracts.total).toBe(1);
    expect(overview.activities.total).toBe(1);
    expect(overview.documents.total).toBe(1);
    expect(overview.credit).toMatchObject({ status: 'active', limitPaise: 30_000_00 });
    expect(overview.credit.pendingRequest).not.toBeNull();
  });

  it('adds the duplicate’s unused points to the survivor, keeping their expiry, and closes its account', async () => {
    const loyalty = (await api().get(`/parties/${survivor}/loyalty`)).json<LoyaltyView>();

    expect(loyalty.balance).toBe(250);
    expect(loyalty.ledger.items[0]).toMatchObject({
      kind: 'adjust',
      points: 200,
      expiresOn: istDate(365),
      note: 'Moved when duplicate parties were merged',
    });
    expect(duplicateLoyalty).toMatchObject({ balance: 0, account: { status: 'closed' } });
  });

  it('is in the audit log', async () => {
    const audit = (await api().get('/audit-log?table=parties')).json<AuditPage>();

    expect(audit.items[0]).toMatchObject({
      area: 'Party merges',
      recordId: duplicate,
      recordLabel: 'Raj Contractor',
      actor: { name: 'Anil Owner' },
    });
    expect(audit.items[0]?.changes.map((c) => [c.label, c.oldText, c.newText])).toEqual([
      ['Merged into', null, 'Raj Contractors'],
    ]);
  });

  it('cannot merge the same duplicate again, or into a merged party', async () => {
    const other = await party('Someone Else');

    const again = await merge(duplicate, other);
    const intoMerged = await merge(other, duplicate);

    expect([again.statusCode, message(again)]).toEqual([
      409,
      'This party was already merged into another',
    ]);
    expect([intoMerged.statusCode, message(intoMerged)]).toEqual([
      400,
      'Merge into an active party',
    ]);
  });
});

describe('merge rules', () => {
  it('moves the duplicate’s loyalty account and customer profile when the survivor has none', async () => {
    const duplicate = await party('Painter Twin', ['customer']);
    const survivor = await party('Painter Twin Two', ['painter']);
    await api().post(`/parties/${duplicate}/loyalty`);
    await api().post(`/parties/${duplicate}/loyalty/awards`, { points: 40 });

    const result = (await merge(duplicate, survivor)).json<MergeResult>();

    expect(result.moved).toMatchObject({
      'loyalty_accounts.party_id': 1,
      'customer_profiles.party_id': 1,
      'credit_profiles.party_id': 0,
    });
    expect((await api().get(`/parties/${survivor}/loyalty`)).json<LoyaltyView>().balance).toBe(40);
    expect(result.party.customer).not.toBeNull();
  });

  it('keeps a duplicate’s profile without credit, and closes an empty loyalty account', async () => {
    const duplicate = await party('Quiet Twin');
    const survivor = await party('Quiet Twin Two');
    await api().post(`/parties/${duplicate}/loyalty`);
    await api().post(`/parties/${survivor}/loyalty`);
    // A profile without credit (risk only) on the duplicate, credit on the survivor.
    await t.app.inject({
      method: 'PATCH',
      url: `/parties/${duplicate}/credit`,
      headers: bearer(owner),
      payload: { risk: 'high' },
    });
    const request = await idOf(
      api().post('/credit-requests', { partyId: survivor, limitPaise: 100, creditDays: 7 }),
    );
    await api().post(`/credit-requests/${request}/approve`);

    const result = (await merge(duplicate, survivor)).json<MergeResult>();

    expect(result.moved).toMatchObject({
      'credit_profiles.party_id': 0,
      'loyalty_accounts.party_id': 0,
    });
    const [kept] = await t.connection.db
      .select({ partyId: schema.creditProfiles.partyId })
      .from(schema.creditProfiles)
      .where(eq(schema.creditProfiles.partyId, duplicate));
    expect(kept?.partyId).toBe(duplicate);
    expect(
      (await api().get(`/parties/${duplicate}/loyalty`)).json<LoyaltyView>().account?.status,
    ).toBe('closed');
  });

  it('refuses when both parties have a credit request waiting, or both have credit', async () => {
    const a = await party('Credit A');
    const b = await party('Credit B');
    await api().post('/credit-requests', { partyId: a, limitPaise: 100, creditDays: 7 });
    const pendingB = await idOf(
      api().post('/credit-requests', { partyId: b, limitPaise: 100, creditDays: 7 }),
    );

    const bothWaiting = await merge(a, b);
    await api().post(`/credit-requests/${pendingB}/approve`);
    const pendingA = (await api().get(`/credit-requests?partyId=${a}&status=pending`)).json<{
      items: { id: string }[];
    }>().items[0]?.id;
    await api().post(`/credit-requests/${String(pendingA)}/approve`);
    const bothCredit = await merge(a, b);

    expect([bothWaiting.statusCode, message(bothWaiting)]).toEqual([
      409,
      'Both parties have a credit request waiting; decide one first',
    ]);
    expect([bothCredit.statusCode, message(bothCredit)]).toEqual([
      409,
      'Both parties have a credit profile; merge the other way or end one’s credit first',
    ]);
    // Nothing changed.
    expect((await api().get(`/parties/${a}`)).json<PartyView>().isActive).toBe(true);
  });

  it('merges parties with nothing but their roles', async () => {
    const duplicate = await party('Plain One', ['architect']);
    const survivor = await party('Plain Two', ['architect']);

    const result = (await merge(duplicate, survivor)).json<MergeResult>();

    expect(result.moved).toMatchObject({
      'party_roles.party_id': 0,
      'loyalty_accounts.party_id': 0,
      'credit_profiles.party_id': 0,
    });
    expect(result.party.roles).toEqual(['architect']);
  });

  it('is only for members who see every store, and never a party into itself', async () => {
    const a = await party('Access A');
    const b = await party('Access B');

    const byManager = await merge(a, b, manager);
    const self = await merge(a, a);
    const ghost = await merge('00000000-0000-4000-8000-000000000000', b);
    const intoGhost = await merge(a, '00000000-0000-4000-8000-000000000000');

    expect([byManager.statusCode, message(byManager)]).toEqual([
      403,
      'Only members who work at every store can merge parties',
    ]);
    expect([self.statusCode, message(self)]).toEqual([400, 'Choose another party to merge into']);
    expect(ghost.statusCode).toBe(404);
    expect([intoGhost.statusCode, message(intoGhost)]).toEqual([
      400,
      'Unknown party to merge into',
    ]);
  });
});
