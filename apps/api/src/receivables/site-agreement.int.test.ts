import { migrateDatabase, schema } from '@paint/db';
import {
  AGEING_BUCKETS,
  ageingBucket,
  type AgeingBucket,
  type AgeingPage,
  type IssuedInvoiceView,
  type PartyLedgerView,
  type PaymentView,
  type SiteAccountDetail,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

/**
 * Spec §2.3: a site account (round 1a) computes its own ageing from the documents
 * booked to its project; the receivables ageing (round 1b) takes the same project as
 * a filter. Both must agree, and the sites plus what is booked to no site must make
 * up the party's ageing. Checked over random books: invoices on two sites and on
 * none, payments set against any of them, credit notes, same-day cancellations,
 * bounced cheques with their charges, and an opening balance.
 */

const { creditProfiles } = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;

const owner = () => api(t, b.owner);
const get = async <T>(url: string) => ok(await owner().get(url)).json<T>();
const post = async <T>(url: string, body: object = {}) =>
  ok(await owner().post(url, body)).json<T>();

/** A small deterministic generator (mulberry32), so a failure always reproduces. */
function random(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) % below;
  };
}

/** The list's item at `index`, which the books always have. */
function item<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`No item ${String(index)}`);
  return found;
}

const SEEDS = [1, 2, 3, 4, 5, 6];
const SITES_PER_PARTY = 2;

interface Book {
  readonly seed: number;
  readonly partyId: string;
  readonly siteIds: string[];
  readonly projectIds: string[];
  /** Invoices by site index (−1: booked to no site). */
  readonly invoices: { invoice: IssuedInvoiceView; site: number; cancelled: boolean }[];
  /** The opening balance's due date (it is never a site's). */
  readonly openingDueOn: string;
}

const books: Book[] = [];
/** What the random books did, so a test can check every kind of event happened. */
const played = new Map<string, number>();
const note = (event: string) => played.set(event, (played.get(event) ?? 0) + 1);

const days = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const zero = () =>
  Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, 0])) as Record<AgeingBucket, number>;

/** Plays one random book for a new contractor with two site accounts. */
async function play(seed: number, partyId: string): Promise<Book> {
  const roll = random(seed);
  const projectIds: string[] = [];
  const siteIds: string[] = [];
  for (let site = 0; site < SITES_PER_PARTY; site += 1) {
    const project = await post<{ id: string }>('/projects', {
      storeId: b.stores.amp,
      customerPartyId: partyId,
      name: `Site ${String(site + 1)} of book ${String(seed)}`,
    });
    projectIds.push(project.id);
    siteIds.push(
      (
        await post<{ id: string }>(`/parties/${partyId}/sites`, {
          projectId: project.id,
          limitPaise: 10_000_000,
        })
      ).id,
    );
  }
  const invoices: Book['invoices'] = [];
  const credited = new Set<string>();
  const open = async () =>
    (await get<PartyLedgerView>(`/parties/${partyId}/ledger`)).openDocuments.filter(
      (document) => document.documentId !== null,
    );
  for (let step = 0; step < 14; step += 1) {
    const event = roll(10);
    if (event <= 4 || invoices.length === 0) {
      const site = roll(SITES_PER_PARTY + 1) - 1;
      const dueOn = await dbToday(t, 20 - roll(130));
      const draft = await b.draft({
        partyId,
        dueOn,
        ...(site < 0 ? {} : { projectId: projectIds[site] }),
        lines: [{ variantId: b.apex, quantity: 1 + roll(6) }],
      });
      invoices.push({
        invoice: await post<IssuedInvoiceView>(`/invoices/${draft.id}/issue`),
        site,
        cancelled: false,
      });
      note(site < 0 ? 'invoice on no site' : 'invoice on a site');
    } else if (event <= 6) {
      // A payment set against one bill (of any site), or left as an advance.
      const documents = await open();
      const target = documents[roll(documents.length + 1)];
      const amountPaise = 1_000 + roll(30_000);
      note(target === undefined ? 'advance' : 'payment');
      await post<PaymentView>('/payments', {
        storeId: b.stores.amp,
        partyId,
        modeId: b.modes.upi.id,
        amountPaise,
        receivedOn: await dbToday(t, -roll(10)),
        ...(target === undefined
          ? {}
          : {
              allocations: [
                {
                  documentId: target.documentId,
                  amountPaise: Math.min(amountPaise, target.outstandingPaise),
                },
              ],
            }),
      });
    } else if (event === 7) {
      const { invoice, cancelled } = item(invoices, roll(invoices.length));
      if (!cancelled && !credited.has(invoice.id)) {
        credited.add(invoice.id);
        await post('/credit-notes', {
          invoiceId: invoice.id,
          reason: 'overcharge',
          lines: invoice.lines
            .slice(0, 1)
            .map((line) => ({ invoiceLineId: line.id, valuePaise: 100 + roll(1_000) })),
        });
        note('credit note');
      }
    } else if (event === 8) {
      // A same-day cancellation of a bill nothing was set against.
      const documents = await open();
      const unpaid = invoices.filter(
        (entry) =>
          !entry.cancelled &&
          !credited.has(entry.invoice.id) &&
          documents.some(
            (document) => document.documentId === entry.invoice.id && document.allocatedPaise === 0,
          ),
      );
      const chosen = unpaid[roll(unpaid.length + 1)];
      if (chosen !== undefined) {
        await post(`/invoices/${chosen.invoice.id}/cancel`, { reason: 'Billed to the wrong site' });
        chosen.cancelled = true;
        note('cancellation');
      }
    } else {
      // A cheque set against a bill, which bounces with a charge.
      const documents = await open();
      const target = documents[roll(documents.length)];
      if (target !== undefined) {
        const amountPaise = Math.min(target.outstandingPaise, 500 + roll(20_000));
        const cheque = await post<PaymentView>('/payments', {
          storeId: b.stores.amp,
          partyId,
          modeId: b.modes.cheque.id,
          amountPaise,
          reference: String(100_000 + seed * 100 + step),
          chequeDate: await dbToday(t, -3),
          receivedOn: await dbToday(t, -3),
          allocations: [{ documentId: target.documentId, amountPaise }],
        });
        await post(`/payments/${cheque.id}/bounce`, {
          reason: 'Insufficient funds',
          bouncedOn: await dbToday(t, -1),
          chargePaise: 25_000,
        });
        note('bounced cheque');
      }
    }
  }
  return {
    seed,
    partyId,
    siteIds,
    projectIds,
    invoices,
    openingDueOn: await dbToday(t, -(40 + seed * 11)),
  };
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  /** Each book's contractor, by seed. */
  const partyIds = new Map<number, string>();
  for (const seed of SEEDS) {
    const party = await post<{ id: string }>('/parties', {
      displayName: `Book ${String(seed)} Constructions`,
      phone: uniquePhone(),
      roles: ['customer', 'contractor'],
    });
    partyIds.set(seed, party.id);
    await t.connection.db.insert(creditProfiles).values({
      organizationId: b.organizationId,
      partyId: party.id,
      status: 'active',
      limitPaise: 50_000_000,
      creditDays: 30,
      // Random books carry bills long overdue; waive the block so they can still be billed.
      overdueWaivedUntil: await dbToday(t, 365),
    });
  }
  // Go-live 60 days ago, each party owing an opening balance overdue since its own day.
  await post('/sales/go-live', {
    liveOn: await dbToday(t, -60),
    openings: await Promise.all(
      [...partyIds].map(async ([seed, partyId]) => ({
        partyId,
        amountPaise: 150_000,
        overdueSince: await dbToday(t, -(40 + seed * 11)),
      })),
    ),
  });
  for (const [seed, partyId] of partyIds) books.push(await play(seed, partyId));
}, 300_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const ageingRow = async (partyId: string, query = '') => {
  const page = await get<AgeingPage>(`/receivables/ageing?limit=500${query}`);
  return page.rows.find((row) => row.id === partyId);
};

