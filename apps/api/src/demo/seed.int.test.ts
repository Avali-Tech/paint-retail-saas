import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  findReservationMismatches,
  findStockMismatches,
  schema,
} from '@paint/db';
import {
  AGEING_BUCKETS,
  ageingBucket,
  isValidGstin,
  type AgeingBucket,
  type BrandStatementDetail,
  type BrandStatementSummaryView,
  type AgeingPage,
  type CreditApprovalPage,
  type EarnRuleView,
  type EscalationView,
  type PartyCreditSummary,
  type PartyLedgerView,
  type ReceivablesSummaryView,
  type ReminderScheduleView,
  type SchemeClaimsReport,
  type SchemeSummary,
  type SchemesOverview,
  type SiteAccountDetail,
  type SiteAccountView,
  type SubscriptionInvoiceView,
  type SubscriptionView,
  type GoLivePreview,
  type GstRegistrations,
  type LatestReconciliation,
  type WorklistPage,
} from '@paint/shared';
import { withPgClient } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { appCode } from '../test-support/two-factor.js';
import { bearer, startTestApp, TEST_AUTH_SECRET, type TestApp } from '../test-support/test-app.js';
import { DemoApi, DemoApiError } from './api-client.js';
import { HistoryClock, indiaDate } from './history-clock.js';
import {
  buildPlan,
  DEMO_OPERATOR,
  DEMO_OPERATOR_TOTP_SECRET,
  DEMO_PASSWORD,
  DEMO_TOTP_SECRET,
} from './plan.js';
import { REMINDER_SCHEDULES } from './seed-collections.js';
import { STATEMENT_DEMO } from './seed-statements.js';
import { SITES } from './seed-sites.js';
import { runSeedCommand } from './seed-command.js';

const serverUrl = inject('databaseUrl');
const demoUrl = (() => {
  const url = new URL(serverUrl);
  url.pathname = `/demo_${randomUUID().replaceAll('-', '')}`;
  return url.toString();
})();
const credentialsFile = join(mkdtempSync(join(tmpdir(), 'paint-demo-')), 'credentials.txt');
const env = {
  DATABASE_URL: demoUrl,
  AUTH_SECRET: TEST_AUTH_SECRET,
  DEMO_SIZE: 'full',
  DEMO_CREDENTIALS_FILE: credentialsFile,
  DEMO_WEB_URL: 'http://localhost:4981',
};
const seed = async (command: string, settings: Record<string, string> = env) => {
  const lines: string[] = [];
  const code = await runSeedCommand(command, settings, (line) => lines.push(line));
  return { code, output: lines.join('\n') };
};

let t: TestApp;
let owner: string;
let firstRun: { code: number; output: string };

const get = async <T>(url: string, token = owner) => {
  const response = await t.app.inject({ method: 'GET', url, headers: bearer(token) });
  expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
  return response.json<T>();
};
const rows = async <T>(query: ReturnType<typeof sql>) =>
  (await t.connection.db.execute<T & Record<string, unknown>>(query)).rows as T[];
/** A demo party's id, by its key in the full plan (e.g. contractor-2). */
const partyId = async (key: string) => {
  const plan = buildPlan('full').parties.find((party) => party.key === key);
  const [row] = await rows<{ id: string }>(
    sql`select id from ${schema.parties} where phone = ${String(plan?.phone)}`,
  );
  return String(row?.id);
};
const signIn = async (identifier: string) =>
  t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier, password: DEMO_PASSWORD },
  });

beforeAll(async () => {
  firstRun = await seed('seed');
  t = await startTestApp(demoUrl);
  owner = (await signIn('+919000000001')).json<{ token: string }>().token;
  // A minute and a half alone; longer beside the rest of the suite under coverage.
}, 600_000);

