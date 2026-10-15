import { migrateDatabase } from '@paint/db';
import type { CreditCheck, CreditRules } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuditPage } from '../audit/audit.service.js';
import type { PartyOverview } from '../parties/party-overview.service.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import type { CreditListItem, CreditRequestView, CreditView } from './credit.service.js';
import { finishSignIn } from '../test-support/two-factor.js';

let database: TestDatabase;
let t: TestApp;
let owner: string;
/** Organization admin: approves, and hears about requests the owner makes. */
let admin: string;
/** Branch manager at Hyderabad: can request credit and hold accounts, not approve. */
let manager: string;
/** Sales executive at Hyderabad: can request credit. */
let sales: string;
/** Store employee at Hyderabad: cannot see credit. */
let cashier: string;
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

const credit = async (token: string, partyKey: string) =>
  (await api(token).get(`/parties/${id(partyKey)}/credit`)).json<CreditView>();
const check = async (partyKey: string, amountPaise?: number) =>
  (
    await api(owner).get(
      `/parties/${id(partyKey)}/credit/check${amountPaise === undefined ? '' : `?amountPaise=${String(amountPaise)}`}`,
    )
  ).json<CreditCheck>();
const inbox = async (token: string, event: string) =>
  (await api(token).get('/notifications'))
    .json<{ items: { event: string; title: string; body: string; link: string }[] }>()
    .items.filter((n) => n.event === event);

async function newParty(name: string, homeStoreId?: string): Promise<string> {
  const response = await api(owner).post('/parties', {
    displayName: name,
    phone: uniquePhone(),
    roles: ['contractor'],
    ...(homeStoreId ? { homeStoreId } : {}),
  });
  return response.json<{ id: string }>().id;
}

