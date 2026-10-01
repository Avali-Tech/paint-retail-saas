import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuditPage } from '../audit/audit.service.js';
import { NotificationsWorker } from '../notifications/notifications-worker.js';
import type { PartyOverview } from '../parties/party-overview.service.js';
import { istDate } from '../test-support/business.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { LoyaltySettings } from './loyalty-lookups.js';
import type { LoyaltyView } from './loyalty.service.js';

let database: TestDatabase;
let t: TestApp;
let owner: string;
/** Branch manager at Hyderabad: runs loyalty, but not the business-wide programme. */
let manager: string;
/** Sales executive at Hyderabad: looks after the painter. */
let sales: string;
/** Store employee at Hyderabad: can see points only. */
let cashier: string;
/** Inventory manager: cannot see loyalty. */
let stock: string;
const ids: Record<string, string> = {};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
});
const id = (key: string) => String(ids[key]);
const message = (response: { body: string }) =>
  (JSON.parse(response.body) as { message: string }).message;
const ghost = '00000000-0000-4000-8000-000000000000';
const loyalty = (key: string, token = owner, query = '') =>
  api(token).get(`/parties/${id(key)}/loyalty${query}`);
const view = async (key: string, query = '?limit=200') =>
  (await loyalty(key, owner, query)).json<LoyaltyView>();
const post = (key: string, path: string, body: object, token = manager) =>
  api(token).post(`/parties/${id(key)}/loyalty/${path}`, body);
const worker = () => t.app.get(NotificationsWorker);
const inbox = async (token: string) =>
  (await api(token).get('/notifications'))
    .json<{ items: { event: string; title: string; body: string; link: string }[] }>()
    .items.filter((n) => n.event === 'loyalty_tier_reached');

const programme: LoyaltySettings = {
  earnPoints: 1,
  earnPerPaise: 10_000,
  tiers: [
    { name: 'Gold', minPoints: 5_000 },
    { name: 'Silver', minPoints: 1_000 },
  ],
  expiryDays: 365,
  minRedemptionPoints: 100,
};

async function newParty(name: string, homeStoreId?: string): Promise<string> {
  const response = await api(owner).post('/parties', {
    displayName: name,
    phone: uniquePhone(),
    roles: ['painter'],
    ...(homeStoreId ? { homeStoreId } : {}),
  });
  return response.json<{ id: string }>().id;
}

/** Enrols a business-wide party, as the owner. */
async function enrolled(name: string): Promise<string> {
  const party = await newParty(name);
  const response = await api(owner).post(`/parties/${party}/loyalty`);
  if (response.statusCode !== 201) throw new Error(response.body);
  return party;
}

/** Writes a ledger entry directly, e.g. one earned long ago, by whoever opened the account. */
async function backdated(
  partyKey: string,
  points: number,
  expiresOn: string | null,
  kind: 'award' | 'redeem' = 'award',
) {
  const [account] = await t.connection.db
    .select()
    .from(schema.loyaltyAccounts)
    .where(eq(schema.loyaltyAccounts.partyId, id(partyKey)));
  await t.connection.db.insert(schema.loyaltyLedger).values({
    organizationId: String(account?.organizationId),
    accountId: String(account?.id),
    kind,
    points,
    expiresOn,
    createdByMemberId: String(account?.createdByMemberId),
  });
}