describe('a site account agrees with the receivables ageing (spec §2.3)', () => {
  it('plays books with every kind of event', () => {
    expect([...played.keys()].sort()).toEqual([
      'advance',
      'bounced cheque',
      'cancellation',
      'credit note',
      'invoice on a site',
      'invoice on no site',
      'payment',
    ]);
  });

  it('ages each site the same way, bill for bill, over random books', async () => {
    let compared = 0;
    for (const book of books) {
      for (const [index, siteId] of book.siteIds.entries()) {
        const site = await get<SiteAccountDetail>(`/site-accounts/${siteId}`);
        const row = await ageingRow(book.partyId, `&projectId=${String(book.projectIds[index])}`);
        const buckets = row?.totals.buckets ?? zero();
        expect({ seed: book.seed, site: index, buckets }).toEqual({
          seed: book.seed,
          site: index,
          buckets: site.ageing,
        });
        expect(row?.totals.outstandingPaise ?? 0).toBe(site.outstandingPaise);
        // Advances are not site money: a site has nothing paid ahead.
        expect(row?.totals.unappliedPaise ?? 0).toBe(0);
        expect(site.openDocuments.reduce((sum, d) => sum + d.outstandingPaise, 0)).toBe(
          site.outstandingPaise,
        );
        if (site.outstandingPaise > 0) compared += 1;
      }
    }
    // The books leave something owed on most sites, so the comparison is not empty.
    expect(compared).toBeGreaterThan(SEEDS.length);
  });

  it('makes up the party: Σ sites + bills on no site = the party’s ageing, and its balance', async () => {
    for (const book of books) {
      const party = await ageingRow(book.partyId);
      const ledger = await get<PartyLedgerView>(`/parties/${book.partyId}/ledger`);
      // What is booked to no site, from the 2.0 ledger's open documents, aged here.
      const siteBills = new Set(
        book.invoices.filter((entry) => entry.site >= 0).map((entry) => entry.invoice.id),
      );
      const expected = zero();
      for (const document of ledger.openDocuments) {
        if (document.documentId !== null && siteBills.has(document.documentId)) continue;
        const due =
          document.kind === 'opening' ? book.openingDueOn : (document.dueOn ?? document.issuedOn);
        expected[ageingBucket(days(due, today))] += document.outstandingPaise;
      }
      for (const siteId of book.siteIds) {
        const site = await get<SiteAccountDetail>(`/site-accounts/${siteId}`);
        for (const bucket of AGEING_BUCKETS) expected[bucket] += site.ageing[bucket];
      }
      expect({ seed: book.seed, buckets: party?.totals.buckets }).toEqual({
        seed: book.seed,
        buckets: expected,
      });
      expect(party?.totals.netPaise).toBe(ledger.balancePaise);
    }
  });

  it('leaves openings, charges and money paid ahead out of a site', async () => {
    const [book] = books as [Book];
    const page = await get<AgeingPage>(
      `/receivables/ageing?limit=500&projectId=${String(book.projectIds[0])}`,
    );
    // Only the parties with bills on this project: this book's contractor.
    expect(page.rows.every((row) => row.id === book.partyId)).toBe(true);
    expect(page.totals.unappliedPaise).toBe(0);
    // An unknown project has nothing at all.
    const none = await get<AgeingPage>(
      `/receivables/ageing?projectId=00000000-0000-4000-8000-000000000000`,
    );
    expect(none).toMatchObject({ rows: [], total: 0 });
  });
});
