import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  migrateDatabase,
  schema,
} from '@paint/db';
import type {
  CreditApprovalRefusal,
  GoLivePreview,
  GoLiveResult,
  IssuedInvoiceView,
  OrderCreditView,
  PartyLedgerView,
  SalesOrderView,
  TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

const { creditProfiles, loyaltyLedger, loyaltyAccounts } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
/** A painter with an imported opening balance, and a regular with loyalty points. */
let painter: string;

interface LoyaltyView {
  readonly balance: number;
  readonly ledger: {
    readonly items: {
      kind: string;
      points: number;
      reference: string | null;
      note: string | null;
      expiresOn: string | null;
    }[];
  };
}
interface CreditView {
  readonly exposurePaise: number;
  readonly exposureSource: string;
  readonly manualExposurePaise: number;
  readonly overdueDays: number;
  readonly check: { utilizationPercent: number | null };
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  // MVP 1 figures: a ₹30,000 limit, ₹18,000 owed by hand, 10 days late.
  await t.connection.db.insert(creditProfiles).values({
    organizationId: b.organizationId,
    partyId: b.parties.contractor,
    status: 'active',
    limitPaise: 3_000_000,
    creditDays: 30,
    manualExposurePaise: 1_800_000,
    overdueDays: 10,
  });
  painter = ok(
    await api(t, b.owner).post('/parties', {
      displayName: 'Ravi Painter',
      phone: '+919812300002',
      roles: ['painter'],
    }),
  ).json<{ id: string }>().id;
  ok(await api(t, b.owner).post(`/parties/${b.parties.homeowner}/loyalty`, {}));
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const loyalty = async (partyId = b.parties.homeowner) =>
  ok(await owner().get(`/parties/${partyId}/loyalty?limit=50`)).json<LoyaltyView>();
const credit = async () =>
  ok(await owner().get(`/parties/${b.parties.contractor}/credit`)).json<CreditView>();
/** An issued counter invoice for `quantity` litres (₹100 taxable each). */
const invoice = (partyId: string, quantity: number, draft: object = {}) =>
  b.invoice({ partyId, quantity, ...draft });

describe('before go-live', () => {
  it('previews the opening balances from the hand-entered figures', async () => {
    expect(ok(await owner().get('/sales/go-live')).json<GoLivePreview>()).toEqual({
      billingLiveOn: null,
      live: false,
      stockPostOn: 'invoice',
      openings: [
        {
          partyId: b.parties.contractor,
          partyName: 'Deccan Contractors',
          manualExposurePaise: 1_800_000,
          overdueDays: 10,
          amountPaise: 1_800_000,
          overdueSince: await dbToday(t, -10),
          source: 'manual',
        },
      ],
      loyaltyAccounts: 1,
    });
    const fresh = await billingBusiness(t);
    expect(ok(await api(t, fresh.owner).get('/sales/go-live')).json<GoLivePreview>()).toEqual({
      billingLiveOn: null,
      live: false,
      stockPostOn: 'invoice',
      openings: [],
      loyaltyAccounts: 0,
    });
    // Going live with the hand-entered figures as they are: an amount owed, nothing late.
    await t.connection.db.insert(creditProfiles).values({
      organizationId: fresh.organizationId,
      partyId: fresh.parties.contractor,
      manualExposurePaise: 500,
    });
    expect(ok(await api(t, fresh.owner).post('/sales/go-live', {})).json<GoLiveResult>()).toEqual({
      billingLiveOn: today,
      openingEntries: 1,
      openingTotalPaise: 500,
    });
    const [profile] = await t.connection.db
      .select({ since: creditProfiles.openingOverdueSince })
      .from(creditProfiles)
      .where(eq(creditProfiles.partyId, fresh.parties.contractor));
    expect(profile?.since).toBeNull();
  });

  it('keeps manual figures and purchases, and earns no points on invoices yet', async () => {
    expect(await credit()).toMatchObject({
      exposureSource: 'manual',
      exposurePaise: 1_800_000,
      overdueDays: 10,
    });
    ok(
      await owner().post(`/parties/${b.parties.homeowner}/loyalty/purchases`, {
        manualPurchasePaise: 50_000,
        reference: 'BILL-1',
      }),
    );
    const early = await invoice(b.parties.homeowner, 3);
    expect((await loyalty()).ledger.items.map((item) => item.kind)).toEqual(['purchase']);
    // Cancelling an invoice that earned nothing takes nothing back.
    ok(await owner().post(`/invoices/${early.id}/cancel`, { reason: 'Billed twice' }));
    expect((await loyalty()).balance).toBe(5);

    const set = await owner().put('/sales/settings', { billingLiveOn: today });
    expect(issuesOf(set)).toEqual(['billingLiveOn']);
  });
});

describe('POST /sales/go-live', () => {
  it('refuses a future date, an unknown party or one listed twice', async () => {
    expect(issuesOf(await owner().post('/sales/go-live', { liveOn: await dbToday(t, 1) }))).toEqual(
      ['liveOn'],
    );
    expect(
      issuesOf(
        await owner().post('/sales/go-live', {
          openings: [{ partyId: crypto.randomUUID(), amountPaise: 1 }],
        }),
      ),
    ).toEqual(['openings.0.partyId']);
    expect(
      issuesOf(
        await owner().post('/sales/go-live', {
          openings: [
            { partyId: painter, amountPaise: 1 },
            { partyId: painter, amountPaise: 2 },
          ],
        }),
      ),
    ).toEqual(['openings']);
    const staff = await b.member('branch_manager', [b.stores.amp]);
    expect((await api(t, staff).post('/sales/go-live', {})).statusCode).toBe(403);
  });

  it('posts one opening entry per party in one go, then never again', async () => {
    const headers = { 'idempotency-key': 'go-live' };
    const body = {
      openings: [
        { partyId: painter, amountPaise: 5_000, overdueSince: await dbToday(t, -3) },
        { partyId: b.parties.homeowner, amountPaise: 0 },
      ],
    };
    const result = ok(
      await api(t, b.owner, headers).post('/sales/go-live', body),
    ).json<GoLiveResult>();
    expect(result).toEqual({
      billingLiveOn: today,
      openingEntries: 2,
      openingTotalPaise: 1_805_000,
    });
    expect(
      ok(await api(t, b.owner, headers).post('/sales/go-live', body)).json<GoLiveResult>(),
    ).toEqual(result);
    expect((await owner().post('/sales/go-live', {})).statusCode).toBe(409);
    expect(ok(await owner().get('/sales/go-live')).json<GoLivePreview>()).toMatchObject({
      billingLiveOn: today,
      live: true,
      openings: [],
    });

    const ledger = ok(
      await owner().get(`/parties/${b.parties.contractor}/ledger`),
    ).json<PartyLedgerView>();
    expect(ledger.entries).toEqual([
      expect.objectContaining({ entryType: 'opening', amountPaise: 1_800_000, entryOn: today }),
    ]);
    const [painterProfile] = await t.connection.db
      .select({ since: creditProfiles.openingOverdueSince, status: creditProfiles.status })
      .from(creditProfiles)
      .where(eq(creditProfiles.partyId, painter));
    expect(painterProfile).toEqual({ since: await dbToday(t, -3), status: 'none' });
    expect(await findPartyBalanceMismatches(t.connection.db)).toEqual([]);
    expect(await findAllocationMismatches(t.connection.db)).toEqual([]);
    // The date never moves afterwards.
    expect(issuesOf(await owner().put('/sales/settings', { billingLiveOn: null }))).toEqual([
      'billingLiveOn',
    ]);
  });
});

describe('after go-live', () => {
  it('reads exposure from the ledger and open postpaid orders, and keeps the manual figures', async () => {
    expect(await credit()).toMatchObject({
      exposureSource: 'ledger',
      exposurePaise: 1_800_000,
      manualExposurePaise: 1_800_000,
      overdueDays: 10,
    });
    const edit = await owner().patch(`/parties/${b.parties.contractor}/credit`, {
      manualExposurePaise: 0,
    });
    expect(edit.statusCode).toBe(409);
    ok(await owner().patch(`/parties/${b.parties.contractor}/credit`, { risk: 'medium' }));

    // §6.3 on real data: ₹15,000 on top of ₹18,000 owed is 110% of ₹30,000.
    const order = ok(
      await owner().post('/sales-orders', {
        storeId: b.stores.amp,
        billToPartyId: b.parties.contractor,
        paymentTerms: 'postpaid',
        lines: [{ variantId: b.apex, quantity: 10, unitPricePaise: 150_000 }],
      }),
    ).json<SalesOrderView>();
    const asked = await owner().post(`/sales-orders/${order.id}/confirm`, {});
    expect(asked.json<CreditApprovalRefusal>()).toMatchObject({
      code: 'credit_approval_required',
      credit: {
        exposureSource: 'ledger',
        position: { exposurePaise: 1_800_000, overdueDays: 10 },
        check: { utilizationPercent: 110 },
        approval: 'owner',
      },
    });
    ok(
      await owner().post(`/sales-orders/${order.id}/confirm`, {
        creditOverride: { reason: 'Big site, pays on time' },
      }),
    );
    // The open order counts towards what the party owes.
    expect((await credit()).exposurePaise).toBe(3_300_000);

    // Billing part of it moves that part from the order to the ledger.
    const draft = ok(
      await owner().post(`/sales-orders/${order.id}/invoices`, {
        lines: [{ orderLineId: order.lines[0]?.id, quantity: 4 }],
      }),
    ).json<TaxDocumentView>();
    const billed = ok(
      await owner().post(`/invoices/${draft.id}/issue`, {}),
    ).json<IssuedInvoiceView>();
    expect(billed.dueOn).toBe(await dbToday(t, 30));
    expect((await credit()).exposurePaise).toBe(3_300_000);

    // Paying the opening balance clears its lateness; a bill past its due date is late instead.
    const ledger = ok(
      await owner().get(`/parties/${b.parties.contractor}/ledger`),
    ).json<PartyLedgerView>();
    const opening = ledger.openDocuments.find((item) => item.kind === 'opening');
    ok(
      await owner().post('/payments', {
        storeId: b.stores.amp,
        partyId: b.parties.contractor,
        modeId: b.modes.bank.id,
        amountPaise: 1_800_000,
        reference: 'NEFT001',
        allocations: [{ partyLedgerId: opening?.partyLedgerId, amountPaise: 1_800_000 }],
      }),
    );
    expect(await credit()).toMatchObject({ exposurePaise: 1_500_000, overdueDays: 0 });
    const late = await b.draft({
      partyId: b.parties.contractor,
      dueOn: await dbToday(t, -5),
      lines: [{ variantId: b.apex, quantity: 1 }],
    });
    ok(await owner().post(`/invoices/${late.id}/issue`, {}));
    expect((await credit()).overdueDays).toBe(5);

    const list = ok(await owner().get('/credit-profiles')).json<{
      items: { party: { id: string }; exposureSource: string; exposurePaise: number }[];
    }>();
    expect(list.items.find((item) => item.party.id === b.parties.contractor)).toMatchObject({
      exposureSource: 'ledger',
      exposurePaise: 1_511_800,
    });
    const check = ok(
      await owner().get(`/sales-orders/${order.id}/credit-check`),
    ).json<OrderCreditView>();
    expect(check.position.exposurePaise).toBe(1_511_800 - 900_000);
  });

  it('earns loyalty points on invoices and takes them back on returns and cancellations', async () => {
    // Bills on account after go-live are credit (MVP 3 spec §4.2): this regular buys on credit.
    await t.connection.db.insert(creditProfiles).values({
      organizationId: b.organizationId,
      partyId: b.parties.homeowner,
      status: 'active',
      limitPaise: 10_000_000,
      creditDays: 30,
    });
    // Points that never expire while the programme has no expiry.
    await invoice(b.parties.homeowner, 1);
    // Matched by content, not position: entries are ordered by the database clock.
    expect((await loyalty()).ledger.items).toContainEqual(
      expect.objectContaining({ kind: 'purchase', points: 1, expiresOn: null }),
    );
    ok(
      await owner().put('/loyalty-settings', {
        earnPoints: 1,
        earnPerPaise: 10_000,
        tiers: [],
        expiryDays: 365,
        minRedemptionPoints: 0,
      }),
    );
    const manual = await owner().post(`/parties/${b.parties.homeowner}/loyalty/purchases`, {
      manualPurchasePaise: 50_000,
      reference: 'BILL-2',
    });
    expect(manual.statusCode).toBe(409);
    const before = (await loyalty()).balance;

    const sale = await invoice(b.parties.homeowner, 10);
    let account = await loyalty();
    expect(account.balance).toBe(before + 10);
    expect(account.ledger.items).toContainEqual(
      expect.objectContaining({
        kind: 'purchase',
        points: 10,
        reference: sale.number,
        expiresOn: await dbToday(t, 365),
      }),
    );

    // 3 of 10 litres back: 3 points; then a discount note of ₹10 taxable takes 1 more.
    ok(
      await owner().post('/sales-returns', {
        invoiceId: sale.id,
        lines: [{ invoiceLineId: sale.lines[0]?.id, quantity: 3, disposition: 'restock' }],
      }),
    );
    account = await loyalty();
    expect(account.balance).toBe(before + 7);
    expect(account.ledger.items).toContainEqual(
      expect.objectContaining({ kind: 'adjust', points: -3 }),
    );
    ok(
      await owner().post('/credit-notes', {
        invoiceId: sale.id,
        reason: 'overcharge',
        lines: [{ invoiceLineId: sale.lines[0]?.id, valuePaise: 11_800 }],
      }),
    );
    expect((await loyalty()).balance).toBe(before + 6);

    // A same-day cancellation takes back everything the invoice earned.
    const cancelled = await invoice(b.parties.homeowner, 4);
    expect((await loyalty()).balance).toBe(before + 10);
    ok(await owner().post(`/invoices/${cancelled.id}/cancel`, { reason: 'Wrong party' }));
    account = await loyalty();
    expect(account.balance).toBe(before + 6);
    expect(account.ledger.items).toContainEqual(
      expect.objectContaining({
        kind: 'adjust',
        points: -4,
        note: `Cancelled invoice ${String(cancelled.number)}`,
      }),
    );

    // Never below zero: points already spent are not taken back.
    const spent = await invoice(b.parties.homeowner, 2);
    ok(
      await owner().post(`/parties/${b.parties.homeowner}/loyalty/redemptions`, {
        points: (await loyalty()).balance,
      }),
    );
    ok(await owner().post(`/invoices/${spent.id}/cancel`, { reason: 'Returned unopened' }));
    expect((await loyalty()).balance).toBe(0);

    // Too small to earn, no account, or a closed account: nothing.
    await invoice(b.parties.homeowner, 0.5);
    await invoice(b.parties.contractor, 5);
    ok(await owner().patch(`/parties/${b.parties.homeowner}/loyalty`, { status: 'closed' }));
    await invoice(b.parties.homeowner, 5);
    const purchases = await t.connection.db
      .select({ points: loyaltyLedger.points })
      .from(loyaltyLedger)
      .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, loyaltyLedger.accountId))
      .where(
        and(eq(loyaltyAccounts.partyId, b.parties.homeowner), eq(loyaltyLedger.kind, 'purchase')),
      )
      .orderBy(loyaltyLedger.points);
    expect(purchases.map((row) => row.points)).toEqual([1, 2, 4, 5, 10]);
  });
});
