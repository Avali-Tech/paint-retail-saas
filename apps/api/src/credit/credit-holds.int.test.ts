import { migrateDatabase, schema, withTenant } from '@paint/db';
import type {
  CreditApprovalView,
  CreditCheck,
  CreditApprovalRefusal,
  PartyCreditSummary,
  SaleCreditView,
  SalesOrderView,
  SiteAccountDetail,
  SiteAccountView,
} from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Notifier } from '../notifications/notifier.js';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
  type Reply,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';
import { holdOverdue, holdOverdueBusinesses } from './credit-holds.js';

const { creditApprovals, creditHoldRuns, creditProfiles, notifications } = schema;

let database: TestDatabase;
let t: TestApp;
/** Goes live with opening balances, some overdue. */
let b: BillingBusiness;
/** Never goes live. */
let notLive: BillingBusiness;
let manager: string;
let sales: string;
let admin: string;
let today: string;
/** Overdue 10 days at go-live: within the rules. */
let regular: string;
/** Overdue 60 days, but released with a waiver until next week. */
let waived: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  notLive = await billingBusiness(t);
  today = await dbToday(t);
  manager = await b.member('branch_manager', [b.stores.amp]);
  sales = await b.member('sales_executive', [b.stores.amp]);
  admin = await b.member('org_admin', [b.stores.amp]);
  const party = async (displayName: string) =>
    ok(
      await api(t, b.owner).post('/parties', {
        displayName,
        phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        roles: ['contractor'],
      }),
    ).json<{ id: string }>().id;
  regular = await party('Regular Builders');
  waived = await party('Waived Interiors');
  const profile = (partyId: string, manualExposurePaise: number, overdueDays: number) => ({
    organizationId: b.organizationId,
    partyId,
    status: 'active' as const,
    limitPaise: 3_000_000,
    creditDays: 30,
    manualExposurePaise,
    overdueDays,
  });
  // MVP 1 figures: ₹10,000 owed, 45 days late; ₹5,000, 10 days; ₹8,000, 60 days.
  await t.connection.db.insert(creditProfiles).values([
    profile(b.parties.contractor, 1_000_000, 45),
    profile(regular, 500_000, 10),
    { ...profile(waived, 800_000, 60), overdueWaivedUntil: await dbToday(t, 7) },
    {
      organizationId: notLive.organizationId,
      partyId: notLive.parties.contractor,
      status: 'active',
      limitPaise: 3_000_000,
      creditDays: 30,
      manualExposurePaise: 2_000_000,
      overdueDays: 90,
      overdueWaivedUntil: await dbToday(t, 1),
    },
  ]);
}, 240_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const notifier = () => t.app.get(Notifier);
const credit = async (partyId = b.parties.contractor, token = b.owner) =>
  ok(await api(t, token).get(`/parties/${partyId}/credit`)).json<PartyCreditSummary>();
const check = async (partyId: string, amountPaise = 0) =>
  ok(
    await owner().get(`/parties/${partyId}/credit/check?amountPaise=${String(amountPaise)}`),
  ).json<CreditCheck>();

/** A query the database refused, by the message of its cause. */
const failure = (pattern: RegExp) => ({
  cause: expect.objectContaining({ message: expect.stringMatching(pattern) }) as unknown,
});

function refusal(reply: Reply): CreditApprovalRefusal {
  expect(reply.statusCode, reply.body).toBe(409);
  return reply.json<CreditApprovalRefusal>();
}

describe('before go-live', () => {
  it('uses the hand-entered figures, honours a waiver, and puts nobody on hold', async () => {
    // ₹20,000 owed and 90 days late, but waived until tomorrow: decided by utilisation.
    expect(
      ok(
        await api(t, notLive.owner).get(`/parties/${notLive.parties.contractor}/credit`),
      ).json<PartyCreditSummary>(),
    ).toMatchObject({
      exposureSource: 'manual',
      exposure: null,
      overdueDays: 90,
      overdueWaivedUntil: await dbToday(t, 1),
      check: { decision: 'allowed', utilizationPercent: 66.67 },
    });
    expect(await check(b.parties.contractor)).toMatchObject({
      decision: 'blocked',
      blockedBecause: 'overdue',
    });
    expect(await check(b.parties.homeowner, 100)).toMatchObject({ blockedBecause: 'no_credit' });
    expect(await holdOverdueBusinesses(t.connection.db, notifier())).toBe(0);
    expect(await t.connection.db.select().from(creditHoldRuns)).toEqual([]);
  });
});