async function hire(roleKey: string, storeIds: string[]) {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  const member = await api(owner).post('/members', {
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
  return {
    token: login.json<{ token: string }>().token,
    memberId: member.json<{ id: string }>().id,
  };
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
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
  owner = signup.json<{ token: string }>().token;
  ids.hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  ids.puneStore = (await api(owner).post('/stores', { name: 'Pune', code: 'PUN' })).json<{
    id: string;
  }>().id;
  manager = (await hire('branch_manager', [id('hyd')])).token;
  const hiredSales = await hire('sales_executive', [id('hyd')]);
  sales = hiredSales.token;
  ids.salesMember = hiredSales.memberId;
  const hiredCashier = await hire('store_employee', [id('hyd')]);
  cashier = hiredCashier.token;
  ids.cashierMember = hiredCashier.memberId;
  stock = (await hire('inventory_manager', [id('hyd')])).token;
  ids.painter = await newParty('Ravi Painter', id('hyd'));
  ids.contractor = await newParty('Raj Contractors');
  ids.pune = await newParty('Pune Painter', id('puneStore'));
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('accounts', () => {
  it('shows a party without an account as not enrolled, with no points', async () => {
    const response = await loyalty('painter', cashier);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      account: null,
      party: { id: id('painter'), name: 'Ravi Painter' },
      balance: 0,
      totalEarned: 0,
      totalRedeemed: 0,
      tier: null,
      nextTier: null,
      nextExpiry: null,
      ledger: { items: [], total: 0 },
    });
  });

  it('enrols a party once, looked after by a salesperson who handles loyalty', async () => {
    const byCashier = await api(cashier).post(`/parties/${id('painter')}/loyalty`);
    const wrongPerson = await api(manager).post(`/parties/${id('painter')}/loyalty`, {
      assignedMemberId: id('cashierMember'),
    });
    const response = await api(manager).post(`/parties/${id('painter')}/loyalty`, {
      assignedMemberId: id('salesMember'),
    });
    const again = await api(manager).post(`/parties/${id('painter')}/loyalty`);

    expect(byCashier.statusCode).toBe(403);
    expect([wrongPerson.statusCode, message(wrongPerson)]).toEqual([
      400,
      'Choose someone who works at this store and handles loyalty',
    ]);
    expect(response.statusCode).toBe(201);
    expect(response.json<LoyaltyView>().account).toMatchObject({
      status: 'active',
      assignedTo: { memberId: id('salesMember'), name: 'Staff sales_executive' },
    });
    expect([again.statusCode, message(again)]).toEqual([
      409,
      'This party already has a loyalty account',
    ]);
    expect((await api(manager).post(`/parties/${id('contractor')}/loyalty`)).statusCode).toBe(201);
  });

  it('awards points without tiers before the programme is set up', async () => {
    const response = await post('contractor', 'awards', { points: 10 });

    expect(response.json<LoyaltyView>()).toMatchObject({ balance: 10, tier: null });
  });

  it('refuses parties the member cannot see, and parties without an account', async () => {
    expect((await api(manager).post(`/parties/${id('pune')}/loyalty`)).statusCode).toBe(404);
    expect((await api(owner).get(`/parties/${ghost}/loyalty`)).statusCode).toBe(404);
    expect((await api(manager).get(`/parties/${id('pune')}/loyalty`)).statusCode).toBe(404);
    const party = await newParty('Not Enrolled');
    const redeem = await api(owner).post(`/parties/${party}/loyalty/redemptions`, { points: 1 });
    const patch = await api(owner).patch(`/parties/${party}/loyalty`, { status: 'closed' });
    expect([redeem.statusCode, message(redeem)]).toEqual([
      404,
      'This party has no loyalty account',
    ]);
    expect(patch.statusCode).toBe(404);
    expect((await loyalty('painter', stock)).statusCode).toBe(403);
  });
});

describe('programme settings', () => {
  it('starts at 1 point per ₹100 with no tiers and no expiry', async () => {
    expect((await api(cashier).get('/loyalty-settings')).json()).toEqual({
      earnPoints: 1,
      earnPerPaise: 10_000,
      tiers: [],
      expiryDays: null,
      minRedemptionPoints: 0,
    });
  });

  it('is set by members who see every store, with tiers kept in order', async () => {
    const byManager = await api(manager).put('/loyalty-settings', programme);
    const byCashier = await api(cashier).put('/loyalty-settings', programme);
    const duplicate = await api(owner).put('/loyalty-settings', {
      ...programme,
      tiers: [
        { name: 'Gold', minPoints: 1 },
        { name: 'gold', minPoints: 2 },
      ],
    });
    const sameThreshold = await api(owner).put('/loyalty-settings', {
      ...programme,
      tiers: [
        { name: 'Gold', minPoints: 1 },
        { name: 'Silver', minPoints: 1 },
      ],
    });
    const saved = await api(owner).put('/loyalty-settings', programme);

    expect([byManager.statusCode, message(byManager)]).toEqual([
      403,
      'Only members who work at every store can change the programme',
    ]);
    expect(byCashier.statusCode).toBe(403);
    expect(duplicate.statusCode).toBe(400);
    expect(sameThreshold.statusCode).toBe(400);
    expect(saved.json<LoyaltySettings>()).toEqual({
      ...programme,
      tiers: [
        { name: 'Silver', minPoints: 1_000 },
        { name: 'Gold', minPoints: 5_000 },
      ],
    });
    expect((await view('painter')).nextTier).toEqual({
      name: 'Silver',
      minPoints: 1_000,
      pointsToGo: 1_000,
    });
  });
});

describe('earning and spending', () => {
  it('earns on a purchase entered by hand: 500 points on ₹50,000, expiring in a year', async () => {
    const response = await post('painter', 'purchases', {
      manualPurchasePaise: 50_000_00,
      reference: 'INV-1001',
      note: 'Weatherproof for the Kondapur job',
    });

    expect(response.statusCode).toBe(201);
    const result = response.json<LoyaltyView>();
    expect(result).toMatchObject({ balance: 500, totalEarned: 500, totalRedeemed: 0 });
    expect(result.ledger.items[0]).toMatchObject({
      kind: 'purchase',
      points: 500,
      manualPurchasePaise: 50_000_00,
      reference: 'INV-1001',
      note: 'Weatherproof for the Kondapur job',
      expiresOn: istDate(365),
      createdBy: { name: 'Staff branch_manager' },
    });
    expect(result.nextExpiry).toEqual({ points: 500, expiresOn: istDate(365) });
    const tiny = await post('painter', 'purchases', { manualPurchasePaise: 99_99, reference: 'X' });
    expect([tiny.statusCode, message(tiny)]).toEqual([
      400,
      'This purchase is too small to earn points',
    ]);
  });

  it('awards points by hand or for a campaign', async () => {
    await post('painter', 'awards', { points: 100, note: 'Referred a builder' });
    const campaign = (
      await post('painter', 'awards', { points: 50, campaign: 'Diwali 2026' })
    ).json<LoyaltyView>();

    expect(campaign.ledger.items.slice(0, 2).map((e) => [e.kind, e.points, e.reference])).toEqual([
      ['campaign', 50, 'Diwali 2026'],
      ['award', 100, null],
    ]);
    expect(campaign.balance).toBe(650);
  });

  it('redeems no less than the minimum and no more than the balance', async () => {
    const redeemed = await post('painter', 'redemptions', { points: 200, note: 'Brush set' });
    const small = await post('painter', 'redemptions', { points: 50 });
    const tooMuch = await post('painter', 'redemptions', { points: 1_000 });

    expect(redeemed.statusCode).toBe(201);
    expect(redeemed.json<LoyaltyView>()).toMatchObject({ balance: 450, totalRedeemed: 200 });
    expect(redeemed.json<LoyaltyView>().ledger.items[0]).toMatchObject({
      kind: 'redeem',
      points: -200,
      expiresOn: null,
    });
    expect([small.statusCode, message(small)]).toEqual([400, 'Redeem at least 100 points']);
    expect([tooMuch.statusCode, message(tooMuch)]).toEqual([409, 'Only 450 points are available']);
  });

  it('adjusts with a reason, never below zero', async () => {
    const up = await post('painter', 'adjustments', { points: 20, reason: 'Missed bill INV-998' });
    const below = await post('painter', 'adjustments', { points: -1_000, reason: 'Oops' });
    const down = await post('painter', 'adjustments', { points: -20, reason: 'Duplicate award' });
    const zero = await post('painter', 'adjustments', { points: 0, reason: 'Nothing' });
    const noReason = await post('painter', 'adjustments', { points: 5 });

    expect(up.json<LoyaltyView>().balance).toBe(470);
    expect([below.statusCode, message(below)]).toEqual([409, 'Only 470 points are available']);
    expect(down.json<LoyaltyView>()).toMatchObject({ balance: 450, totalEarned: 670 });
    expect(zero.statusCode).toBe(400);
    expect(noReason.statusCode).toBe(400);
  });

  it('always shows a balance equal to the sum of the ledger', async () => {
    const all = await view('painter');
    const page = await view('painter', '?limit=2&offset=1');

    expect(all.balance).toBe(all.ledger.items.reduce((sum, entry) => sum + entry.points, 0));
    expect(all.ledger.total).toBe(6);
    expect(page.ledger.items.map((e) => e.id)).toEqual(
      all.ledger.items.slice(1, 3).map((e) => e.id),
    );
    expect(page.ledger.total).toBe(6);
  });

  it('lets only one of two redemptions at once spend the same points', async () => {
    const party = await enrolled('Twin Painter');
    ids.twin = party;
    await post('twin', 'awards', { points: 300 }, owner);

    const both = await Promise.all([
      post('twin', 'redemptions', { points: 200 }, owner),
      post('twin', 'redemptions', { points: 200 }, manager),
    ]);

    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await view('twin')).balance).toBe(100);
  });
});

