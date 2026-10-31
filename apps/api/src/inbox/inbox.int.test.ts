import { migrateDatabase, schema, withTenant } from '@paint/db';
import type {
  AuthProfile,
  CreditApprovalView,
  InboxCount,
  InboxItem,
  InboxKind,
  InboxView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runCollections } from '../collections/collections-job.js';
import { Notifier } from '../notifications/notifier.js';
import {
  api,
  billingBusiness,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

const { promisesToPay } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;

/** Members' sessions (and their member ids). */
const m = {
  owner: '',
  admin: '',
  ampManager: '',
  kkpManager: '',
  sales: '',
  stocker: '',
  cashier: '',
  /** A branch manager whose sale approvals and stock management are taken away. */
  noApprovals: '',
  /** A branch manager also given credit:approve. */
  creditApprover: '',
  /** A sales executive also given inventory:manage. */
  salesStock: '',
  /** A store employee also given purchasing:manage. */
  buyer: '',
};
const memberIds = new Map<string, string>();

/** What each test expects to find, by name. */
const ids = {
  saleBySales: '',
  ownerLevel: '',
  saleByManager: '',
  kkpSale: '',
  release: '',
  releaseWide: '',
  requestWide: '',
  requestKkp: '',
  t1: '',
  t2: '',
  t3: '',
  countAmp: '',
  countKkp: '',
  escalationAmp: '',
  escalationKkp: '',
  escalationWide: '',
  overdue: '',
  today: '',
  cashierToday: '',
};

let kkpParty = '';
let ampParty = '';
let primer = '';

const inbox = async (token: string, query = '') =>
  ok(await api(t, token).get(`/inbox${query}`)).json<InboxView>();
const count = async (token: string) =>
  ok(await api(t, token).get('/inbox/count')).json<InboxCount>().total;
const group = (view: InboxView, kind: InboxKind) =>
  view.groups.find((candidate) => candidate.kind === kind);
const idsOf = (view: InboxView, kind: InboxKind) =>
  (group(view, kind)?.items ?? []).map((item) => item.id);
const item = (view: InboxView, kind: InboxKind, id: string): InboxItem => {
  const found = group(view, kind)?.items.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No ${kind} ${id}`);
  return found;
};

async function customer(body: object): Promise<string> {
  return ok(
    await api(t, m.owner).post('/parties', { phone: uniquePhone(), roles: ['customer'], ...body }),
  ).json<{ id: string }>().id;
}

/** Gives a party a credit limit the real way: a request the owner approves. */
async function limit(partyId: string, limitPaise: number) {
  const request = ok(
    await api(t, m.owner).post('/credit-requests', { partyId, limitPaise, creditDays: 30 }),
  ).json<{ id: string }>();
  ok(await api(t, m.owner).post(`/credit-requests/${request.id}/approve`, {}));
}

/** A credit approval for a draft bill of `paise` at a store, asked by `token`. */
async function saleApproval(paise: number, token: string, storeId = b.stores.amp) {
  const draft = await b.draft(
    {
      storeId,
      partyId: b.parties.contractor,
      lines: [{ variantId: b.apex, quantity: 1, unitPricePaise: paise }],
    },
    token,
  );
  return ok(
    await api(t, token).post('/credit-approvals', {
      invoiceId: draft.id,
      amountPaise: paise,
      reason: 'Regular customer',
    }),
  ).json<CreditApprovalView>();
}

async function transfer(from: string, to: string) {
  return ok(
    await api(t, m.owner).post('/transfers', {
      fromStoreId: from,
      toStoreId: to,
      lines: [{ variantId: b.apex, quantity: 5 }],
    }),
  ).json<{ id: string }>().id;
}

async function submittedCount(storeId: string, token: string) {
  const id = ok(await api(t, token).post('/stock-counts', { storeId })).json<{ id: string }>().id;
  ok(await api(t, token).post(`/stock-counts/${id}/submit`, { uncountedAsZero: true }));
  return id;
}

async function followUp(subject: string, dueAt: Date, assignee: string) {
  return ok(
    await api(t, m.owner).post('/activities', {
      recordType: 'party',
      recordId: b.parties.homeowner,
      type: 'call',
      subject,
      dueAt: dueAt.toISOString(),
      assignedMemberId: memberIds.get(assignee),
    }),
  ).json<{ id: string }>().id;
}

const DAY = 86_400_000;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  const { amp, kkp } = b.stores;
  m.owner = b.owner;
  m.admin = await b.member('org_admin', [amp]);
  m.ampManager = await b.member('branch_manager', [amp]);
  m.kkpManager = await b.member('branch_manager', [kkp]);
  m.sales = await b.member('sales_executive', [amp]);
  m.stocker = await b.member('inventory_manager', [amp]);
  m.cashier = await b.member('store_employee', [amp]);
  m.noApprovals = await b.member('branch_manager', [amp], {
    denied: ['credit:approve_sale', 'inventory:manage'],
  });
  m.creditApprover = await b.member('branch_manager', [amp], { granted: ['credit:approve'] });
  m.salesStock = await b.member('sales_executive', [amp], { granted: ['inventory:manage'] });
  m.buyer = await b.member('store_employee', [amp], { granted: ['purchasing:manage'] });
  for (const token of Object.values(m)) {
    memberIds.set(token, ok(await api(t, token).get('/auth/me')).json<AuthProfile>().memberId);
  }
  ok(
    await api(t, m.owner).patch(`/members/${String(memberIds.get(m.admin))}`, { allStores: true }),
  );
  ampParty = await customer({ displayName: 'Ameerpet Traders', homeStoreId: amp });
  kkpParty = await customer({ displayName: 'Kukatpally Traders', homeStoreId: kkp });

  // Credit: billing live, the contractor's limit ₹30,000, then approvals at each level.
  ok(await api(t, m.owner).post('/sales/go-live', {}));
  await limit(b.parties.contractor, 3_000_000);
  // ₹25,000 is 83% of the limit (a manager approves), ₹33,000 is 110% (the owner).
  ids.saleBySales = (await saleApproval(2_500_000, m.sales)).id;
  ids.ownerLevel = (await saleApproval(3_300_000, m.ampManager)).id;
  ids.saleByManager = (await saleApproval(2_500_000, m.ampManager)).id;
  ids.kkpSale = (await saleApproval(2_500_000, m.admin, kkp)).id;
  // Ameerpet Traders is on hold; the sales executive asks for the release.
  await limit(ampParty, 1_000_000);
  ok(await api(t, m.owner).post(`/parties/${ampParty}/credit/hold`, { reason: 'Cheque bounced' }));
  ids.release = ok(
    await api(t, m.sales).post('/credit-approvals', {
      kind: 'release',
      partyId: ampParty,
      reason: 'Paid in cash today',
    }),
  ).json<CreditApprovalView>().id;
  // A business-wide customer on hold: its release belongs to no store.
  const wideParty = await customer({ displayName: 'Wide Traders' });
  await limit(wideParty, 1_000_000);
  ok(await api(t, m.owner).post(`/parties/${wideParty}/credit/hold`, { reason: 'Disputed bill' }));
  ids.releaseWide = ok(
    await api(t, m.sales).post('/credit-approvals', {
      kind: 'release',
      partyId: wideParty,
      reason: 'Dispute settled',
    }),
  ).json<CreditApprovalView>().id;
  // Credit requests waiting: a business-wide customer's and a Kukatpally customer's.
  ids.requestWide = ok(
    await api(t, m.sales).post('/credit-requests', {
      partyId: b.parties.homeowner,
      limitPaise: 5_000_000,
      creditDays: 15,
    }),
  ).json<{ id: string }>().id;
  ids.requestKkp = ok(
    await api(t, m.owner).post('/credit-requests', {
      partyId: kkpParty,
      limitPaise: 2_000_000,
      creditDays: 15,
    }),
  ).json<{ id: string }>().id;

  // Transfers: Ameerpet to approve, Kukatpally to dispatch, Ameerpet to receive.
  ids.t1 = await transfer(amp, kkp);
  ids.t2 = await transfer(kkp, amp);
  ok(await api(t, m.owner).post(`/transfers/${ids.t2}/approve`, {}));
  ids.t3 = await transfer(kkp, amp);
  ok(await api(t, m.owner).post(`/transfers/${ids.t3}/approve`, {}));
  ok(await api(t, m.owner).post(`/transfers/${ids.t3}/dispatch`, {}));

  // Low stock: Ameerpet's Apex below its minimum and a primer it has none of;
  // Kukatpally's Apex at its reorder level.
  const brandId = ok(await api(t, m.owner).post('/brands', { name: 'Berger' })).json<{
    id: string;
  }>().id;
  const options = ok(await api(t, m.owner).get('/tax-categories/options')).json<{
    categories: { id: string; key: string }[];
  }>();
  primer = String(
    ok(
      await api(t, m.owner).post('/products', {
        brandId,
        name: 'Primer',
        type: 'primer',
        hsnCode: '32091090',
        taxCategoryId: options.categories.find((category) => category.key === 'paints')?.id,
        variants: [{ sku: 'PRM-4L', packSize: 4, unit: 'l', sellingPricePaise: 90_000 }],
      }),
    ).json<{ variants: { id: string }[] }>().variants[0]?.id,
  );
  const rule = (storeId: string, variantId: string, minQuantity: number, reorderLevel: number) => ({
    storeId,
    variantId,
    minQuantity,
    reorderLevel,
    maxQuantity: 40_000,
  });
  ok(
    await api(t, m.owner).put('/reorder-rules', {
      rules: [
        rule(amp, b.apex, 20_000, 30_000),
        rule(amp, primer, 2, 5),
        rule(kkp, b.apex, 5_000, 30_000),
      ],
    }),
  );

  // Stock counts submitted: Ameerpet's by its manager, Kukatpally's by the owner.
  ids.countAmp = await submittedCount(amp, m.ampManager);
  ids.countKkp = await submittedCount(kkp, m.owner);

  // Broken promises, escalated by the morning run.
  const escalated = async (partyId: string) => {
    await t.connection.db.insert(promisesToPay).values({
      organizationId: b.organizationId,
      partyId,
      amountPaise: 100_000,
      madeOn: new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10),
      promisedOn: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10),
      createdByMemberId: String(memberIds.get(m.owner)),
    });
  };
  await escalated(ampParty);
  await escalated(kkpParty);
  await escalated(b.parties.homeowner);
  await withTenant(t.connection.db, b.organizationId, (tx) =>
    runCollections(tx, t.app.get(Notifier), b.organizationId),
  );
  const escalations = ok(await api(t, m.owner).get('/collections/escalations')).json<
    { id: string; party: { id: string } }[]
  >();
  const escalationOf = (partyId: string) =>
    String(escalations.find((escalation) => escalation.party.id === partyId)?.id);
  ids.escalationAmp = escalationOf(ampParty);
  ids.escalationKkp = escalationOf(kkpParty);
  ids.escalationWide = escalationOf(b.parties.homeowner);

  // Follow-ups: the sales executive's overdue and today's; later ones, others' and done ones are not.
  const now = Date.now();
  ids.overdue = await followUp('Call about the shade card', new Date(now - 2 * DAY), m.sales);
  ids.today = await followUp('Visit the site', new Date(now), m.sales);
  await followUp('Next week', new Date(now + 3 * DAY), m.sales);
  ids.cashierToday = await followUp('Ring back', new Date(now), m.cashier);
  const done = await followUp('Already done', new Date(now - DAY), m.sales);
  ok(await api(t, m.owner).post(`/activities/${done}/complete`, {}));
}, 300_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('credit approvals', () => {
  it('shows each approver what they may decide, never their own request', async () => {
    expect(idsOf(await inbox(m.owner), 'credit_approval')).toEqual(
      expect.arrayContaining([
        ids.saleBySales,
        ids.ownerLevel,
        ids.saleByManager,
        ids.kkpSale,
        ids.release,
        ids.releaseWide,
      ]),
    );
    expect(idsOf(await inbox(m.owner), 'credit_approval')).toHaveLength(6);
    // An admin decides manager-level sales anywhere, and releases; not the owner's level, not their own.
    expect(new Set(idsOf(await inbox(m.admin), 'credit_approval'))).toEqual(
      new Set([ids.saleBySales, ids.saleByManager, ids.release, ids.releaseWide]),
    );
    // A branch manager: manager-level sales at their store, not their own, no releases.
    expect(idsOf(await inbox(m.ampManager), 'credit_approval')).toEqual([ids.saleBySales]);
    expect(idsOf(await inbox(m.kkpManager), 'credit_approval')).toEqual([ids.kkpSale]);
    // Exceptions: credit:approve adds releases; without credit:approve_sale there is nothing.
    expect(new Set(idsOf(await inbox(m.creditApprover), 'credit_approval'))).toEqual(
      new Set([ids.saleBySales, ids.saleByManager, ids.release, ids.releaseWide]),
    );
    expect((await inbox(m.noApprovals)).kinds).not.toContain('credit_approval');
    expect((await inbox(m.sales)).kinds).not.toContain('credit_approval');
  });

  it('describes an approval with its store, amount, age and actions', async () => {
    const view = await inbox(m.ampManager);
    expect(item(view, 'credit_approval', ids.saleBySales)).toEqual({
      kind: 'credit_approval',
      id: ids.saleBySales,
      step: 'approve_sale',
      reference: expect.stringMatching(/^AP-\d{6}$/),
      title: 'Deccan Contractors',
      requestedBy: 'Staff sales_executive',
      store: { id: b.stores.amp, name: 'Ameerpet' },
      amountPaise: 2_500_000,
      since: expect.any(String),
      due: null,
      quantity: null,
      priority: 'high',
      link: `/credit/approvals/${ids.saleBySales}`,
      actions: [
        {
          key: 'approve',
          endpoint: `/credit-approvals/${ids.saleBySales}/approve`,
          input: 'note',
        },
        {
          key: 'reject',
          endpoint: `/credit-approvals/${ids.saleBySales}/reject`,
          input: 'reason',
        },
      ],
    });
    expect(item(await inbox(m.owner), 'credit_approval', ids.release)).toMatchObject({
      step: 'approve_release',
      title: 'Ameerpet Traders',
      amountPaise: null,
      store: { id: b.stores.amp, name: 'Ameerpet' },
    });
    expect(item(await inbox(m.owner), 'credit_approval', ids.releaseWide).store).toBeNull();
  });
});

describe('credit requests', () => {
  it('goes to those who approve credit, at the customers they see', async () => {
    expect(new Set(idsOf(await inbox(m.owner), 'credit_request'))).toEqual(
      new Set([ids.requestWide, ids.requestKkp]),
    );
    expect(new Set(idsOf(await inbox(m.admin), 'credit_request'))).toEqual(
      new Set([ids.requestWide, ids.requestKkp]),
    );
    // An Ameerpet manager given credit:approve sees business-wide and Ameerpet customers.
    expect(idsOf(await inbox(m.creditApprover), 'credit_request')).toEqual([ids.requestWide]);
    expect((await inbox(m.ampManager)).kinds).not.toContain('credit_request');
    expect(item(await inbox(m.owner), 'credit_request', ids.requestKkp)).toMatchObject({
      step: 'decide_request',
      reference: expect.stringMatching(/^CR-/),
      title: 'Kukatpally Traders',
      requestedBy: 'Owner',
      store: { id: b.stores.kkp, name: 'Kukatpally' },
      amountPaise: 2_000_000,
      priority: 'normal',
      link: `/credit-requests/${ids.requestKkp}`,
      actions: [{ key: 'approve' }, { key: 'reject' }],
    });
    // The screen's filter by store: the customers whose home store it is.
    const atKkp = ok(
      await api(t, m.owner).get(`/credit-requests?status=pending&storeId=${b.stores.kkp}`),
    ).json<{ items: { id: string }[] }>();
    expect(atKkp.items.map((request) => request.id)).toEqual([ids.requestKkp]);
  });
});

describe('transfers', () => {
  it('asks the sending store to approve and dispatch, the receiving store to receive', async () => {
    const owner = await inbox(m.owner);
    expect(group(owner, 'transfer')?.items.map((entry) => [entry.id, entry.step])).toEqual([
      [ids.t1, 'approve_transfer'],
      [ids.t2, 'dispatch_transfer'],
      [ids.t3, 'receive_transfer'],
    ]);
    const amp = await inbox(m.ampManager);
    expect(group(amp, 'transfer')?.items.map((entry) => [entry.id, entry.step])).toEqual([
      [ids.t1, 'approve_transfer'],
      [ids.t3, 'receive_transfer'],
    ]);
    expect(idsOf(await inbox(m.kkpManager), 'transfer')).toEqual([ids.t2]);
    expect(idsOf(await inbox(m.stocker), 'transfer')).toEqual([ids.t1, ids.t3]);
    // A sales executive given inventory:manage acts for their store; one without does not.
    expect(idsOf(await inbox(m.salesStock), 'transfer')).toEqual([ids.t1, ids.t3]);
    expect((await inbox(m.sales)).kinds).not.toContain('transfer');
    expect((await inbox(m.noApprovals)).kinds).not.toContain('transfer');
    expect(item(amp, 'transfer', ids.t1)).toMatchObject({
      reference: expect.stringMatching(/^TR-/),
      title: 'Ameerpet → Kukatpally',
      store: { id: b.stores.amp, name: 'Ameerpet' },
      priority: 'normal',
      link: `/transfers/${ids.t1}`,
      actions: [
        { key: 'approve', endpoint: `/transfers/${ids.t1}/approve`, input: 'none' },
        { key: 'reject', endpoint: `/transfers/${ids.t1}/reject`, input: 'reason' },
      ],
    });
    // Receiving takes quantities: on the transfer's page.
    expect(item(amp, 'transfer', ids.t3)).toMatchObject({
      store: { id: b.stores.amp },
      priority: 'high',
      actions: [],
    });
  });
});

describe('stock counts', () => {
  it('asks someone other than who submitted it, unless they work at every store', async () => {
    expect(new Set(idsOf(await inbox(m.owner), 'stock_count'))).toEqual(
      new Set([ids.countAmp, ids.countKkp]),
    );
    expect(new Set(idsOf(await inbox(m.admin), 'stock_count'))).toEqual(
      new Set([ids.countAmp, ids.countKkp]),
    );
    expect(idsOf(await inbox(m.ampManager), 'stock_count')).toEqual([]);
    expect((await inbox(m.ampManager)).kinds).toContain('stock_count');
    expect(idsOf(await inbox(m.stocker), 'stock_count')).toEqual([ids.countAmp]);
    expect(idsOf(await inbox(m.kkpManager), 'stock_count')).toEqual([ids.countKkp]);
    expect(item(await inbox(m.stocker), 'stock_count', ids.countAmp)).toMatchObject({
      step: 'approve_count',
      reference: null,
      title: expect.stringMatching(/^SC-/),
      requestedBy: 'Staff branch_manager',
      since: expect.any(String),
      store: { id: b.stores.amp, name: 'Ameerpet' },
      link: `/stock-counts/${ids.countAmp}`,
      actions: [],
    });
    // The counts screen's own filter.
    const mine = ok(await api(t, m.ampManager).get('/stock-counts?awaitingMe=true')).json<{
      total: number;
    }>();
    expect(mine.total).toBe(0);
  });
});

describe('escalations', () => {
  it('shows broken promises to those who manage credit, at their customers', async () => {
    expect(new Set(idsOf(await inbox(m.owner), 'escalation'))).toEqual(
      new Set([ids.escalationAmp, ids.escalationKkp, ids.escalationWide]),
    );
    expect(new Set(idsOf(await inbox(m.ampManager), 'escalation'))).toEqual(
      new Set([ids.escalationAmp, ids.escalationWide]),
    );
    expect(new Set(idsOf(await inbox(m.kkpManager), 'escalation'))).toEqual(
      new Set([ids.escalationKkp, ids.escalationWide]),
    );
    expect(new Set(idsOf(await inbox(m.sales), 'escalation'))).toEqual(
      new Set([ids.escalationAmp, ids.escalationWide]),
    );
    expect((await inbox(m.stocker)).kinds).not.toContain('escalation');
    expect(item(await inbox(m.owner), 'escalation', ids.escalationKkp)).toMatchObject({
      step: 'acknowledge_escalation',
      title: 'Kukatpally Traders',
      store: { id: b.stores.kkp, name: 'Kukatpally' },
      amountPaise: 100_000,
      due: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      priority: 'high',
      link: `/parties/${kkpParty}`,
      actions: [
        {
          key: 'acknowledge',
          endpoint: `/collections/escalations/${ids.escalationKkp}/acknowledge`,
          input: 'note',
        },
      ],
    });
  });
});

describe('follow-ups', () => {
  it("lists the member's own overdue and today's follow-ups", async () => {
    const sales = await inbox(m.sales);
    expect(group(sales, 'follow_up')?.items.map((entry) => [entry.id, entry.step])).toEqual([
      [ids.overdue, 'follow_up_overdue'],
      [ids.today, 'follow_up_today'],
    ]);
    expect(item(sales, 'follow_up', ids.overdue)).toMatchObject({
      title: 'Call about the shade card',
      reference: 'Suresh',
      store: null,
      due: expect.any(String),
      priority: 'high',
      link: `/parties/${b.parties.homeowner}`,
      actions: [
        { key: 'complete', endpoint: `/activities/${ids.overdue}/complete`, input: 'note' },
      ],
    });
    expect(item(sales, 'follow_up', ids.today).priority).toBe('normal');
    // A store employee cannot change a customer's activities: no inline "done".
    const cashier = await inbox(m.cashier);
    expect(cashier.kinds).toEqual(['follow_up']);
    expect(item(cashier, 'follow_up', ids.cashierToday).actions).toEqual([]);
    expect(idsOf(await inbox(m.owner), 'follow_up')).toEqual([]);
  });
});

describe('low stock', () => {
  it('goes to who manages stock or buys, at their stores', async () => {
    const lowAt = async (token: string) =>
      (group(await inbox(token), 'low_stock')?.items ?? []).map((entry) => entry.id);
    const ampApex = `${b.stores.amp}:${b.apex}`;
    const ampPrimer = `${b.stores.amp}:${primer}`;
    const kkpApex = `${b.stores.kkp}:${b.apex}`;
    // The emptiest shelves first.
    expect(await lowAt(m.owner)).toEqual([ampPrimer, ampApex, kkpApex]);
    expect(await lowAt(m.ampManager)).toEqual([ampPrimer, ampApex]);
    expect(await lowAt(m.kkpManager)).toEqual([kkpApex]);
    expect(await lowAt(m.stocker)).toEqual([ampPrimer, ampApex]);
    expect(await lowAt(m.salesStock)).toEqual([ampPrimer, ampApex]);
    // purchasing:manage alone is enough; inventory:read alone is not.
    expect(await lowAt(m.buyer)).toEqual([ampPrimer, ampApex]);
    expect((await inbox(m.sales)).kinds).not.toContain('low_stock');
    expect((await inbox(m.noApprovals)).kinds).not.toContain('low_stock');
    const owner = await inbox(m.owner);
    expect(item(owner, 'low_stock', ampApex)).toMatchObject({
      step: 'below_minimum',
      reference: 'APX-1L',
      title: 'Asian Paints Apex Ultima 1 l',
      store: { id: b.stores.amp, name: 'Ameerpet' },
      since: null,
      quantity: { reorderLevel: 30_000, suggested: expect.any(Number), unit: 'l' },
      priority: 'normal',
      link: `/stock/low?store=${b.stores.amp}`,
      actions: [],
    });
    expect(item(owner, 'low_stock', ampPrimer)).toMatchObject({
      step: 'out_of_stock',
      priority: 'high',
      quantity: { available: 0, reorderLevel: 5, suggested: 40_000 },
    });
    expect(item(owner, 'low_stock', kkpApex)).toMatchObject({ step: 'reorder', priority: 'low' });
  });
});

describe('the whole inbox', () => {
  it('lists the kinds a member can be asked about, and counts every item', async () => {
    const owner = await inbox(m.owner);
    expect(owner.kinds).toEqual([
      'credit_approval',
      'credit_request',
      'transfer',
      'stock_count',
      'escalation',
      'follow_up',
      'low_stock',
    ]);
    // Only the groups with something in them, in order.
    expect(owner.groups.map((entry) => entry.kind)).toEqual([
      'credit_approval',
      'credit_request',
      'transfer',
      'stock_count',
      'escalation',
      'low_stock',
    ]);
    expect(owner.total).toBe(owner.groups.reduce((sum, entry) => sum + entry.total, 0));
    for (const token of [m.owner, m.ampManager, m.sales, m.cashier, m.stocker]) {
      expect(await count(token)).toBe((await inbox(token)).total);
    }
    expect((await inbox(m.sales)).kinds).toEqual(['escalation', 'follow_up']);
  });

  it('filters by kind and by store', async () => {
    const transfers = await inbox(m.owner, '?kind=transfer');
    expect(transfers.groups.map((entry) => entry.kind)).toEqual(['transfer']);
    expect(transfers.total).toBe(3);
    // Kukatpally: its transfer to dispatch, its count, its customers' items, its low stock.
    const kkp = await inbox(m.owner, `?storeId=${b.stores.kkp}`);
    expect(idsOf(kkp, 'transfer')).toEqual([ids.t2]);
    expect(idsOf(kkp, 'credit_request')).toEqual([ids.requestKkp]);
    expect(idsOf(kkp, 'credit_approval')).toEqual([ids.kkpSale]);
    expect(idsOf(kkp, 'stock_count')).toEqual([ids.countKkp]);
    expect(idsOf(kkp, 'escalation')).toEqual([ids.escalationKkp]);
    expect(group(kkp, 'low_stock')?.total).toBe(1);
    // Not a store the member works at.
    const elsewhere = await api(t, m.ampManager).get(`/inbox?storeId=${b.stores.kkp}`);
    expect(elsewhere.statusCode).toBe(404);
    expect((await api(t, m.owner).get('/inbox?kind=nothing')).statusCode).toBe(400);
  });

  it('needs a session', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/inbox/count' })).statusCode).toBe(401);
  });
});

describe('acting from the inbox', () => {
  it("takes an item off everyone's inbox once it is done through its endpoint", async () => {
    const before = await count(m.owner);
    const managerBefore = await count(m.ampManager);
    // The owner approves the sales executive's sale.
    const approve = item(await inbox(m.owner), 'credit_approval', ids.saleBySales).actions[0];
    ok(await api(t, m.owner).post(String(approve?.endpoint), {}));
    expect(idsOf(await inbox(m.owner), 'credit_approval')).not.toContain(ids.saleBySales);
    expect(idsOf(await inbox(m.ampManager), 'credit_approval')).toEqual([]);
    expect(await count(m.owner)).toBe(before - 1);
    expect(await count(m.ampManager)).toBe(managerBefore - 1);

    // The branch manager approves the transfer: next, Ameerpet dispatches it.
    const transfer = item(await inbox(m.ampManager), 'transfer', ids.t1).actions[0];
    ok(await api(t, m.ampManager).post(String(transfer?.endpoint), {}));
    expect(item(await inbox(m.ampManager), 'transfer', ids.t1).step).toBe('dispatch_transfer');

    // The sales executive acknowledges an escalation and marks a follow-up done.
    const acknowledge = item(await inbox(m.sales), 'escalation', ids.escalationAmp).actions[0];
    expect((await api(t, m.sales).post(String(acknowledge?.endpoint), {})).statusCode).toBe(204);
    const done = item(await inbox(m.sales), 'follow_up', ids.overdue).actions[0];
    ok(await api(t, m.sales).post(String(done?.endpoint), {}));
    const sales = await inbox(m.sales);
    expect(idsOf(sales, 'escalation')).toEqual([ids.escalationWide]);
    expect(idsOf(sales, 'follow_up')).toEqual([ids.today]);
  });
});