afterAll(async () => {
  await t.close();
  await withPgClient(serverUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS "${new URL(demoUrl).pathname.slice(1)}" WITH (FORCE)`),
  );
});

describe('demo seed command', () => {
  it('creates the database, seeds it and writes the sign-in sheet', async () => {
    expect(firstRun.code).toBe(0);
    expect(firstRun.output).toContain('Seeding Sri Rama Hardware & Paints (full)');
    expect(firstRun.output).toMatch(/Seeded in \d+ s: 3 stores, 13 team members/);
    const sheet = readFileSync(credentialsFile, 'utf8');
    expect(sheet).toContain('Open http://localhost:4981');
    expect(firstRun.output).toContain(sheet);
    expect(await seed('status')).toEqual({ code: 0, output: `seeded ${indiaDate(0)}` });
    const again = await seed('seed');
    expect(again.code).toBe(0);
    expect(again.output).toContain('already there');
  });

  it('reports an empty database', async () => {
    const url = new URL(serverUrl);
    url.pathname = `/demo_${randomUUID().replaceAll('-', '')}`;
    expect(await seed('status', { ...env, DATABASE_URL: url.toString() })).toEqual({
      code: 0,
      output: 'empty',
    });
    await withPgClient(serverUrl, (client) =>
      client.query(`DROP DATABASE "${url.pathname.slice(1)}"`),
    );
  });
});

describe('the demo business', () => {
  it('signs in the owner with a password alone (the two-factor rule is off)', async () => {
    expect(owner).toEqual(expect.any(String));
    const security = await get<{ twoFactorRequired: boolean }>('/organization/security');
    expect(security.twoFactorRequired).toBe(false);
    const branding = await get<{ branding: { appName: string } }>('/organization/branding');
    expect(branding.branding.appName).toBe('Sri Rama Paints');
    // Its branded sign-in page, printed on the sheet, shows the same look before sign-in.
    const identity = await get<{ slug: string }>('/organization/identity');
    expect(identity.slug).toBe('sri-rama-paints');
    expect(readFileSync(credentialsFile, 'utf8')).toContain(
      'http://localhost:4981/sign-in?b=sri-rama-paints',
    );
    const page = await t.app.inject({ method: 'GET', url: '/public/branding/sri-rama-paints' });
    expect(page.json<{ branding: { appName: string } }>().branding.appName).toBe('Sri Rama Paints');
  });

  it('pays our GST invoice for the Standard plan by bank transfer; a second business is on its trial', async () => {
    const subscription = await get<SubscriptionView>('/subscription');
    expect(subscription).toMatchObject({
      plan: 'standard',
      status: 'active',
      interval: 'monthly',
      quantity: 3,
      gateway: 'manual',
      collection: 'manual',
      readOnly: false,
    });
    const invoices = await get<SubscriptionInvoiceView[]>('/subscription/invoices');
    expect(invoices).toMatchObject([
      {
        plan: 'standard',
        quantity: 3,
        totalPaise: 5_306_46,
        payment: { mode: 'bank_transfer', amountPaise: 5_306_46 },
      },
    ]);
    const sheet = readFileSync(credentialsFile, 'utf8');
    expect(sheet).toContain('pays for the Standard, monthly plan');
    expect(sheet).toContain('Reddy Colour Centre');
    const [trial] = (
      await withPgClient(demoUrl, (client) =>
        client.query<{ status: string; plan: string }>(
          `SELECT s.status, o.plan FROM subscriptions s JOIN organizations o ON o.id = s.organization_id
            WHERE o.name = 'Reddy Colour Centre'`,
        ),
      )
    ).rows;
    expect(trial).toEqual({ status: 'trialing', plan: 'trial' });
  });

  it('asks the demo admin for an authenticator code from the fixed secret', async () => {
    const first = (await signIn('+919000000003')).json<{
      twoFactor: { pendingToken: string; setupRequired: boolean };
    }>();
    expect(first.twoFactor.setupRequired).toBe(false);
    // The seed used the current code to confirm; the next step's code is accepted too.
    const verified = await t.app.inject({
      method: 'POST',
      url: '/auth/2fa/verify',
      payload: {
        pendingToken: first.twoFactor.pendingToken,
        code: appCode(DEMO_TOTP_SECRET, Date.now() + 30_000),
      },
    });
    expect(verified.statusCode, verified.body).toBe(200);
  });

  it('has a platform operator whose authenticator uses the fixed secret', async () => {
    expect(readFileSync(credentialsFile, 'utf8')).toContain(`http://localhost:4981/platform`);
    const first = await t.app.inject({
      method: 'POST',
      url: '/platform/login',
      payload: { identifier: DEMO_OPERATOR.email, password: DEMO_PASSWORD },
    });
    expect(first.statusCode, first.body).toBe(200);
    const { twoFactor } = first.json<{
      twoFactor: { pendingToken: string; setupRequired: boolean };
    }>();
    expect(twoFactor.setupRequired).toBe(false);
    const verified = await t.app.inject({
      method: 'POST',
      url: '/platform/login/2fa',
      payload: {
        pendingToken: twoFactor.pendingToken,
        code: appCode(DEMO_OPERATOR_TOTP_SECRET, Date.now() + 30_000),
      },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    // The running demo API has no bootstrap token: no second operator can be made.
    const again = await t.app.inject({
      method: 'POST',
      url: '/platform/bootstrap',
      payload: {
        token: 'x'.repeat(40),
        fullName: 'Someone Else',
        email: 'x@y.in',
        password: 'Pass@2026word',
      },
    });
    expect(again.statusCode).toBe(404);
  });

  it('signs counter staff in with a mobile code', async () => {
    const phone = '+919000000041';
    await t.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const verified = await t.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: t.sms.lastCodeFor(phone) },
    });
    expect(verified.statusCode, verified.body).toBe(200);
  });

  it('keeps stock consistent, never negative, with low stock showing', async () => {
    const [negative] = await t.connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.stockBalances)
      .where(sql`${schema.stockBalances.onHand} < 0`);
    expect(negative?.count).toBe(0);
    expect(await findStockMismatches(t.connection.db)).toEqual([]);
    const low = await get<{ total: number }>('/stock/low?limit=1');
    expect(low.total).toBeGreaterThan(0);
    const dashboard = await get<{
      totals: {
        stock: { valuePaise: number };
        transfers: { awaitingApproval: number; toDispatch: number; incoming: number };
        purchaseOrders: { open: number };
      };
    }>('/dashboard');
    expect(dashboard.totals.stock.valuePaise).toBeGreaterThan(0);
    expect(dashboard.totals.transfers).toEqual({ awaitingApproval: 1, toDispatch: 1, incoming: 1 });
    expect(dashboard.totals.purchaseOrders.open).toBeGreaterThan(0);
  });

  it('spreads the history over the past weeks', async () => {
    const [ledger] = await t.connection.db
      .select({
        oldest: sql<string>`min(${schema.stockLedger.createdAt})::text`,
        newest: sql<string>`max(${schema.stockLedger.createdAt})::text`,
      })
      .from(schema.stockLedger);
    expect(Date.parse(String(ledger?.oldest))).toBeLessThan(Date.now() - 15 * 86_400_000);
    expect(Date.parse(String(ledger?.newest))).toBeLessThan(Date.now());
    const receipts = await get<{ items: { receivedAt: string }[] }>('/goods-receipts');
    expect(
      new Set(receipts.items.map((receipt) => receipt.receivedAt.slice(0, 10))).size,
    ).toBeGreaterThan(2);
  });

  it('has credit accounts: two on hold, one near its limit, two requests waiting', async () => {
    const profiles = await get<{
      items: { status: string; check: { utilizationPercent: number | null } }[];
    }>('/credit-profiles?limit=200');
    // The builder held by hand, and the one the nightly job held for overdue bills.
    expect(profiles.items.filter((p) => p.status === 'on_hold')).toHaveLength(2);
    expect(profiles.items.some((p) => (p.check.utilizationPercent ?? 0) >= 90)).toBe(true);
    const pending = await get<{ total: number }>('/credit-requests?status=pending');
    expect(pending.total).toBe(2);
  });

  it('has bills approved past the credit rules, and one waiting in the approval queue', async () => {
    const waiting = await get<{ items: { kind: string; subject: { type: string } | null }[] }>(
      '/credit-approvals?status=pending',
    );
    expect(waiting.items).toEqual([
      expect.objectContaining({
        kind: 'sale',
        subject: expect.objectContaining({ type: 'tax_document' }),
      }),
    ]);
    const used = await get<{ total: number }>('/credit-approvals?status=used');
    expect(used.total).toBeGreaterThan(0);
  });

  it('has painters earning loyalty points, some in a higher tier', async () => {
    const accounts = await get<{ items: { balance: number; tier: { name: string } | null }[] }>(
      '/loyalty-accounts?limit=200',
    );
    expect(accounts.items.length).toBeGreaterThanOrEqual(5);
    expect(accounts.items.every((account) => account.balance >= 0)).toBe(true);
    expect(accounts.items.some((account) => account.tier && account.tier.name !== 'Silver')).toBe(
      true,
    );
  });

  it('has follow-ups overdue and due today, and leads in several stages', async () => {
    const mine = await get<{ counts: { overdue: number; today: number } }>(
      '/activities/follow-ups?when=open',
    );
    expect(mine.counts.overdue).toBeGreaterThan(0);
    expect(mine.counts.today).toBeGreaterThan(0);
    const pipeline = await get<{ stage: string; count: number }[]>('/leads/pipeline');
    expect(pipeline.filter((stage) => stage.count > 0).length).toBeGreaterThanOrEqual(4);
    const renewals = await get<{ total: number }>('/contracts?renewalDue=30');
    expect(renewals.total).toBeGreaterThan(0);
    const notifications = await get<{ unread: number }>('/notifications');
    expect(notifications.unread).toBeGreaterThan(0);
  });

  it('is registered for GST in Telangana, with HSN codes, tax categories and customers by state', async () => {
    const registrations = await get<GstRegistrations>('/gst-registrations');
    expect(registrations.legalName).toBe('Sri Rama Hardware & Paints');
    expect(registrations.pan).toMatch(/^[A-Z]{3}F[A-Z]\d{4}[A-Z]$/);
    expect(
      registrations.stores.map((store) => [store.code, store.registrationType, store.stateCode]),
    ).toEqual([
      ['AMP', 'regular', '36'],
      ['KPL', 'regular', '36'],
      ['SEC', 'regular', '36'],
    ]);
    expect(registrations.stores.every((store) => isValidGstin(String(store.gstin)))).toBe(true);

    const products = await get<{
      items: { hsnCode: string; type: string; taxCategory: { name: string } | null }[];
    }>('/products?limit=200');
    const taxOf = (type: string) =>
      new Set(
        products.items
          .filter((product) => product.type === type)
          .map((product) => `${product.hsnCode} ${String(product.taxCategory?.name)}`),
      );
    expect(taxOf('interior_paint')).toEqual(new Set(['3209 Paints 18%']));
    expect(taxOf('enamel')).toEqual(new Set(['3208 Paints 18%']));
    expect(taxOf('putty')).toEqual(new Set(['3214 Putty & fillers 18%']));
    expect(taxOf('wood_finish')).toEqual(new Set(['3208 Varnishes & wood finishes 18%']));
    expect(taxOf('tool')).toEqual(new Set(['9603 Brushes & rollers 18%']));

    const customers = await get<{
      items: { displayName: string; city: string; placeOfSupply: string; gstin: string | null }[];
    }>('/parties?limit=200');
    const andhra = customers.items.filter((party) => party.placeOfSupply === '37');
    expect(andhra.map((party) => party.city).sort()).toEqual(['Guntur', 'Vijayawada']);
    expect(andhra.find((party) => party.city === 'Vijayawada')?.gstin?.slice(0, 2)).toBe('37');
    // The counter's walk-in party has none: each bill names the buyer's state.
    expect(
      customers.items
        .filter((party) => party.placeOfSupply !== '37' && party.displayName !== 'Walk-in customer')
        .every((p) => p.placeOfSupply === '36'),
    ).toBe(true);
  });

  it('bills for two months since going live, with every book reconciled', async () => {
    const goLive = await get<GoLivePreview>('/sales/go-live');
    expect(goLive).toMatchObject({ live: true, billingLiveOn: indiaDate(60) });
    const [invoices] = await t.connection.db
      .select({
        count: sql<number>`count(*)::int`,
        oldest: sql<string>`min(${schema.taxDocuments.issuedOn})::text`,
        newest: sql<string>`max(${schema.taxDocuments.issuedOn})::text`,
        days: sql<number>`count(distinct ${schema.taxDocuments.issuedOn})::int`,
        interState: sql<number>`count(*) filter (where ${schema.taxDocuments.igstPaise} > 0)::int`,
        onAccount: sql<number>`count(*) filter (where ${schema.taxDocuments.dueOn} > ${schema.taxDocuments.issuedOn})::int`,
      })
      .from(schema.taxDocuments)
      .where(
        sql`${schema.taxDocuments.kind} = 'invoice' and ${schema.taxDocuments.status} = 'issued'`,
      );
    expect(invoices?.count).toBeGreaterThan(150);
    expect(invoices?.oldest).toBe(indiaDate(59));
    expect(invoices?.newest).toBe(indiaDate(1));
    expect(invoices?.days).toBe(59);
    expect(invoices?.interState).toBeGreaterThan(0);
    expect(invoices?.onAccount).toBeGreaterThan(10);

    const notes = await get<{ items: { kind: string }[] }>('/notes?limit=200');
    // Two returns and a discount on credit bills, and a homeowner's return (painter points).
    expect(notes.items.filter((note) => note.kind === 'credit_note')).toHaveLength(4);
    expect(notes.items.filter((note) => note.kind === 'debit_note')).toHaveLength(1);
    expect((await get<{ total: number }>('/payments?chequeStatus=bounced')).total).toBe(1);
    expect(
      (await get<{ total: number }>('/payments?modeKind=bank_transfer')).total,
    ).toBeGreaterThan(10);
    expect((await get<{ total: number }>('/register-sessions?status=closed')).total).toBe(59 * 3);
    expect((await get<{ total: number }>('/quotations')).total).toBe(2);
    const [held] = await t.connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.stockReservations)
      .where(sql`${schema.stockReservations.status} = 'open'`);
    expect(held?.count).toBeGreaterThan(1);
    // Opening balances came from the import; the first builder's is long overdue.
    const [opening] = await t.connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.partyLedger)
      .where(
        sql`${schema.partyLedger.entryType} = 'opening' and ${schema.partyLedger.entryOn} = ${indiaDate(60)}`,
      );
    expect(opening?.count).toBe(23);

    const { run } = await get<LatestReconciliation>('/reconciliation/latest');
    expect(run).toMatchObject({ trigger: 'scheduled', findingCount: 0, runOn: indiaDate(0) });
    expect(await findReservationMismatches(t.connection.db)).toEqual([]);
    expect(await findPartyBalanceMismatches(t.connection.db)).toEqual([]);
    expect(await findAllocationMismatches(t.connection.db)).toEqual([]);
  });

  it('pays for its plan with a paid invoice and the renewal to come (manual invoicing)', async () => {
    const subscription = await get<SubscriptionView>('/subscription');
    const [invoice] = await get<SubscriptionInvoiceView[]>('/subscription/invoices');
    expect(invoice).toMatchObject({ issuedOn: indiaDate(0), payment: { paidOn: indiaDate(0) } });
    // Paid to the end of its month; our renewal invoice is raised 7 days before then.
    expect(Date.parse(String(subscription.currentPeriodEnd))).toBeGreaterThan(
      Date.now() + 25 * 86_400_000,
    );
    expect(subscription).toMatchObject({ pastDueSince: null, cancelAtPeriodEnd: false });
  });

  it('has near-duplicate parties to merge', async () => {
    const parties = await get<{ items: { displayName: string }[] }>('/parties?limit=200');
    const names = parties.items.map((party) => party.displayName);
    expect(names.some((name) => name.endsWith('(Painter)'))).toBe(true);
  });

  it('reports API refusals with what the API said', async () => {
    const api = new DemoApi(t.app);
    const failure = api.public.get('/auth/me');
    await expect(failure).rejects.toBeInstanceOf(DemoApiError);
    await expect(failure).rejects.toThrow('GET /auth/me answered 401');
  });

  it('has nothing to move when no day was recorded', async () => {
    const clock = new HistoryClock(demoUrl);
    expect(await clock.apply()).toBe(0);
    await clock.close();
  });
});

