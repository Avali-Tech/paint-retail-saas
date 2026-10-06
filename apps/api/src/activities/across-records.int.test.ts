import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

// Activities across records (GET /activities without a record) and everyone's
// follow-ups (GET /activities/follow-ups?assignedTo=everyone), in one business
// with two stores, a second business, and roles that see different records.

interface Activity {
  id: string;
  record: { type: string; id: string; label: string };
  subject: string;
  assignedTo: { memberId: string };
}
interface Page {
  items: Activity[];
  total: number;
  counts?: { overdue: number; today: number };
}

let database: TestDatabase;
let t: TestApp;
const tokens = { owner: '', manager: '', salesHyd: '', salesPun: '', stockman: '', other: '' };
const members: Record<string, string> = {};
const ids: Record<string, string> = {};

const get = (token: string, url: string) =>
  t.app.inject({ method: 'GET', url, headers: bearer(token) });
const post = (token: string, url: string, payload: object) =>
  t.app.inject({ method: 'POST', url, headers: bearer(token), payload });
const idOf = async (response: ReturnType<typeof post>) =>
  (await response).json<{ id: string }>().id;
const subjects = (page: Page) => page.items.map((item) => item.subject);
const page = async (token: string, url: string) => (await get(token, url)).json<Page>();

/** A date in India, `days` from today, as YYYY-MM-DD. */
const istDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
const at = (days: number, time: string) => `${istDate(days)}T${time}+05:30`;

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

