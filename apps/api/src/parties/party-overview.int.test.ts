import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { PartyOverview } from './party-overview.service.js';

type Response = Awaited<ReturnType<ReturnType<typeof api>['post']>>;

let database: TestDatabase;
let t: TestApp;
let owner: string;
let sales: string;
let punSales: string;
let cashier: string;
let hyd: string;
let pune: string;
let customer: string;
const ids: Record<string, string> = {};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
});
const idOf = async (response: Promise<Response>) => (await response).json<{ id: string }>().id;
const overview = async (token: string, partyId = customer) =>
  (await api(token).get(`/parties/${partyId}/overview`)).json<PartyOverview>();
const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

async function signup(name: string): Promise<string> {
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
  return response.json<{ token: string }>().token;
}

async function hire(roleKey: string, storeIds: string[]): Promise<string> {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await api(owner).post('/members', {
    fullName: `Staff ${roleKey}`,
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    storeIds,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyd = await idOf(api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' }));
  pune = await idOf(api(owner).post('/stores', { name: 'Pune', code: 'PUN' }));
  sales = await hire('sales_executive', [hyd]);
  punSales = await hire('sales_executive', [pune]);
  cashier = await hire('store_employee', [hyd]);
  const o = api(owner);
  // Business-wide, so both stores deal with it.
  customer = await idOf(
    o.post('/parties', {
      kind: 'organization',
      displayName: 'Sharma Builders',
      roles: ['customer', 'contractor'],
    }),
  );
  const other = await idOf(
    o.post('/parties', { displayName: 'Other Customer', roles: ['customer'] }),
  );
  const lead = (storeId: string, title: string, token: string) =>
    idOf(api(token).post('/leads', { storeId, partyId: customer, title, source: 'phone_call' }));
  ids.hydLead = await lead(hyd, 'Kondapur tower', sales);
  ids.lostLead = await lead(hyd, 'Old enquiry', sales);
  await api(sales).post(`/leads/${ids.lostLead}/lose`, { reason: 'No budget' });
  ids.punLead = await lead(pune, 'Pune villa', punSales);
  const opportunity = (storeId: string, value: number, token: string) =>
    idOf(
      api(token).post('/opportunities', {
        storeId,
        partyId: customer,
        title: 'Order',
        expectedValuePaise: value,
      }),
    );
  ids.openOpportunity = await opportunity(hyd, 1_000, sales);
  ids.wonOpportunity = await opportunity(hyd, 500, sales);
  await api(sales).post(`/opportunities/${ids.wonOpportunity}/win`);
  await opportunity(pune, 7_000, punSales);
  ids.ownProject = await idOf(
    o.post('/projects', { storeId: hyd, customerPartyId: customer, name: 'Own office' }),
  );
  ids.workProject = await idOf(
    o.post('/projects', {
      storeId: hyd,
      customerPartyId: other,
      name: 'Mall repaint',
      city: 'Hyderabad',
      parties: [
        { partyId: customer, role: 'painter' },
        { partyId: customer, role: 'contractor' },
      ],
    }),
  );
  await idOf(
    o.post('/projects', { storeId: pune, customerPartyId: customer, name: 'Pune office' }),
  );
  const activity = (recordType: string, recordId: string, body: object, token = sales) =>
    api(token).post('/activities', {
      recordType,
      recordId,
      type: 'call',
      subject: 'Call',
      ...body,
    });
  // Distinct times, not the database clock of each request: under load the
  // clock of a container may step back, and the order asserted below is by time.
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  await activity('party', customer, { subject: 'Rate enquiry', completedAt: minutesAgo(30) });
  await activity('lead', ids.hydLead, {
    type: 'follow_up',
    subject: 'Send quote',
    dueAt: tomorrow,
  });
  await activity('project', ids.workProject, {
    type: 'meeting',
    subject: 'Site meeting',
    completedAt: minutesAgo(20),
  });
  await activity(
    'lead',
    ids.punLead,
    { subject: 'Pune call', completedAt: minutesAgo(10) },
    punSales,
  );
  // Documents need object storage; the overview only reads their rows.
  await t.connection.db.insert(schema.documents).values({
    organizationId: String((await t.connection.db.select().from(schema.organizations))[0]?.id),
    recordType: 'party',
    recordId: customer,
    category: 'gst_certificate',
    fileName: 'GST.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    storageKey: 'test/gst',
    note: 'Valid till 2027',
    uploadedByMemberId: String(
      (await t.connection.db.select().from(schema.organizationMembers))[0]?.id,
    ),
  });
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('customer 360', () => {
  it('shows a salesperson everything linked to the customer at their stores', async () => {
    const view = await overview(sales);

    expect(view.party).toMatchObject({ id: customer, displayName: 'Sharma Builders' });
    expect(view.leads).toMatchObject({ total: 2, open: 1 });
    expect(view.leads?.items.map((l) => [l.title, l.stage, l.storeCode])).toEqual([
      ['Old enquiry', 'lost', 'HYD'],
      ['Kondapur tower', 'new', 'HYD'],
    ]);
    expect(view.opportunities).toMatchObject({
      total: 2,
      openValuePaise: 1_000,
      wonValuePaise: 500,
    });
    expect(view.projects?.items.map((p) => [p.name, [...p.roles].sort(), p.city]).sort()).toEqual([
      ['Mall repaint', ['contractor', 'painter'], 'Hyderabad'],
      ['Own office', ['customer'], null],
    ]);
    expect(view.activities.total).toBe(3);
    expect(view.activities.items.map((a) => [a.subject, a.record.type, a.status])).toEqual([
      ['Send quote', 'lead', 'scheduled'],
      ['Site meeting', 'project', 'done'],
      ['Rate enquiry', 'party', 'done'],
    ]);
    expect(view.activities.nextFollowUp).toMatchObject({
      subject: 'Send quote',
      dueAt: tomorrow,
      label: expect.stringMatching(/^LD-\d{6} · Kondapur tower$/),
    });
    expect(view.documents).toEqual({
      total: 1,
      items: [
        expect.objectContaining({
          category: 'gst_certificate',
          fileName: 'GST.pdf',
          note: 'Valid till 2027',
        }),
      ],
    });
  });

  it('shows the owner every store', async () => {
    const view = await overview(owner);

    expect([
      view.leads?.total,
      view.opportunities?.total,
      view.projects?.total,
      view.activities.total,
    ]).toEqual([3, 3, 3, 4]);
    expect(view.opportunities?.openValuePaise).toBe(8_000);
  });

  it('leaves out what the member cannot see', async () => {
    const view = await overview(cashier);

    expect(view).toMatchObject({ leads: null, opportunities: null, projects: null });
    expect(view.activities.items.map((a) => a.subject)).toEqual(['Rate enquiry']);
    expect(view.activities.nextFollowUp).toBeNull();
    expect(view.documents.total).toBe(1);
  });

  it('lists the latest ten of each, with full totals', async () => {
    const busy = await idOf(
      api(owner).post('/parties', { displayName: 'Busy Customer', roles: ['customer'] }),
    );
    for (let i = 0; i < 11; i += 1) {
      await api(owner).post('/activities', {
        recordType: 'party',
        recordId: busy,
        type: 'note',
        subject: `Note ${String(i)}`,
        completedAt: new Date(Date.now() - (11 - i) * 60_000).toISOString(),
      });
    }

    const dropped = await idOf(
      api(owner).post('/activities', {
        recordType: 'party',
        recordId: busy,
        type: 'follow_up',
        subject: 'Dropped visit',
        dueAt: tomorrow,
      }),
    );
    await api(owner).post(`/activities/${dropped}/cancel`);

    const view = await overview(owner, busy);

    expect(view.activities.total).toBe(12);
    expect(view.activities.items).toHaveLength(10);
    // Cancelled just now, so it is the latest.
    expect(view.activities.items.map((a) => [a.subject, a.status]).slice(0, 2)).toEqual([
      ['Dropped visit', 'cancelled'],
      ['Note 10', 'done'],
    ]);
    expect(view.activities.nextFollowUp).toBeNull();
    expect(view.leads).toEqual({ total: 0, open: 0, items: [] });
    expect(view.documents).toEqual({ total: 0, items: [] });
  });

  it('answers 404 for parties the member cannot see', async () => {
    const punCustomer = await idOf(
      api(owner).post('/parties', {
        displayName: 'Pune Only',
        phone: uniquePhone(),
        homeStoreId: pune,
        roles: ['customer'],
      }),
    );

    expect((await api(sales).get(`/parties/${punCustomer}/overview`)).statusCode).toBe(404);
    expect(
      (await api(sales).get('/parties/00000000-0000-4000-8000-000000000000/overview')).statusCode,
    ).toBe(404);
    expect((await api(punSales).get(`/parties/${punCustomer}/overview`)).statusCode).toBe(200);
  });
});