describe('Release 2.1 for a pilot walkthrough', () => {
  it('asks for credit approvals, which are approved, used, rejected or still waiting', async () => {
    const page = (query: string) => get<CreditApprovalPage>(`/credit-approvals?${query}`);
    expect((await page('status=pending')).total).toBe(1);
    expect((await page('status=used')).total).toBeGreaterThan(0);
    const rejected = await page('status=rejected');
    expect(rejected.items).toEqual([
      expect.objectContaining({
        kind: 'sale',
        decisionReason: 'Over the limit already; collect the September bills first',
      }),
    ]);
    const released = await page('status=approved&kind=release');
    expect(released.items).toEqual([
      expect.objectContaining({ kind: 'release', waiveOverdueUntil: indiaDate(-14) }),
    ]);
  });

  it('holds an overdue account automatically, and released another with a waiver', async () => {
    const held = await get<PartyCreditSummary>(`/parties/${await partyId('builder-2')}/credit`);
    expect(held).toMatchObject({ status: 'on_hold', holdKind: 'auto' });
    expect(held.overdueDays).toBeGreaterThan(30);
    const manual = await get<PartyCreditSummary>(`/parties/${await partyId('builder-1')}/credit`);
    expect(manual).toMatchObject({ status: 'on_hold', holdKind: 'manual' });
    const dealer = await get<PartyCreditSummary>(`/parties/${await partyId('dealer-2')}/credit`);
    expect(dealer).toMatchObject({
      status: 'active',
      holdKind: null,
      overdueWaivedUntil: indiaDate(-14),
    });
    expect(dealer.overdueDays).toBeGreaterThan(30);
    expect(dealer.check.decision).not.toBe('blocked');
    const [run] = await rows<{ held: number }>(
      sql`select held_count as held from ${schema.creditHoldRuns} where run_on = ${indiaDate(0)}`,
    );
    expect(run?.held).toBe(2);
  });

  it('ages receivables in every bucket, each customer exactly as its ledger', async () => {
    const page = await get<AgeingPage>('/receivables/ageing?limit=500');
    for (const bucket of AGEING_BUCKETS) {
      expect({ bucket, filled: page.totals.buckets[bucket] > 0 }).toEqual({ bucket, filled: true });
    }
    const balances = await rows<{ party_id: string; balance: string; advance: string }>(
      sql`select party_id, balance_paise as balance, advance_paise as advance from ${schema.partyBalances}`,
    );
    for (const balance of balances) {
      const row = page.rows.find((entry) => entry.id === balance.party_id);
      expect({ party: balance.party_id, net: row?.totals.netPaise ?? 0 }).toEqual({
        party: balance.party_id,
        net: Number(balance.balance),
      });
      expect(row?.totals.unappliedPaise ?? 0).toBe(Number(balance.advance));
    }
    const summary = await get<ReceivablesSummaryView>('/receivables/summary');
    expect(summary.totals).toEqual(page.totals);
    expect(summary.topCustomers.length).toBeGreaterThan(0);
  });

  it('keeps site accounts under a contractor, agreeing with the receivables ageing (spec §2.3)', async () => {
    const contractor = await partyId('contractor-2');
    const sites = await get<SiteAccountView[]>(`/parties/${contractor}/sites`);
    expect(sites.map((site) => [site.project.name, site.limitPaise, site.status]).sort()).toEqual(
      [
        [SITES[0].name, SITES[0].limitRupees * 100, 'active'],
        [SITES[1].name, SITES[1].limitRupees * 100, 'on_hold'],
      ].sort(),
    );
    const party = await get<AgeingPage>('/receivables/ageing?limit=500');
    const total = party.rows.find((row) => row.id === contractor);
    const sum = Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, 0])) as Record<
      AgeingBucket,
      number
    >;
    const onSites = new Set<string>();
    for (const view of sites) {
      const site = await get<SiteAccountDetail>(`/site-accounts/${view.id}`);
      expect(site.ledger.length).toBeGreaterThan(0);
      const filtered = await get<AgeingPage>(
        `/receivables/ageing?limit=500&projectId=${view.project.id}`,
      );
      const row = filtered.rows.find((entry) => entry.id === contractor);
      expect(row?.totals.buckets ?? site.ageing).toEqual(site.ageing);
      expect(row?.totals.outstandingPaise ?? 0).toBe(site.outstandingPaise);
      for (const bucket of AGEING_BUCKETS) sum[bucket] += site.ageing[bucket];
      for (const document of site.openDocuments) onSites.add(document.documentId);
    }
    // The rest of the contractor's bills, on no site, aged from the 2.0 ledger.
    const ledger = await get<PartyLedgerView>(`/parties/${contractor}/ledger`);
    for (const document of ledger.openDocuments) {
      if (document.documentId !== null && onSites.has(document.documentId)) continue;
      const due = document.dueOn ?? document.issuedOn;
      const days = Math.round((Date.parse(indiaDate(0)) - Date.parse(due)) / 86_400_000);
      sum[ageingBucket(days)] += document.outstandingPaise;
    }
    expect(sum).toEqual(total?.totals.buckets);
    expect(total?.totals.netPaise).toBe(ledger.balancePaise);
  });

  it('collects: promises kept, broken and open, escalations, reminders, messages and links', async () => {
    const promises = await rows<{ status: string; count: number }>(
      sql`select status::text, count(*)::int as count from ${schema.promisesToPay} group by 1 order by 1`,
    );
    expect(promises).toEqual([
      { status: 'broken', count: 2 },
      { status: 'kept', count: 1 },
      // The site contractor's, running since yesterday; the dealer's, made again today.
      { status: 'open', count: 2 },
    ]);
    // Dated in the past, as they were made; never promised before they were made.
    const [dates] = await rows<{ bad: number; past: number }>(sql`
      select count(*) filter (where promised_on < made_on)::int as bad,
             count(*) filter (where made_on < ${indiaDate(0)}::date)::int as past
      from ${schema.promisesToPay}`);
    expect(dates).toEqual({ bad: 0, past: 4 });
    // The timeline's activity names the promised date as the promise has it.
    const activities = await rows<{ subject: string; promised: string }>(sql`
      select a.subject, p.promised_on::text as promised from ${schema.activities} a
      join ${schema.promisesToPay} p on p.activity_id = a.id`);
    expect(activities).toHaveLength(5);
    for (const activity of activities)
      expect(activity.subject).toContain(`by ${activity.promised}`);

    const escalations = await get<EscalationView[]>('/collections/escalations?open=false');
    expect(escalations).toHaveLength(2);
    expect(escalations.filter((e) => e.acknowledgedAt !== null).map((e) => e.party.id)).toEqual([
      await partyId('dealer-2'),
    ]);
    const worklist = await get<WorklistPage>('/collections/worklist?limit=200');
    expect(worklist.rows[0]?.openEscalationId).toEqual(expect.any(String));
    expect(worklist.rows.some((row) => row.openPromise !== null)).toBe(true);
    const schedules = await get<ReminderScheduleView[]>('/collections/reminder-schedules');
    expect(schedules.map((schedule) => schedule.offsetDays)).toEqual(
      REMINDER_SCHEDULES.map((schedule) => schedule.offsetDays),
    );

    const messages = await rows<{ template: string; status: string; reason: string | null }>(sql`
      select template_key as template, status, skip_reason as reason from ${schema.messageOutbox}
      group by 1, 2, 3 order by 1, 2, 3`);
    expect(messages).toEqual(
      expect.arrayContaining([
        { template: 'payment_reminder_overdue', status: 'sent', reason: null },
        { template: 'points_earned', status: 'sent', reason: null },
        { template: 'points_earned', status: 'skipped', reason: 'no_consent' },
        { template: 'statement_ready', status: 'sent', reason: null },
      ]),
    );
    const [provider] = await rows<{ providers: string[] }>(sql`
      select array_agg(distinct provider) as providers from ${schema.messageOutbox}
      where status = 'sent' and channel = 'whatsapp'`);
    expect(provider?.providers).toEqual(['log']);
    const [consents] = await rows<{ granted: number; withdrawn: number }>(sql`
      select count(*) filter (where state = 'granted')::int as granted,
             count(*) filter (where state = 'withdrawn')::int as withdrawn
      from ${schema.messagingConsents}`);
    expect(consents).toEqual({ granted: 6, withdrawn: 1 });
    const links = await rows<{ revoked: boolean }>(
      sql`select revoked_at is not null as revoked from ${schema.statementLinks} order by 1`,
    );
    expect(links).toEqual([{ revoked: false }, { revoked: true }]);
  });

  it('earns painter points by rules, double on one brand, and takes them back on a return', async () => {
    const rules = await get<EarnRuleView[]>('/loyalty-earn-rules');
    expect(rules).toHaveLength(3);
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          multiplierBps: 20_000,
          brand: expect.objectContaining({ name: 'Asian Paints' }),
        }),
      ]),
    );
    const [earned] = await rows<{ bills: number; points: number }>(sql`
      select count(*)::int as bills, sum(points)::int as points from ${schema.loyaltyLedger}
      where kind::text = 'influencer'`);
    expect(earned?.bills).toBe(6);
    expect(earned?.points).toBeGreaterThan(0);
    const [taken] = await rows<{ count: number }>(sql`
      select count(*)::int as count from ${schema.loyaltyLedger} l
      join ${schema.loyaltyAccounts} a on a.id = l.account_id
      join ${schema.taxDocuments} n on n.id = l.tax_document_id and n.kind = 'credit_note'
      where l.kind = 'adjust' and l.points < 0 and a.party_id = ${await partyId('painter-1')}`);
    expect(taken?.count).toBe(1);
  });
});