describe('tiers', () => {
  it('tells the salesperson when the party reaches a new tier, once', async () => {
    expect(await inbox(sales)).toEqual([]);
    const silver = (
      await post('painter', 'purchases', { manualPurchasePaise: 40_000_00, reference: 'INV-1002' })
    ).json<LoyaltyView>();
    await post('painter', 'awards', { points: 10 });

    expect(silver).toMatchObject({
      totalEarned: 1_070,
      tier: { name: 'Silver', minPoints: 1_000 },
      nextTier: { name: 'Gold', pointsToGo: 3_930 },
    });
    expect(await inbox(sales)).toEqual([
      expect.objectContaining({
        title: 'Ravi Painter reached Silver',
        body: '1070 points earned, 850 to spend',
        link: `/parties/${id('painter')}`,
      }),
    ]);
  });

  it('tells nobody when the account has no salesperson', async () => {
    const response = await post('contractor', 'awards', { points: 1_000 });

    expect(response.json<LoyaltyView>().tier?.name).toBe('Silver');
    expect(await inbox(sales)).toHaveLength(1);
  });
});

describe('closing and reassigning', () => {
  it('stops points moving on a closed account until it is reopened', async () => {
    const closed = await api(manager).patch(`/parties/${id('contractor')}/loyalty`, {
      status: 'closed',
    });
    const award = await post('contractor', 'awards', { points: 5 });
    await api(manager).patch(`/parties/${id('contractor')}/loyalty`, { status: 'active' });

    expect(closed.json<LoyaltyView>().account?.status).toBe('closed');
    expect([award.statusCode, message(award)]).toEqual([409, 'This loyalty account is closed']);
    expect((await post('contractor', 'awards', { points: 5 })).statusCode).toBe(201);
  });

  it('changes or removes the salesperson', async () => {
    const assigned = await api(manager).patch(`/parties/${id('contractor')}/loyalty`, {
      assignedMemberId: id('salesMember'),
    });
    const removed = await api(manager).patch(`/parties/${id('contractor')}/loyalty`, {
      assignedMemberId: null,
    });
    const wrong = await api(manager).patch(`/parties/${id('contractor')}/loyalty`, {
      assignedMemberId: id('cashierMember'),
    });
    const empty = await api(manager).patch(`/parties/${id('contractor')}/loyalty`, {});

    expect(assigned.json<LoyaltyView>().account?.assignedTo?.memberId).toBe(id('salesMember'));
    expect(removed.json<LoyaltyView>().account?.assignedTo).toBeNull();
    expect(wrong.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
  });
});

describe('expiry', () => {
  it('writes off unused expired points once a day, soonest-expiring used first', async () => {
    ids.old = await enrolled('Old Painter');
    await backdated('old', 100, istDate(-1));
    await backdated('old', 50, istDate(10));
    // Expired but already spent: nothing to write off.
    ids.spent = await enrolled('Spent Painter');
    await backdated('spent', 100, istDate(-5));
    await backdated('spent', -100, null, 'redeem');

    const first = await worker().runOnce();
    const again = await worker().expireLoyaltyPoints();

    expect(first.loyaltyExpiries).toBe(1);
    expect(again).toBe(0);
    const old = await view('old');
    expect(old).toMatchObject({
      balance: 50,
      totalEarned: 150,
      nextExpiry: { points: 50, expiresOn: istDate(10) },
    });
    expect(old.ledger.items[0]).toMatchObject({
      kind: 'expire',
      points: -100,
      note: 'Points expired unused',
      createdBy: null,
    });
    expect((await view('spent')).balance).toBe(0);
  });

  it('writes off expired points before a redemption, so they cannot be spent', async () => {
    ids.lazy = await enrolled('Late Painter');
    await backdated('lazy', 100, istDate(-1));
    await backdated('lazy', 100, null);

    const tooMuch = await post('lazy', 'redemptions', { points: 150 }, owner);
    const redeemed = await post('lazy', 'redemptions', { points: 100 }, owner);

    expect(message(tooMuch)).toBe('Only 100 points are available');
    expect(redeemed.json<LoyaltyView>().ledger.items.map((e) => [e.kind, e.points])).toEqual([
      ['redeem', -100],
      ['expire', -100],
      ['award', 100],
      ['award', 100],
    ]);
  });

  it('lets only one server expire points at a time', async () => {
    const holder = new pg.Client({ connectionString: database.connectionString });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('paint:loyalty-expiry'))`);
      expect(await worker().expireLoyaltyPoints()).toBe(0);
    } finally {
      await holder.end();
    }
  });
});

describe('lists and the customer 360', () => {
  it('lists accounts with the most points first, within the member’s stores', async () => {
    await api(owner).post(`/parties/${id('pune')}/loyalty`);
    const names = async (token: string, query = '') =>
      (await api(token).get(`/loyalty-accounts?limit=200${query}`))
        .json<{ items: { party: { name: string }; balance: number; tier: unknown }[] }>()
        .items.map((item) => item.party.name);
    const page = (await api(owner).get('/loyalty-accounts?limit=2')).json<{
      items: { party: { name: string }; balance: number; totalEarned: number; tier: unknown }[];
      total: number;
    }>();

    expect(page.items[0]).toEqual({
      party: { id: id('contractor'), name: 'Raj Contractors' },
      status: 'active',
      balance: 1_015,
      totalEarned: 1_015,
      tier: { name: 'Silver', minPoints: 1_000 },
    });
    expect(page.items[1]?.party.name).toBe('Ravi Painter');
    expect(page.total).toBe(7);
    expect(await names(owner)).toContain('Pune Painter');
    expect(await names(manager)).not.toContain('Pune Painter');
    expect(await names(owner, '&q=twin')).toEqual(['Twin Painter']);
    await api(owner).patch(`/parties/${id('twin')}/loyalty`, { status: 'closed' });
    expect(await names(owner, '&status=closed')).toEqual(['Twin Painter']);
  });

  it('shows points in the customer 360 to those who may see loyalty', async () => {
    const overview = (
      await api(cashier).get(`/parties/${id('painter')}/overview`)
    ).json<PartyOverview>();
    const hidden = (
      await api(stock).get(`/parties/${id('contractor')}/overview`)
    ).json<PartyOverview>();

    expect(overview.loyalty).toMatchObject({
      account: { status: 'active' },
      balance: 860,
      tier: { name: 'Silver' },
    });
    expect(hidden.loyalty).toBeNull();
  });
});

describe('audit', () => {
  it('records programme changes, account status and every adjustment', async () => {
    const audit = async (table: string) =>
      (await api(owner).get(`/audit-log?table=${table}&limit=200`)).json<AuditPage>();
    const settings = await audit('loyalty_settings');
    const adjustments = await audit('loyalty_ledger');
    const accounts = await audit('loyalty_accounts');

    expect(settings.items.map((e) => [e.action, e.recordLabel, e.area])).toEqual([
      ['insert', 'Loyalty programme', 'Loyalty programme'],
    ]);
    expect(settings.items[0]?.changes.map((c) => [c.label, c.newText])).toEqual([
      ['Points earned', '1'],
      ['For every', '₹100.00'],
      ['Tiers', '[{"name":"Silver","minPoints":1000},{"name":"Gold","minPoints":5000}]'],
      ['Points expire after (days)', '365'],
      ['Minimum redemption', '100'],
    ]);
    expect(
      adjustments.items.map((e) => [e.recordLabel, ...e.changes.map((c) => c.newText)]),
    ).toEqual([
      ['Ravi Painter', 'Duplicate award', '-20'],
      ['Ravi Painter', 'Missed bill INV-998', '20'],
    ]);
    expect(adjustments.items[0]?.actor?.name).toBe('Staff branch_manager');
    expect(
      accounts.items
        .filter((e) => e.action === 'update')
        .map((e) => [
          e.recordLabel,
          ...e.changes.map((c) => `${String(c.oldText)}→${String(c.newText)}`),
        ]),
    ).toEqual([
      ['Twin Painter', 'active→closed'],
      ['Raj Contractors', 'closed→active'],
      ['Raj Contractors', 'active→closed'],
    ]);
  });
});