describe('the nightly overdue hold (spec §4.4)', () => {
  beforeAll(async () => {
    ok(await owner().post('/sales/go-live', {}));
  });

  it('waits while another server holds the business’s lock', async () => {
    await withPgClient(database.connectionString, async (client) => {
      await client.query('begin');
      await client.query(
        `select pg_advisory_xact_lock(hashtext('paint:credit-hold'), hashtext($1))`,
        [b.organizationId],
      );
      const result = await withTenant(t.connection.db, b.organizationId, (tx) =>
        holdOverdue(tx, notifier(), b.organizationId),
      );
      // The nightly pass skips it too, and checks it again on its next pass.
      const held = await holdOverdueBusinesses(t.connection.db, notifier());
      await client.query('commit');
      expect([result, held]).toEqual([null, 0]);
    });
    expect((await credit()).status).toBe('active');
  });

  it('holds accounts overdue beyond the rules, once a day, and tells credit staff', async () => {
    expect(await credit()).toMatchObject({
      exposureSource: 'ledger',
      overdueDays: 45,
      status: 'active',
    });
    expect(await holdOverdueBusinesses(t.connection.db, notifier())).toBe(1);
    const held = await credit();
    expect(held).toMatchObject({
      status: 'on_hold',
      holdKind: 'auto',
      check: { decision: 'blocked', blockedBecause: 'on_hold' },
    });
    const [row] = await t.connection.db
      .select({ reason: creditProfiles.holdReason, by: creditProfiles.heldByMemberId })
      .from(creditProfiles)
      .where(eq(creditProfiles.partyId, b.parties.contractor));
    expect(row).toEqual({ reason: 'Overdue 45 days (automatic)', by: null });
    expect((await credit(regular)).status).toBe('active');
    expect((await credit(waived)).status).toBe('active');
    const told = await t.connection.db
      .select({ title: notifications.title, body: notifications.body })
      .from(notifications)
      .where(eq(notifications.event, 'credit_hold_applied'));
    // Sales executive and branch manager (credit:manage), admin (credit:manage and :approve, twice), owner (both).
    expect(told.length).toBeGreaterThanOrEqual(4);
    expect(told[0]).toEqual({
      title: 'Credit on hold: Deccan Contractors',
      body: 'Overdue 45 days (automatic). An approver can release it, with a waiver while it is paid.',
    });
    // The day's run is recorded: another pass, or another server, does nothing.
    expect(await holdOverdueBusinesses(t.connection.db, notifier())).toBe(0);
    expect(
      await withTenant(t.connection.db, b.organizationId, (tx) =>
        holdOverdue(tx, notifier(), b.organizationId),
      ),
    ).toBeNull();
    const runs = await t.connection.db
      .select({ runOn: creditHoldRuns.runOn, heldCount: creditHoldRuns.heldCount })
      .from(creditHoldRuns)
      .where(eq(creditHoldRuns.organizationId, b.organizationId));
    expect(runs).toEqual([{ runOn: today, heldCount: 1 }]);
  });

  it('releases only with approval, optionally waiving the overdue block', async () => {
    // A sales executive asks; a branch manager may not decide a release.
    const asked = ok(
      await api(t, sales).post('/credit-approvals', {
        kind: 'release',
        partyId: b.parties.contractor,
        reason: 'Paying ₹5,000 this week',
      }),
    ).json<CreditApprovalView>();
    expect(asked).toMatchObject({
      kind: 'release',
      level: null,
      subject: null,
      amountPaise: 0,
      status: 'pending',
    });
    expect((await credit()).pendingRelease).toMatchObject({ id: asked.id, number: asked.number });
    expect(
      (
        await api(t, sales).post('/credit-approvals', {
          kind: 'release',
          partyId: b.parties.contractor,
          reason: 'Again',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await api(t, manager).post(`/credit-approvals/${asked.id}/approve`, {})).statusCode,
    ).toBe(403);
    const tooLong = await api(t, admin).post(`/credit-approvals/${asked.id}/approve`, {
      waiveOverdueUntil: await dbToday(t, 91),
    });
    expect(tooLong.statusCode).toBe(400);
    const yesterday = await api(t, admin).post(`/credit-approvals/${asked.id}/approve`, {
      waiveOverdueUntil: await dbToday(t, -1),
    });
    expect(yesterday.statusCode).toBe(400);
    const approved = ok(
      await api(t, admin).post(`/credit-approvals/${asked.id}/approve`, {
        reason: 'Promised by Friday',
        waiveOverdueUntil: await dbToday(t, 10),
      }),
    ).json<CreditApprovalView>();
    expect(approved).toMatchObject({ status: 'approved', waiveOverdueUntil: await dbToday(t, 10) });
    expect(await credit()).toMatchObject({
      status: 'active',
      holdKind: null,
      overdueDays: 45,
      overdueWaivedUntil: await dbToday(t, 10),
      pendingRelease: null,
      check: { decision: 'allowed' },
    });
    // Utilisation still applies while waived.
    expect(await check(b.parties.contractor, 2_100_000)).toMatchObject({
      decision: 'owner_approval',
    });
    expect(
      (
        await api(t, sales).post('/credit-approvals', {
          kind: 'release',
          partyId: b.parties.contractor,
          reason: 'Not held',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('lets an approver hold and release directly, deciding a waiting release request', async () => {
    const held = ok(
      await api(t, manager).post(`/parties/${regular}/credit/hold`, {
        reason: 'Cheque bounced twice',
      }),
    ).json<PartyCreditSummary & { hold: { by: { name: string } } }>();
    expect(held).toMatchObject({
      status: 'on_hold',
      holdKind: 'manual',
      hold: { by: { name: 'Staff branch_manager' } },
    });
    const asked = ok(
      await api(t, sales).post('/credit-approvals', {
        kind: 'release',
        partyId: regular,
        reason: 'Paid in cash',
      }),
    ).json<CreditApprovalView>();
    // Kept from MVP 1: an approver releases on the party's credit screen.
    expect((await api(t, manager).post(`/parties/${regular}/credit/release`, {})).statusCode).toBe(
      403,
    );
    ok(await api(t, admin).post(`/parties/${regular}/credit/release`, { reason: 'Cash received' }));
    const decided = ok(
      await owner().get(`/credit-approvals/${asked.id}`),
    ).json<CreditApprovalView>();
    expect(decided).toMatchObject({
      status: 'approved',
      decisionReason: 'Cash received',
      waiveOverdueUntil: null,
    });
    expect((await credit(regular)).status).toBe('active');
    expect((await api(t, admin).post(`/parties/${regular}/credit/release`, {})).statusCode).toBe(
      409,
    );
    // Approved from the queue without a waiver: released, overdue days count again.
    ok(await api(t, manager).post(`/parties/${regular}/credit/hold`, { reason: 'Pending audit' }));
    const again = ok(
      await api(t, sales).post('/credit-approvals', {
        kind: 'release',
        partyId: regular,
        reason: 'Audit done',
      }),
    ).json<CreditApprovalView>();
    expect(
      ok(
        await api(t, admin).post(`/credit-approvals/${again.id}/approve`, {}),
      ).json<CreditApprovalView>(),
    ).toMatchObject({ status: 'approved', waiveOverdueUntil: null });
    expect(await credit(regular)).toMatchObject({ status: 'active', overdueWaivedUntil: null });
  });
});

describe('rules the database keeps', () => {
  it('freezes the hand-entered figures once billing is live', async () => {
    await expect(
      t.connection.db
        .update(creditProfiles)
        .set({ manualExposurePaise: 1 })
        .where(eq(creditProfiles.partyId, b.parties.contractor)),
    ).rejects.toMatchObject(failure(/billing is live/));
    // Other columns still change, and a business not yet live may edit its figures.
    await t.connection.db
      .update(creditProfiles)
      .set({ notes: 'Pays late' })
      .where(eq(creditProfiles.partyId, b.parties.contractor));
    await t.connection.db
      .update(creditProfiles)
      .set({ manualExposurePaise: 2_100_000 })
      .where(eq(creditProfiles.partyId, notLive.parties.contractor));
  });

  it('keeps the overdue runs, and lets an approval only move forward', async () => {
    await expect(
      t.connection.db.update(creditHoldRuns).set({ heldCount: 5 }),
    ).rejects.toMatchObject(failure(/append-only/));
    await expect(t.connection.db.delete(creditHoldRuns)).rejects.toMatchObject(
      failure(/append-only/),
    );
    const [approval] = await t.connection.db
      .select({ id: creditApprovals.id })
      .from(creditApprovals)
      .where(eq(creditApprovals.status, 'approved'))
      .limit(1);
    const byId = eq(creditApprovals.id, String(approval?.id));
    await expect(
      t.connection.db.update(creditApprovals).set({ reason: 'Changed' }).where(byId),
    ).rejects.toMatchObject(failure(/keeps what was asked/));
    await expect(
      t.connection.db.update(creditApprovals).set({ status: 'pending' }).where(byId),
    ).rejects.toMatchObject(failure(/cannot become pending/));
    await expect(
      t.connection.db
        .update(creditApprovals)
        .set({ status: 'used', usedAt: sql`now()`, decisionReason: 'Edited' })
        .where(byId),
    ).rejects.toMatchObject(failure(/cannot become used/));
  });
});

describe('site accounts under a contractor (spec §3.3)', () => {
  let s: BillingBusiness;
  let siteManager: string;
  let project: string;
  let site: SiteAccountView;

  beforeAll(async () => {
    s = await billingBusiness(t);
    siteManager = await s.member('branch_manager', [s.stores.amp]);
    ok(await api(t, s.owner).post('/sales/go-live', {}));
    await t.connection.db.insert(creditProfiles).values({
      organizationId: s.organizationId,
      partyId: s.parties.contractor,
      status: 'active',
      limitPaise: 3_000_000,
      creditDays: 30,
    });
    project = ok(
      await api(t, s.owner).post('/projects', {
        storeId: s.stores.amp,
        customerPartyId: s.parties.contractor,
        name: 'Jubilee Hills villa',
      }),
    ).json<{ id: string }>().id;
  });

  const so = () => api(t, s.owner);
  const siteOrder = async (paise: number) =>
    ok(
      await so().post('/sales-orders', {
        storeId: s.stores.amp,
        billToPartyId: s.parties.contractor,
        projectId: project,
        paymentTerms: 'postpaid',
        lines: [{ variantId: s.apex, quantity: 1, unitPricePaise: paise }],
      }),
    ).json<SalesOrderView>();

  it('opens a site account within the contractor’s limit, for a project it is on', async () => {
    const other = ok(
      await so().post('/projects', {
        storeId: s.stores.amp,
        customerPartyId: s.parties.homeowner,
        name: 'Suresh home',
      }),
    ).json<{ id: string }>().id;
    const add = (body: object, partyId = s.parties.contractor, token = s.owner) =>
      api(t, token).post(`/parties/${partyId}/sites`, body);
    expect((await add({ projectId: other, limitPaise: 1_000_000 })).statusCode).toBe(400);
    expect((await add({ projectId: crypto.randomUUID(), limitPaise: 1_000_000 })).statusCode).toBe(
      400,
    );
    expect((await add({ projectId: project, limitPaise: 3_000_001 })).statusCode).toBe(400);
    expect(
      (await add({ projectId: other, limitPaise: 1_000 }, s.parties.homeowner)).statusCode,
    ).toBe(400);
    expect(
      (await add({ projectId: project, limitPaise: 1_000_000 }, s.parties.contractor, siteManager))
        .statusCode,
    ).toBe(403);
    site = ok(
      await add({ projectId: project, limitPaise: 1_000_000, notes: 'Villa repaint' }),
    ).json<SiteAccountView>();
    expect(site).toMatchObject({
      party: { id: s.parties.contractor, name: 'Deccan Contractors' },
      project: { id: project, name: 'Jubilee Hills villa', number: expect.stringMatching(/^PJ-/) },
      limitPaise: 1_000_000,
      status: 'active',
      hold: null,
      notes: 'Villa repaint',
      exposurePaise: 0,
      availablePaise: 1_000_000,
      utilizationPercent: 0,
    });
    expect((await add({ projectId: project, limitPaise: 500_000 })).statusCode).toBe(409);
    expect(
      ok(await so().get(`/parties/${s.parties.contractor}/sites`)).json<SiteAccountView[]>(),
    ).toEqual([site]);
    expect((await credit(s.parties.contractor, s.owner)).sites).toEqual([site]);
  });

  it('checks a sale on the site against the site’s limit too: the stricter wins', async () => {
    // ₹12,000 is 40 % of the contractor's limit but 120 % of the site's.
    const big = await siteOrder(1_200_000);
    const preview = ok(
      await so().get(`/sales-orders/${big.id}/credit-check`),
    ).json<SaleCreditView>();
    expect(preview).toMatchObject({
      check: { decision: 'allowed', utilizationPercent: 40 },
      site: {
        siteAccountId: site.id,
        projectName: 'Jubilee Hills villa',
        limitPaise: 1_000_000,
        exposurePaise: 0,
        check: { decision: 'owner_approval', utilizationPercent: 120 },
      },
      approval: 'owner',
    });
    expect(
      refusal(await api(t, siteManager).post(`/sales-orders/${big.id}/confirm`, {})).message,
    ).toBe(
      'This order takes the site Jubilee Hills villa to 120% of its limit: the owner must approve',
    );
    // A project the contractor has no site account on: only its own limit applies.
    const elsewhere = ok(
      await so().post('/sales-orders', {
        storeId: s.stores.amp,
        billToPartyId: s.parties.contractor,
        projectId: (await so().get(`/projects?partyId=${s.parties.homeowner}`)).json<{
          items: { id: string }[];
        }>().items[0]?.id,
        paymentTerms: 'postpaid',
        lines: [{ variantId: s.apex, quantity: 1, unitPricePaise: 100_000 }],
      }),
    ).json<SalesOrderView>();
    expect(
      ok(await so().get(`/sales-orders/${elsewhere.id}/credit-check`)).json<SaleCreditView>(),
    ).toMatchObject({
      site: null,
      approval: 'none',
    });
    const asked = ok(
      await api(t, siteManager).post('/credit-approvals', {
        salesOrderId: big.id,
        reason: 'Villa phase 1',
      }),
    ).json<CreditApprovalView>();
    expect(asked).toMatchObject({
      site: { projectId: project, name: 'Jubilee Hills villa' },
      level: 'owner',
    });
    ok(
      await so().post(`/credit-approvals/${asked.id}/reject`, { reason: 'Too much for one site' }),
    );
    const small = await siteOrder(500_000);
    ok(await so().post(`/sales-orders/${small.id}/confirm`, {}));
    // A bill on the site and a payment against it.
    const bill = await s.draft({
      partyId: s.parties.contractor,
      projectId: project,
      lines: [{ variantId: s.apex, quantity: 1, unitPricePaise: 300_000 }],
    });
    ok(await so().post(`/invoices/${bill.id}/issue`, {}));
    ok(
      await so().post('/payments', {
        storeId: s.stores.amp,
        partyId: s.parties.contractor,
        modeId: s.modes.bank.id,
        amountPaise: 100_000,
        reference: 'NEFT-SITE',
        allocations: [{ documentId: bill.id, amountPaise: 100_000 }],
      }),
    );
    const detail = ok(await so().get(`/site-accounts/${site.id}`)).json<SiteAccountDetail>();
    expect(detail).toMatchObject({
      outstandingPaise: 200_000,
      openOrdersPaise: 500_000,
      exposurePaise: 700_000,
      availablePaise: 300_000,
      utilizationPercent: 70,
      ageing: { not_due: 0, days_0_30: 200_000, days_31_60: 0, days_61_90: 0, days_90_plus: 0 },
    });
    expect(detail.ledger).toEqual([
      expect.objectContaining({
        kind: 'invoice',
        documentId: bill.id,
        amountPaise: 300_000,
        runningPaise: 300_000,
      }),
      expect.objectContaining({
        kind: 'payment',
        documentId: bill.id,
        number: expect.stringMatching(/^RC-/),
        amountPaise: -100_000,
        runningPaise: 200_000,
      }),
    ]);
    expect(detail.ledger[1]?.againstNumber).toBe(detail.ledger[0]?.number);
    expect(detail.openDocuments).toEqual([
      expect.objectContaining({
        documentId: bill.id,
        outstandingPaise: 200_000,
        daysPastDue: 0,
        bucket: 'days_0_30',
      }),
    ]);
  });

  it('holds, releases, changes and closes a site account', async () => {
    const at = (path: string, body: object = {}, token = s.owner) =>
      api(t, token).post(`/site-accounts/${site.id}/${path}`, body);
    expect((await at('hold', { reason: 'x' }, siteManager)).statusCode).toBe(400);
    const held = ok(
      await at('hold', { reason: 'Site disputed' }, siteManager),
    ).json<SiteAccountView>();
    expect(held).toMatchObject({
      status: 'on_hold',
      hold: { reason: 'Site disputed', by: { name: 'Staff branch_manager' } },
    });
    expect((await at('hold', { reason: 'Again' })).statusCode).toBe(409);
    const blocked = await siteOrder(10_000);
    expect(refusal(await so().post(`/sales-orders/${blocked.id}/confirm`, {})).message).toBe(
      'Credit is blocked on the site Jubilee Hills villa (on hold)',
    );
    expect((await at('release', {}, siteManager)).statusCode).toBe(403);
    expect(ok(await at('release')).json<SiteAccountView>()).toMatchObject({
      status: 'active',
      hold: null,
    });
    expect((await at('release')).statusCode).toBe(409);
    const patch = (body: object) => api(t, s.owner).patch(`/site-accounts/${site.id}`, body);
    expect((await patch({ limitPaise: 9_000_000 })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect(
      ok(await patch({ limitPaise: 2_000_000, notes: null })).json<SiteAccountView>(),
    ).toMatchObject({
      limitPaise: 2_000_000,
      notes: null,
    });
    expect(ok(await patch({ notes: 'Phase 2 from March' })).json<SiteAccountView>()).toMatchObject({
      limitPaise: 2_000_000,
      notes: 'Phase 2 from March',
    });
    expect(ok(await at('close')).json<SiteAccountView>().status).toBe('closed');
    expect(refusal(await so().post(`/sales-orders/${blocked.id}/confirm`, {})).message).toBe(
      'Credit is blocked on the site Jubilee Hills villa (no credit)',
    );
    expect((await at('close')).statusCode).toBe(409);
    expect((await at('hold', { reason: 'Closed already' })).statusCode).toBe(409);
    expect((await patch({ notes: 'Reopen?' })).statusCode).toBe(409);
    expect((await so().get(`/site-accounts/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });

  it('keeps sites to the members who can see the party', async () => {
    const pune = ok(await api(t, s.owner).post('/stores', { name: 'Pune', code: 'PUN' })).json<{
      id: string;
    }>().id;
    const away = ok(
      await so().post('/parties', {
        displayName: 'Pune Builders',
        phone: '+919811100099',
        roles: ['contractor'],
        homeStoreId: pune,
      }),
    ).json<{ id: string }>().id;
    expect((await api(t, siteManager).get(`/parties/${away}/sites`)).statusCode).toBe(404);
    expect(
      (await api(t, siteManager).post(`/parties/${away}/credit/hold`, { reason: 'Not mine' }))
        .statusCode,
    ).toBe(404);
  });
});
