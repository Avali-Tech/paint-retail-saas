import { findAllocationMismatches, migrateDatabase, schema, withTenant } from '@paint/db';
import {
  AGEING_BUCKETS,
  type AgeingPage,
  type AgeingRowView,
  type AuthProfile,
  type PartyLedgerView,
  type PromiseView,
  type ReceivablesSummaryView,
  type StatementData,
  type WorklistPage,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  PAYMENT_LINK_GATEWAYS,
  type PaymentLinkGateways,
} from '../payment-links/payment-link-gateways.js';
import {
  LOG_SIGNATURE_HEADER,
  type LogPaymentLinkProvider,
} from '../payment-links/payment-link-provider.js';
import { findMismatches } from '../reconciliation/reconciler.js';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { Notifier } from '../notifications/notifier.js';
import { runCollections } from './collections-job.js';

/**
 * A pilot shop's collections morning (MVP 3 round 6, spec §7): the worker's run sends
 * the day's reminders with UPI links; a collector opens their worklist and records two
 * promises; a customer pays a reminder's link and the `log` gateway's signed webhook
 * records and allocates the money with no manual entry. Afterwards every figure the
 * shop reads agrees to the paisa: Σ party ledger = party balance, the ageing's net =
 * the balance, the statement's closing = the balance, the ledger screen's closing =
 * the balance, and the worklist's overdue = the ageing's overdue.
 */

const { allocations, partyBalances, partyLedger, paymentLinks, payments } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let collector: { token: string; memberId: string };
let today: string;
const day = (offset: number) => dbToday(t, offset);

/** Krishna: ₹590 45 days late (₹100 paid on it), ₹118 not due. */
let krishna: string;
/** Lakshmi: ₹236 10 days late. */
let lakshmi: string;
/** Ravi: ₹590 a week late (the day's reminder), ₹118 not due; pays the link. */
let ravi: string;
/** Venkat: ₹118 not due; on nobody's worklist. */
let venkat: string;

const gateways = () => t.app.get<PaymentLinkGateways>(PAYMENT_LINK_GATEWAYS, { strict: false });
const logGateway = (): LogPaymentLinkProvider => {
  const log = gateways().log;
  if (log === null) throw new Error('No log gateway');
  return log;
};
const get = async <T>(url: string, token = b.owner) => ok(await api(t, token).get(url)).json<T>();

async function customer(displayName: string): Promise<string> {
  return ok(
    await api(t, b.owner).post('/parties', {
      displayName,
      phone: uniquePhone(),
      roles: ['customer'],
      homeStoreId: b.stores.amp,
      customer: { assignedMemberId: collector.memberId },
    }),
  ).json<{ id: string }>().id;
}

async function bill(partyId: string, quantity: number, dueOn: string) {
  const draft = await b.draft({ partyId, dueOn, lines: [{ variantId: b.apex, quantity }] });
  return ok(await api(t, b.owner).post(`/invoices/${draft.id}/issue`, {})).json<{ id: string }>();
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    PAYMENT_LINK_PROVIDER: 'log',
    MESSAGING_PROVIDER: 'log',
    SMS_PROVIDER: 'log',
    APP_URL: 'https://app.example.in',
  });
  b = await billingBusiness(t);
  today = await dbToday(t);
  const token = await b.member('sales_executive', [b.stores.amp]);
  collector = { token, memberId: (await get<AuthProfile>('/auth/me', token)).memberId };

  krishna = await customer('Krishna Constructions');
  lakshmi = await customer('Lakshmi Interiors');
  ravi = await customer('Ravi Builders');
  venkat = await customer('Venkat Homes');
  const old = await bill(krishna, 5, await day(-45));
  await bill(krishna, 1, await day(10));
  ok(
    await api(t, b.owner).post('/payments', {
      storeId: b.stores.amp,
      partyId: krishna,
      modeId: b.modes.bank.id,
      amountPaise: 10_000,
      receivedOn: await day(-20),
      allocations: [{ documentId: old.id, amountPaise: 10_000 }],
    }),
  );
  await bill(lakshmi, 2, await day(-10));
  await bill(ravi, 5, await day(-7));
  await bill(ravi, 1, await day(10));
  await bill(venkat, 1, await day(5));

  // The shop's settings: a WhatsApp reminder a week after the due date; Ravi agreed to it.
  ok(
    await api(t, b.owner).put('/collections/reminder-schedules', {
      schedules: [{ offsetDays: 7, channels: ['whatsapp'], isActive: true }],
    }),
  );
  ok(
    await api(t, b.owner).post(`/parties/${ravi}/consents`, {
      channel: 'whatsapp',
      state: 'granted',
      method: 'counter_with_notice',
      language: 'en',
      noticeVersion: '2026-10',
    }),
  );
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