async function hire(roleKey: string, storeIds: string[], allStores = false) {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  const member = await api(owner).post('/members', {
    fullName: `Staff ${roleKey}`,
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    storeIds,
    allStores,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  const { token } = await finishSignIn<{ token: string }>(t, login, phone);
  return { token, memberId: member.json<{ id: string }>().id };
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
  admin = (await hire('org_admin', [], true)).token;
  const hiredManager = await hire('branch_manager', [id('hyd')]);
  manager = hiredManager.token;
  ids.managerMember = hiredManager.memberId;
  sales = (await hire('sales_executive', [id('hyd')])).token;
  cashier = (await hire('store_employee', [id('hyd')])).token;
  ids.raj = await newParty('Raj Contractors', id('hyd'));
  ids.wide = await newParty('Sri Painters');
  ids.pune = await newParty('Pune Builders', id('puneStore'));
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('a party without credit', () => {
  it('has no credit until a request is approved, and every sale on credit is blocked', async () => {
    const view = await credit(manager, 'raj');

    expect(view).toEqual({
      party: { id: id('raj'), name: 'Raj Contractors', phone: expect.any(String) as string },
      status: 'none',
      limitPaise: 0,
      creditDays: 0,
      risk: 'low',
      manualExposurePaise: 0,
      exposurePaise: 0,
      exposureSource: 'manual',
      exposure: null,
      overdueDays: 0,
      holdKind: null,
      overdueWaivedUntil: null,
      check: {
        decision: 'blocked',
        blockedBecause: 'no_credit',
        projectedExposurePaise: 0,
        availablePaise: 0,
        utilizationPercent: null,
      },
      pendingRequest: null,
      pendingRelease: null,
      sites: [],
      hold: null,
      notes: null,
      approvedBy: null,
      approvedAt: null,
      exposureUpdatedAt: null,
      rules: { normalUpToPercent: 80, managerUpToPercent: 100, holdAfterOverdueDays: 30 },
    });
  });

  it('cannot be put on hold', async () => {
    const response = await api(manager).post(`/parties/${id('wide')}/credit/hold`, {
      reason: 'Bounced cheque',
    });

    expect([response.statusCode, message(response)]).toEqual([
      409,
      'This party has no credit to hold',
    ]);
  });
});

describe('requesting and approving credit', () => {
  let request: CreditRequestView;

  it('asks the approvers at the party’s store, but not the requester', async () => {
    const response = await api(manager).post('/credit-requests', {
      partyId: id('raj'),
      limitPaise: 30_000_00,
      creditDays: 30,
      note: 'Regular buyer for 3 years',
    });

    expect(response.statusCode).toBe(201);
    request = response.json<CreditRequestView>();
    expect(request).toMatchObject({
      number: expect.stringMatching(/^CR-\d{6}$/) as string,
      party: { id: id('raj'), name: 'Raj Contractors' },
      limitPaise: 30_000_00,
      creditDays: 30,
      previousLimitPaise: 0,
      previousCreditDays: 0,
      note: 'Regular buyer for 3 years',
      status: 'pending',
      requestedBy: { memberId: id('managerMember'), name: 'Staff branch_manager' },
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    });
    const [notice] = await inbox(owner, 'credit_request_awaiting_approval');
    expect(notice).toEqual(
      expect.objectContaining({
        title: `Credit request ${request.number}: Raj Contractors`,
        body: '₹30,000.00 for 30 days (now ₹0.00, 0 days)',
        link: `/credit-requests/${request.id}`,
      }),
    );
    expect(await inbox(admin, 'credit_request_awaiting_approval')).toHaveLength(1);
    expect(await inbox(manager, 'credit_request_awaiting_approval')).toEqual([]);
    expect((await credit(sales, 'raj')).pendingRequest).toEqual({
      id: request.id,
      number: request.number,
      limitPaise: 30_000_00,
      creditDays: 30,
    });
  });

  it('allows one waiting request per party', async () => {
    const again = await api(sales).post('/credit-requests', {
      partyId: id('raj'),
      limitPaise: 40_000_00,
      creditDays: 30,
    });

    expect([again.statusCode, message(again)]).toEqual([
      409,
      `${request.number} is already waiting for approval`,
    ]);
  });

  it('is decided only by approvers', async () => {
    expect((await api(manager).post(`/credit-requests/${request.id}/approve`)).statusCode).toBe(
      403,
    );
    expect((await api(sales).post(`/credit-requests/${request.id}/approve`)).statusCode).toBe(403);
  });

  it('gives the party the limit and days, and tells the requester', async () => {
    const response = await api(owner).post(`/credit-requests/${request.id}/approve`, {
      note: 'Approved for the Kondapur job',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<CreditRequestView>()).toMatchObject({
      status: 'approved',
      decidedBy: { name: 'Anil Owner' },
      decisionNote: 'Approved for the Kondapur job',
    });
    const view = await credit(manager, 'raj');
    expect(view).toMatchObject({
      status: 'active',
      limitPaise: 30_000_00,
      creditDays: 30,
      approvedBy: { name: 'Anil Owner' },
      pendingRequest: null,
      check: { decision: 'allowed', availablePaise: 30_000_00, utilizationPercent: 0 },
    });
    expect(view.approvedAt).toEqual(expect.any(String));
    const [notice] = await inbox(manager, 'credit_request_decided');
    expect(notice).toMatchObject({
      title: `Credit request ${request.number} approved: Raj Contractors`,
      body: '₹30,000.00 for 30 days\nApproved for the Kondapur job',
    });
    const again = await api(owner).post(`/credit-requests/${request.id}/reject`, {
      reason: 'Too late',
    });
    expect([again.statusCode, message(again)]).toEqual([409, 'This request is approved']);
  });

  it('refuses a request that changes nothing', async () => {
    const same = await api(manager).post('/credit-requests', {
      partyId: id('raj'),
      limitPaise: 30_000_00,
      creditDays: 30,
    });

    expect([same.statusCode, message(same)]).toEqual([
      400,
      'This party already has this limit and these days',
    ]);
  });

  it('rejects with a reason, keeping the current terms', async () => {
    const longer = await api(sales).post('/credit-requests', {
      partyId: id('raj'),
      limitPaise: 30_000_00,
      creditDays: 45,
    });
    const rejected = await api(owner).post(
      `/credit-requests/${longer.json<CreditRequestView>().id}/reject`,
      { reason: 'Pays late already' },
    );

    expect(longer.json<CreditRequestView>()).toMatchObject({
      previousLimitPaise: 30_000_00,
      previousCreditDays: 30,
    });
    expect(rejected.json<CreditRequestView>()).toMatchObject({
      status: 'rejected',
      decisionNote: 'Pays late already',
    });
    expect((await credit(owner, 'raj')).creditDays).toBe(30);
    expect((await api(owner).post(`/credit-requests/${request.id}/reject`, {})).statusCode).toBe(
      400,
    );
  });

  it('raises a limit when approved without a note', async () => {
    const raise = await api(manager).post('/credit-requests', {
      partyId: id('raj'),
      limitPaise: 50_000_00,
      creditDays: 30,
    });
    await api(owner).post(`/credit-requests/${raise.json<CreditRequestView>().id}/approve`);

    expect((await credit(owner, 'raj')).limitPaise).toBe(50_000_00);
    const [notice] = await inbox(manager, 'credit_request_decided');
    expect(notice?.body).toBe('₹50,000.00 for 30 days');
  });

  it('asks every approver about a business-wide party, except the owner who asked', async () => {
    const before = (await inbox(admin, 'credit_request_awaiting_approval')).length;
    const response = await api(owner).post('/credit-requests', {
      partyId: id('wide'),
      limitPaise: 10_000_00,
      creditDays: 15,
    });

    expect(response.statusCode).toBe(201);
    expect(await inbox(admin, 'credit_request_awaiting_approval')).toHaveLength(before + 1);
    // Owners may approve their own requests; nobody else needs telling.
    await api(owner).post(`/credit-requests/${response.json<CreditRequestView>().id}/approve`);
    expect((await credit(owner, 'wide')).status).toBe('active');
  });

  it('lets only one of two requests made at once through', async () => {
    const party = await newParty('Twin Painters');
    const both = await Promise.all([
      api(manager).post('/credit-requests', { partyId: party, limitPaise: 100, creditDays: 7 }),
      api(sales).post('/credit-requests', { partyId: party, limitPaise: 200, creditDays: 7 }),
    ]);

    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('refuses unknown or unreachable parties and requests', async () => {
    const unknown = await api(manager).post('/credit-requests', {
      partyId: ghost,
      limitPaise: 100,
      creditDays: 0,
    });
    const pune = await api(manager).post('/credit-requests', {
      partyId: id('pune'),
      limitPaise: 100,
      creditDays: 0,
    });

    expect([unknown.statusCode, message(unknown)]).toEqual([400, 'Unknown party']);
    expect([pune.statusCode, message(pune)]).toEqual([400, 'Unknown party']);
    expect((await api(owner).get(`/credit-requests/${ghost}`)).statusCode).toBe(404);
    expect((await api(owner).post(`/credit-requests/${ghost}/approve`)).statusCode).toBe(404);
    expect((await api(manager).get(`/parties/${id('pune')}/credit`)).statusCode).toBe(404);
    expect((await api(owner).get(`/parties/${ghost}/credit`)).statusCode).toBe(404);
    expect((await api(cashier).get(`/parties/${id('raj')}/credit`)).statusCode).toBe(403);
  });
});

describe('requests list', () => {
  it('filters by status and party, within the member’s stores', async () => {
    const puneRequest = (
      await api(owner).post('/credit-requests', {
        partyId: id('pune'),
        limitPaise: 5_000_00,
        creditDays: 7,
      })
    ).json<CreditRequestView>();

    const forRaj = (await api(owner).get(`/credit-requests?partyId=${id('raj')}`)).json<{
      items: CreditRequestView[];
      total: number;
    }>();
    const rejected = (await api(owner).get('/credit-requests?status=rejected')).json<{
      items: CreditRequestView[];
    }>();
    const managerSees = (await api(manager).get('/credit-requests?limit=200')).json<{
      items: CreditRequestView[];
    }>();

    expect(forRaj.total).toBe(3);
    expect(forRaj.items.map((r) => r.limitPaise)).toEqual([50_000_00, 30_000_00, 30_000_00]);
    expect(rejected.items.map((r) => r.creditDays)).toEqual([45]);
    ids.puneRequest = puneRequest.id;
    expect(managerSees.items.map((r) => r.id)).not.toContain(puneRequest.id);
    expect((await api(manager).get(`/credit-requests/${puneRequest.id}`)).statusCode).toBe(404);
    expect((await api(owner).get(`/credit-requests/${puneRequest.id}`)).statusCode).toBe(200);
  });
});

describe('exposure and checks', () => {
  it('takes what the party owes by hand until billing exists, and checks sales against the rules', async () => {
    // Raj: ₹50,000 limit. The spec's example: ₹18,000 owed, a ₹15,000 order.
    const updated = await api(manager).patch(`/parties/${id('raj')}/credit`, {
      manualExposurePaise: 18_000_00,
    });

    const view = updated.json<CreditView>();
    expect(view).toMatchObject({
      manualExposurePaise: 18_000_00,
      check: { decision: 'allowed', utilizationPercent: 36 },
    });
    expect(view.exposureUpdatedAt).toEqual(expect.any(String));
    expect(await check('raj', 15_000_00)).toEqual({
      decision: 'allowed',
      blockedBecause: null,
      projectedExposurePaise: 33_000_00,
      availablePaise: 17_000_00,
      utilizationPercent: 66,
    });
    expect((await check('raj', 25_000_00)).decision).toBe('manager_approval');
    expect((await check('raj', 40_000_00)).decision).toBe('owner_approval');
    expect((await check('raj')).projectedExposurePaise).toBe(18_000_00);
  });

  it('keeps the exposure time when only risk or notes change, and blocks when long overdue', async () => {
    const before = (await credit(owner, 'raj')).exposureUpdatedAt;
    const risky = (
      await api(manager).patch(`/parties/${id('raj')}/credit`, { risk: 'high', notes: 'Watch' })
    ).json<CreditView>();
    const late = (
      await api(manager).patch(`/parties/${id('raj')}/credit`, { overdueDays: 31 })
    ).json<CreditView>();

    expect(risky).toMatchObject({ risk: 'high', notes: 'Watch', exposureUpdatedAt: before });
    expect(late.check).toMatchObject({ decision: 'blocked', blockedBecause: 'overdue' });
    expect(late.exposureUpdatedAt).not.toBe(before);
    await api(manager).patch(`/parties/${id('raj')}/credit`, { overdueDays: 0, notes: null });
  });

  it('records risk for a party without credit, which stays without credit', async () => {
    const party = await newParty('New Painter', id('hyd'));
    const response = await api(sales).patch(`/parties/${party}/credit`, { risk: 'medium' });

    expect(response.json<CreditView>()).toMatchObject({
      status: 'none',
      risk: 'medium',
      exposureUpdatedAt: null,
    });
    expect((await api(sales).patch(`/parties/${party}/credit`, {})).statusCode).toBe(400);
  });
});

describe('hold and release', () => {
  it('blocks credit on hold with a reason; only approvers release it', async () => {
    const held = await api(manager).post(`/parties/${id('raj')}/credit/hold`, {
      reason: 'Cheque bounced',
    });

    expect(held.statusCode).toBe(200);
    expect(held.json<CreditView>()).toMatchObject({
      status: 'on_hold',
      hold: { reason: 'Cheque bounced', by: { memberId: id('managerMember') } },
      check: { decision: 'blocked', blockedBecause: 'on_hold' },
    });
    expect((await check('raj', 100)).blockedBecause).toBe('on_hold');
    expect(
      message(await api(manager).post(`/parties/${id('raj')}/credit/hold`, { reason: 'Again' })),
    ).toBe('This party has no credit to hold');
    expect((await api(manager).post(`/parties/${id('raj')}/credit/release`)).statusCode).toBe(403);
  });

  it('keeps a held account on hold when a new limit is approved', async () => {
    const raise = await api(manager).post('/credit-requests', {
      partyId: id('raj'),
      limitPaise: 60_000_00,
      creditDays: 30,
    });
    await api(owner).post(`/credit-requests/${raise.json<CreditRequestView>().id}/approve`);

    expect(await credit(owner, 'raj')).toMatchObject({ status: 'on_hold', limitPaise: 60_000_00 });
  });

  it('releases the hold', async () => {
    const released = await api(owner).post(`/parties/${id('raj')}/credit/release`);
    const again = await api(owner).post(`/parties/${id('raj')}/credit/release`);

    expect(released.json<CreditView>()).toMatchObject({ status: 'active', hold: null });
    expect([again.statusCode, message(again)]).toEqual([409, 'This party is not on hold']);
  });
});

describe('credit list', () => {
  it('lists parties with credit, closest to their limit first, within the member’s stores', async () => {
    await api(owner).post(`/credit-requests/${id('puneRequest')}/approve`);
    await api(owner).patch(`/parties/${id('wide')}/credit`, { manualExposurePaise: 9_000_00 });

    const page = (await api(owner).get('/credit-profiles')).json<{
      items: CreditListItem[];
      total: number;
    }>();
    const names = page.items.map((item) => item.party.name);
    const managerNames = (await api(manager).get('/credit-profiles'))
      .json<{ items: CreditListItem[] }>()
      .items.map((item) => item.party.name);

    expect(names.slice(0, 2)).toEqual(['Sri Painters', 'Raj Contractors']);
    expect(names).toContain('Pune Builders');
    expect(names).not.toContain('New Painter');
    expect(page.items[0]).toMatchObject({
      status: 'active',
      limitPaise: 10_000_00,
      manualExposurePaise: 9_000_00,
      check: { decision: 'manager_approval', utilizationPercent: 90 },
    });
    expect(managerNames).not.toContain('Pune Builders');
    const titles = async (query: string) =>
      (await api(owner).get(`/credit-profiles?${query}`))
        .json<{ items: CreditListItem[] }>()
        .items.map((item) => item.party.name);
    expect(await titles('status=none')).toEqual(['New Painter']);
    expect(await titles('risk=high')).toEqual(['Raj Contractors']);
    expect(await titles('q=sri')).toEqual(['Sri Painters']);
    expect(page.total).toBe(page.items.length);
  });
});

describe('customer 360', () => {
  it('shows the credit position to those who may see credit', async () => {
    const overview = (await api(owner).get(`/parties/${id('raj')}/overview`)).json<PartyOverview>();
    const hidden = (await api(cashier).get(`/parties/${id('raj')}/overview`)).json<PartyOverview>();

    expect(overview.credit).toMatchObject({
      status: 'active',
      limitPaise: 60_000_00,
      creditDays: 30,
      risk: 'high',
      manualExposurePaise: 18_000_00,
      check: { decision: 'allowed', utilizationPercent: 30 },
      pendingRequest: null,
    });
    expect(hidden.credit).toBeNull();
  });
});

describe('rules', () => {
  it('can be configured by approvers and change the decisions', async () => {
    const strict = { normalUpToPercent: 20, managerUpToPercent: 25, holdAfterOverdueDays: 7 };
    const byManager = await api(manager).put('/credit-rules', strict);
    const backwards = await api(owner).put('/credit-rules', {
      ...strict,
      normalUpToPercent: 30,
    });
    const saved = await api(owner).put('/credit-rules', strict);
    const changed = await api(owner).put('/credit-rules', { ...strict, holdAfterOverdueDays: 14 });

    expect(byManager.statusCode).toBe(403);
    expect(backwards.statusCode).toBe(400);
    expect(saved.json<CreditRules>()).toEqual(strict);
    expect(changed.json<CreditRules>().holdAfterOverdueDays).toBe(14);
    expect((await api(sales).get('/credit-rules')).json<CreditRules>()).toEqual({
      ...strict,
      holdAfterOverdueDays: 14,
    });
    // Raj owes ₹18,000 of ₹60,000: 30 %, above the manager's 25 %.
    expect((await check('raj')).decision).toBe('owner_approval');
  });
});

describe('audit', () => {
  it('records every change to limits, days, status and holds, and to the rules', async () => {
    const profile = (
      await api(owner).get(`/audit-log?table=credit_profiles&limit=200`)
    ).json<AuditPage>();
    const raj = profile.items.filter((entry) => entry.recordLabel === 'Raj Contractors');
    const rules = (await api(owner).get('/audit-log?table=credit_rules')).json<AuditPage>();

    expect(raj.map((entry) => entry.changes.map((c) => [c.label, c.oldText, c.newText]))).toEqual([
      [
        ['Status', 'on_hold', 'active'],
        ['Hold reason', 'Cheque bounced', null],
      ],
      [['Credit limit', '₹50,000.00', '₹60,000.00']],
      [
        ['Status', 'active', 'on_hold'],
        ['Hold reason', null, 'Cheque bounced'],
      ],
      [['Credit limit', '₹30,000.00', '₹50,000.00']],
      [
        ['Status', null, 'active'],
        ['Credit limit', null, '₹30,000.00'],
        ['Credit days', null, '30'],
        ['Hold reason', null, null],
      ],
    ]);
    expect(raj[0]).toMatchObject({ area: 'Credit', actor: { name: 'Anil Owner' } });
    expect(raj[2]?.actor?.name).toBe('Staff branch_manager');
    expect(rules.items.map((entry) => [entry.action, entry.recordLabel, entry.area])).toEqual([
      ['update', 'Credit rules', 'Credit rules'],
      ['insert', 'Credit rules', 'Credit rules'],
    ]);
    expect(rules.items[0]?.changes.map((c) => [c.label, c.oldText, c.newText])).toEqual([
      ['Hold after overdue (days)', '7', '14'],
    ]);
  });
});