describe('brand schemes for the pilot walkthrough (round 5)', () => {
  it('shows per brand the distance to the next slab and the benefits outstanding', async () => {
    const schemes = await get<SchemeSummary[]>('/brand-schemes?status=active');
    const byName = Object.fromEntries(schemes.map((row) => [row.scheme.name, row]));
    const quarter = byName['Monsoon quarter'];
    const litres = byName['Litres booster'];
    // The first brand's quarter: its first slab reached, the second ahead, per day needed.
    expect(quarter?.scheme.brand.name).toBe('Asian Paints');
    expect(quarter?.progress.current?.index).toBe(0);
    expect(quarter?.progress.next?.distance).toBeGreaterThan(0);
    expect(quarter?.progress.next?.perDayNeeded).toBeGreaterThan(0);
    expect(quarter?.claim.money.expectedPaise).toBeGreaterThan(0);
    // The second brand's litres scheme: its first slab still ahead.
    expect(litres?.scheme.brand.name).not.toBe('Asian Paints');
    expect(litres?.progress.current).toBeNull();
    expect(litres?.progress.next?.distance).toBeGreaterThan(0);

    const overview = await get<SchemesOverview>('/brand-schemes/overview');
    expect(overview.activeSchemes).toBe(3);
    expect(overview.nearest).not.toBeNull();
    expect(overview.outstandingPaise).toBeGreaterThan(0);
    expect(overview.overdueClaims).toBe(1);
  });

  it('has a claim filed with the brand, partly paid by a credit note and overdue', async () => {
    const report = await get<SchemeClaimsReport>('/brand-schemes/claims');
    const booster = report.rows.find((row) => row.scheme.name === 'Pre-monsoon booster');
    expect(booster?.filed?.status).toBe('acknowledged');
    expect(booster?.claim.status).toBe('open');
    expect(booster?.claim.money.receivedPaise).toBeGreaterThan(0);
    expect(booster?.claim.money.outstandingPaise).toBeGreaterThan(0);
    // Ended 30 days ago, settled in 15: 15 days late.
    expect(booster?.claim.daysPastDue).toBe(15);
    expect(booster?.claim.bucket).toBe('days_0_30');
    expect(report.ageing.find((row) => row.bucket === 'days_0_30')?.claims).toBe(1);
    // The owner was told the claim is overdue.
    const [notice] = await rows<{ count: number }>(sql`
      select count(*)::int as count from ${schema.notifications}
      where event::text = 'scheme_claim_overdue'`);
    expect(notice?.count).toBeGreaterThan(0);
  });

  it('reconciles a month’s brand statement with its mismatches listed (spec §7 round 6)', async () => {
    const [statement] = await get<BrandStatementSummaryView[]>('/brand-statements');
    expect(statement).toMatchObject({ number: 'BS-000001', status: 'active', fileKept: false });
    const detail = await get<BrandStatementDetail>(`/brand-statements/${String(statement?.id)}`);
    const byDocument = (document: string) =>
      detail.lines.filter((line) => line.documentNumber?.endsWith(document));
    // Every GRN of the month is on it; all but the last match exactly, by number and with GST.
    const invoices = detail.lines.filter(
      (line) =>
        line.kind === 'invoice' && !line.documentNumber?.endsWith(STATEMENT_DEMO.missingInvoice),
    );
    expect(invoices.length).toBeGreaterThan(1);
    const partial = invoices.filter((line) => line.status === 'partial');
    expect(partial.map((line) => line.match?.differencePaise)).toEqual([
      STATEMENT_DEMO.rateDifferencePaise,
    ]);
    expect(invoices.filter((line) => line.status === 'matched')).toHaveLength(invoices.length - 1);
    // The invoice whose goods never came, and the credit note we did not record.
    expect(byDocument(STATEMENT_DEMO.missingInvoice).map((line) => line.status)).toEqual([
      'unmatched',
    ]);
    expect(byDocument(STATEMENT_DEMO.unrecordedCreditNote)).toMatchObject([
      {
        kind: 'credit_note',
        status: 'unmatched',
        amountPaise: -STATEMENT_DEMO.unrecordedCreditNotePaise,
      },
    ]);
    // The booster's credit note we recorded is matched by its reference.
    expect(byDocument('CN/26/88213').map((line) => line.status)).toEqual(['matched']);
    expect(byDocument(STATEMENT_DEMO.payment).map((line) => line.status)).toEqual(['untracked']);
    expect(statement?.mismatches).toBe(3);
    // The difference is explained, paisa for paisa.
    const { summary } = detail;
    expect(
      summary.amountDifferencesPaise +
        summary.unmatchedLinesPaise +
        summary.explainedLinesPaise +
        summary.untrackedLinesPaise -
        summary.ourUnmatchedPaise,
    ).toBe(summary.differencePaise);
    expect(summary.brandClosingPaise).toBe(summary.printedClosingPaise);
  });
});

describe('demo reset', () => {
  it('starts afresh, and spots a seed that never finished', async () => {
    await t.close();
    const { DEMO_CREDENTIALS_FILE: _file, ...withoutFile } = env;
    // The small demo, as a quick check that it holds together too.
    const reset = await seed('reset', { ...withoutFile, DEMO_SIZE: 'small' });
    expect(reset.code).toBe(0);
    expect(reset.output).toContain('Dropping the demo database');
    expect(reset.output).toContain('Seeded in');

    const name = new URL(demoUrl).pathname.slice(1);
    await withPgClient(serverUrl, (client) =>
      client.query(`COMMENT ON DATABASE "${name}" IS NULL`),
    );
    const unfinished = await seed('seed');
    expect(unfinished.code).toBe(1);
    expect(unfinished.output).toContain('did not finish');
    t = await startTestApp(demoUrl);
  }, 300_000);
});