async function hire(key: keyof typeof tokens, roleKey: string, storeIds: string[], name: string) {
  const roles = (await get(tokens.owner, '/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  members[key] = await idOf(
    post(tokens.owner, '/members', {
      fullName: name,
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
  tokens[key] = login.json<{ token: string }>().token;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  tokens.owner = await signup('Across Paints');
  const owner = tokens.owner;
  ids.hyd = await idOf(post(owner, '/stores', { name: 'Hyderabad', code: 'HYD' }));
  ids.pune = await idOf(post(owner, '/stores', { name: 'Pune', code: 'PUN' }));
  await hire('manager', 'branch_manager', [ids.hyd], 'Meena Manager');
  await hire('salesHyd', 'sales_executive', [ids.hyd], 'Ravi Sales');
  await hire('salesPun', 'sales_executive', [ids.pune], 'Pooja Sales');
  await hire('stockman', 'inventory_manager', [ids.hyd], 'Stock Lead');
  ids.customer = await idOf(
    post(owner, '/parties', {
      displayName: 'Sharma Builders',
      phone: uniquePhone(),
      homeStoreId: ids.hyd,
      roles: ['customer'],
    }),
  );
  ids.punCustomer = await idOf(
    post(owner, '/parties', {
      displayName: 'Pune Customer',
      phone: uniquePhone(),
      homeStoreId: ids.pune,
      roles: ['customer'],
    }),
  );
  ids.supplier = await idOf(
    post(owner, '/parties', {
      kind: 'organization',
      displayName: 'Asian Depot',
      roles: ['supplier'],
    }),
  );
  ids.lead = await idOf(
    post(owner, '/leads', {
      storeId: ids.hyd,
      partyId: ids.customer,
      title: 'Kondapur tower',
      source: 'walk_in',
    }),
  );
  ids.punLead = await idOf(
    post(owner, '/leads', {
      storeId: ids.pune,
      partyId: ids.punCustomer,
      title: 'Pune villa',
      source: 'walk_in',
    }),
  );
  ids.project = await idOf(
    post(owner, '/projects', {
      storeId: ids.hyd,
      customerPartyId: ids.customer,
      name: 'Tower site',
    }),
  );

  const log = (token: string, recordType: string, recordId: string, body: object) =>
    post(token, '/activities', { recordType, recordId, ...body });
  // Latest first: 2, 8, 5, 4, 6, 3, 1, 7.
  await log(tokens.salesHyd, 'lead', ids.lead, {
    type: 'call',
    subject: '1 Called',
    completedAt: at(-3, '12:00:00'),
  });
  await log(owner, 'lead', ids.lead, {
    type: 'follow_up',
    subject: '2 Send quote',
    dueAt: at(1, '10:00:00'),
    assignedMemberId: members.salesHyd,
  });
  await log(tokens.salesPun, 'lead', ids.punLead, {
    type: 'visit',
    subject: '3 Pune visit',
    completedAt: at(-2, '12:00:00'),
  });
  await log(tokens.salesHyd, 'party', ids.supplier, {
    type: 'whatsapp',
    subject: '4 Rate list',
    completedAt: at(-1, '12:00:00'),
  });
  await log(owner, 'party', ids.customer, {
    type: 'note',
    subject: '5 Note',
    completedAt: at(0, '00:01:00'),
  });
  await log(owner, 'party', ids.punCustomer, {
    type: 'follow_up',
    subject: '6 Pune chase',
    dueAt: at(-1, '09:00:00'),
    assignedMemberId: members.salesPun,
  });
  await log(owner, 'project', ids.project, {
    type: 'meeting',
    subject: '7 Kick-off',
    completedAt: at(-5, '12:00:00'),
    assignedMemberId: members.salesHyd,
  });
  await log(owner, 'party', ids.supplier, {
    type: 'follow_up',
    subject: '8 Chase rates',
    dueAt: at(0, '23:59:00'),
    assignedMemberId: members.salesHyd,
  });

  // Another business: never seen.
  tokens.other = await signup('Other Paints');
  const otherParty = await idOf(
    post(tokens.other, '/parties', { displayName: 'Other Party', roles: ['customer'] }),
  );
  await log(tokens.other, 'party', otherParty, {
    type: 'follow_up',
    subject: 'Other business',
    dueAt: at(0, '23:00:00'),
  });
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('activities across records', () => {
  it('lists every activity the member can see, latest first, with each record named', async () => {
    const all = await page(tokens.owner, '/activities');

    expect(subjects(all)).toEqual([
      '2 Send quote',
      '8 Chase rates',
      '5 Note',
      '4 Rate list',
      '6 Pune chase',
      '3 Pune visit',
      '1 Called',
      '7 Kick-off',
    ]);
    expect(all.total).toBe(8);
    expect(all.items[0]?.record.label).toMatch(/^LD-\d{6} · Kondapur tower$/);
    expect(all.items[1]?.record).toMatchObject({ type: 'party', label: 'Asian Depot' });
    expect(subjects(await page(tokens.other, '/activities'))).toEqual(['Other business']);
  });

  it('keeps to the records each role can see, at its stores', async () => {
    const manager = await page(tokens.manager, '/activities');
    const pune = await page(tokens.salesPun, '/activities');
    // Inventory managers see parties, but not leads or projects.
    const stock = await page(tokens.stockman, '/activities');

    expect(subjects(manager)).toEqual([
      '2 Send quote',
      '8 Chase rates',
      '5 Note',
      '4 Rate list',
      '1 Called',
      '7 Kick-off',
    ]);
    expect(subjects(pune)).toEqual([
      '8 Chase rates',
      '4 Rate list',
      '6 Pune chase',
      '3 Pune visit',
    ]);
    expect(subjects(stock)).toEqual(['8 Chase rates', '5 Note', '4 Rate list']);
    expect(stock.total).toBe(3);
  });

  it('filters by type, record type, person, India-time days, and pages', async () => {
    const list = (query: string) => page(tokens.owner, `/activities?${query}`);

    expect(subjects(await list('type=follow_up'))).toEqual([
      '2 Send quote',
      '8 Chase rates',
      '6 Pune chase',
    ]);
    expect(subjects(await list('recordType=party'))).toEqual([
      '8 Chase rates',
      '5 Note',
      '4 Rate list',
      '6 Pune chase',
    ]);
    // Assigned to them or logged by them.
    const ravi = ['2 Send quote', '8 Chase rates', '4 Rate list', '1 Called', '7 Kick-off'];
    expect(subjects(await list(`person=${String(members.salesHyd)}`))).toEqual(ravi);
    expect(subjects(await page(tokens.salesHyd, '/activities?person=me'))).toEqual(ravi);
    expect(subjects(await list(`from=${istDate(-2)}&to=${istDate(-1)}`))).toEqual([
      '4 Rate list',
      '6 Pune chase',
      '3 Pune visit',
    ]);
    expect(await list('limit=2&offset=2')).toMatchObject({
      total: 8,
      items: [{ subject: '5 Note' }, { subject: '4 Rate list' }],
    });
    // A record's timeline takes the same filters.
    expect(subjects(await list(`recordType=lead&recordId=${String(ids.lead)}&type=call`))).toEqual([
      '1 Called',
    ]);
    expect(subjects(await page(tokens.stockman, '/activities?recordType=lead'))).toEqual([]);
  });

  it.each([
    [`recordId=00000000-0000-4000-8000-000000000000`, 'recordType'],
    ['from=2026-10-05&to=2026-10-01', 'to'],
    ['person=someone', 'person'],
    ['from=2026-13-01', 'from'],
  ])('answers 400 for %s', async (query, field) => {
    const response = await get(tokens.owner, `/activities?${query}`);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });
});

describe('everyone’s follow-ups', () => {
  it('shows managers the team’s open follow-ups at their stores, soonest first', async () => {
    const owner = await page(tokens.owner, '/activities/follow-ups?assignedTo=everyone');
    const manager = await page(tokens.manager, '/activities/follow-ups?assignedTo=everyone');
    const today = await page(tokens.owner, '/activities/follow-ups?assignedTo=everyone&when=today');
    const pune = await page(
      tokens.owner,
      `/activities/follow-ups?assignedTo=everyone&storeId=${String(ids.pune)}`,
    );

    expect(subjects(owner)).toEqual(['6 Pune chase', '8 Chase rates', '2 Send quote']);
    expect(owner).toMatchObject({ total: 3, counts: { overdue: 1, today: 1 } });
    expect(owner.items.map((item) => item.assignedTo.memberId)).toEqual([
      members.salesPun,
      members.salesHyd,
      members.salesHyd,
    ]);
    expect(subjects(manager)).toEqual(['8 Chase rates', '2 Send quote']);
    expect(manager.counts).toEqual({ overdue: 0, today: 1 });
    expect(subjects(today)).toEqual(['8 Chase rates']);
    expect(subjects(pune)).toEqual(['6 Pune chase']);
    expect(
      subjects(await page(tokens.other, '/activities/follow-ups?assignedTo=everyone')),
    ).toEqual(['Other business']);
  });

  it('is for members who can see the team, and keeps to records they can see', async () => {
    const refused = await get(tokens.salesHyd, '/activities/follow-ups?assignedTo=everyone');
    const elsewhere = await get(
      tokens.manager,
      `/activities/follow-ups?assignedTo=everyone&storeId=${String(ids.pune)}`,
    );
    // A colleague's follow-ups, without the lead the inventory manager cannot see.
    const colleague = await page(
      tokens.stockman,
      `/activities/follow-ups?assignedTo=${String(members.salesHyd)}`,
    );

    expect([refused.statusCode, refused.json<{ message: string }>().message]).toEqual([
      403,
      'Only members who can see the team see everyone’s follow-ups',
    ]);
    expect(elsewhere.statusCode).toBe(404);
    expect(subjects(colleague)).toEqual(['8 Chase rates']);
  });
});
