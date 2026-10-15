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
  isValidGstin,
  type GoLivePreview,
  type GstRegistrations,
  type LatestReconciliation,
} from '@paint/shared';
import { withPgClient } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { appCode } from '../test-support/two-factor.js';
import { bearer, startTestApp, TEST_AUTH_SECRET, type TestApp } from '../test-support/test-app.js';
import { DemoApi, DemoApiError } from './api-client.js';
import { HistoryClock, indiaDate } from './history-clock.js';
import {
  DEMO_OPERATOR,
  DEMO_OPERATOR_TOTP_SECRET,
  DEMO_PASSWORD,
  DEMO_TOTP_SECRET,
} from './plan.js';
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
}, 300_000);

afterAll(async () => {
  await t.close();
  await withPgClient(serverUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS "${new URL(demoUrl).pathname.slice(1)}" WITH (FORCE)`),
  );
});

describe('demo seed command', () => {
  it('creates the database, seeds it and writes the sign-in sheet', async () => {
    expect(firstRun.code).toBe(0);
    expect(firstRun.output).toContain('Seeding Sharma Paints & Hardware (full)');
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
    expect(branding.branding.appName).toBe('Sharma Paints');
    // Its branded sign-in page, printed on the sheet, shows the same look before sign-in.
    const identity = await get<{ slug: string }>('/organization/identity');
    expect(identity.slug).toBe('sharma-paints');
    expect(readFileSync(credentialsFile, 'utf8')).toContain(
      'http://localhost:4981/sign-in?b=sharma-paints',
    );
    const page = await t.app.inject({ method: 'GET', url: '/public/branding/sharma-paints' });
    expect(page.json<{ branding: { appName: string } }>().branding.appName).toBe('Sharma Paints');
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

  it('has credit accounts: one on hold, one near its limit, two requests waiting', async () => {
    const profiles = await get<{
      items: { status: string; check: { utilizationPercent: number | null } }[];
    }>('/credit-profiles?limit=200');
    expect(profiles.items.filter((p) => p.status === 'on_hold')).toHaveLength(1);
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
    expect(registrations.legalName).toBe('Sharma Paints & Hardware');
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
    expect(notes.items.filter((note) => note.kind === 'credit_note')).toHaveLength(3);
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