/** Party ledger sums and cached balances, for every party with a balance row. */
async function books() {
  return withTenant(t.connection.db, b.organizationId, async (tx) => {
    const ledger = await tx
      .select({ partyId: partyLedger.partyId, total: sql<string>`sum(${partyLedger.amountPaise})` })
      .from(partyLedger)
      .groupBy(partyLedger.partyId);
    const balances = await tx.select().from(partyBalances).orderBy(asc(partyBalances.partyId));
    return {
      ledger: new Map(ledger.map((row) => [row.partyId, Number(row.total)])),
      balances,
      mismatches: await findMismatches(tx),
      allocationMismatches: await findAllocationMismatches(tx),
    };
  });
}

const overdueOf = (row: AgeingRowView) => row.totals.outstandingPaise - row.totals.buckets.not_due;

describe('a pilot shop’s collections morning (round 6 demo)', () => {
  it('worklist, two promises, one UPI payment allocated by itself, then ageing, statements and the ledger agree to the paisa', async () => {
    // 1. The worker's morning run: Ravi's bill is a week late, so his reminder goes out
    //    with a UPI link for it.
    const run = await withTenant(t.connection.db, b.organizationId, (tx) =>
      runCollections(tx, t.app.get(Notifier), b.organizationId, gateways()),
    );
    expect(run).toEqual({ kept: 0, broken: 0, remindersQueued: 1 });
    const [link] = await t.connection.db
      .select()
      .from(paymentLinks)
      .where(eq(paymentLinks.partyId, ravi));
    expect(link).toMatchObject({ origin: 'reminder', amountPaise: 59_000, status: 'created' });

    // 2. The collector opens their worklist: the three late customers, the oldest debt first.
    const morning = await get<WorklistPage>(
      '/collections/worklist?salespersonId=me',
      collector.token,
    );
    expect(morning.rows.map((row) => [row.name, row.overduePaise, row.nextStep])).toEqual([
      ['Krishna Constructions', 49_000, 'contact'],
      ['Lakshmi Interiors', 23_600, 'contact'],
      ['Ravi Builders', 59_000, 'contact'],
    ]);
    expect(morning.overduePaise).toBe(131_600);

    // 3. Two calls, two promises: Krishna will pay ₹490 in three days, Lakshmi all today.
    const promise = async (partyId: string, amountPaise: number, promisedOn: string) =>
      ok(
        await api(t, collector.token).post(`/parties/${partyId}/promises`, {
          amountPaise,
          promisedOn,
          note: 'Spoke on the phone',
        }),
      ).json<PromiseView>();
    const krishnaPromise = await promise(krishna, 49_000, await day(3));
    const lakshmiPromise = await promise(lakshmi, 23_600, today);
    expect([krishnaPromise.status, lakshmiPromise.status]).toEqual(['open', 'open']);

    // 4. Ravi pays the reminder's link; the gateway's signed webhook records the payment
    //    and allocates it to the bill the link named, with no manual entry.
    const webhook = logGateway().webhook({
      type: 'payment.captured',
      linkId: String(link?.gatewayReference),
      payment: { amountPaise: 59_000 },
    });
    const delivered = await t.app.inject({
      method: 'POST',
      url: '/webhooks/payment-links/log',
      headers: { 'content-type': 'application/json', [LOG_SIGNATURE_HEADER]: webhook.signature },
      payload: webhook.body,
    });
    expect(ok(delivered).json()).toEqual({ received: 'applied' });
    const [payment] = await t.connection.db
      .select({ id: payments.id, amount: payments.amountPaise, mode: payments.modeKind })
      .from(payments)
      .where(eq(payments.partyId, ravi));
    expect(payment).toMatchObject({ amount: 59_000, mode: 'upi_link' });
    expect(
      await t.connection.db
        .select({ amount: allocations.amountPaise })
        .from(allocations)
        .where(eq(allocations.paymentId, String(payment?.id))),
    ).toEqual([{ amount: 59_000 }]);

    // 5. The worklist after: Ravi is off it; the two promises wait.
    const after = await get<WorklistPage>(
      '/collections/worklist?salespersonId=me',
      collector.token,
    );
    expect(
      after.rows.map((row) => [row.name, row.overduePaise, row.openPromise?.id, row.nextStep]),
    ).toEqual([
      ['Lakshmi Interiors', 23_600, lakshmiPromise.id, 'follow_up_promise'],
      ['Krishna Constructions', 49_000, krishnaPromise.id, 'await_promise'],
    ]);
    expect(after.overduePaise).toBe(72_600);

    // 6. Reconciled to the paisa.
    const { ledger, balances, mismatches, allocationMismatches } = await books();
    expect(mismatches).toEqual([]);
    expect(allocationMismatches).toEqual([]);
    const expected = new Map([
      [krishna, 59_000 + 11_800 - 10_000],
      [lakshmi, 23_600],
      [ravi, 11_800],
      [venkat, 11_800],
    ]);
    for (const [partyId, balance] of expected) {
      const row = balances.find((candidate) => candidate.partyId === partyId);
      // Σ party_ledger = party_balances, and both are what the story says.
      expect({ partyId, ledger: ledger.get(partyId), balance: row?.balancePaise }).toEqual({
        partyId,
        ledger: balance,
        balance,
      });
    }
    const ageing = await get<AgeingPage>('/receivables/ageing?limit=200');
    const summary = await get<ReceivablesSummaryView>('/receivables/summary');
    const from = await day(-90);
    for (const balance of balances) {
      const row = ageing.rows.find((candidate) => candidate.id === balance.partyId);
      const statement = await get<StatementData>(
        `/parties/${balance.partyId}/statement?from=${from}&to=${today}`,
      );
      const screen = await get<PartyLedgerView>(`/parties/${balance.partyId}/ledger`);
      expect({
        partyId: balance.partyId,
        ageingNet: row?.totals.netPaise ?? 0,
        ageingBuckets: row === undefined ? 0 : sumBuckets(row),
        statementClosing: statement.closingPaise,
        statementMoves: statement.openingPaise + statement.debitsPaise - statement.creditsPaise,
        statementAgeing: statement.ageing.netPaise,
        ledgerClosing: screen.closingPaise,
        ledgerBalance: screen.balancePaise,
      }).toEqual({
        partyId: balance.partyId,
        ageingNet: balance.balancePaise,
        ageingBuckets: balance.balancePaise + balance.advancePaise,
        statementClosing: balance.balancePaise,
        statementMoves: balance.balancePaise,
        statementAgeing: balance.balancePaise,
        ledgerClosing: balance.balancePaise,
        ledgerBalance: balance.balancePaise,
      });
    }
    const total = balances.reduce((sum, balance) => sum + balance.balancePaise, 0);
    expect([ageing.totals.netPaise, summary.totals.netPaise]).toEqual([total, total]);
    // The worklist's overdue is the ageing's overdue, customer by customer.
    for (const row of after.rows) {
      const aged = ageing.rows.find((candidate) => candidate.id === row.partyId);
      expect(aged === undefined ? 0 : overdueOf(aged)).toBe(row.overduePaise);
    }
    expect(ageing.rows.reduce((sum, row) => sum + overdueOf(row), 0)).toBe(after.overduePaise);
    // Ravi's statement shows the link payment against the bill; only the bill not due is left.
    const raviStatement = await get<StatementData>(
      `/parties/${ravi}/statement?from=${from}&to=${today}`,
    );
    expect(raviStatement.openItems.map((item) => item.outstandingPaise)).toEqual([11_800]);
    expect(raviStatement.creditsPaise).toBe(59_000);
  });
});

const sumBuckets = (row: AgeingRowView) =>
  AGEING_BUCKETS.reduce((sum, bucket) => sum + row.totals.buckets[bucket], 0);
