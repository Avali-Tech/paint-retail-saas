import { randomUUID } from 'node:crypto';
import { schema, type TenantTransaction } from '@paint/db';
import {
  defaultSeries,
  financialYear,
  formatDocumentNumber,
  formatINR,
  formatTaxDocumentNumber,
} from '@paint/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { PgInsertValue, PgTable } from 'drizzle-orm/pg-core';
import { dayOpensAt, indiaDate } from './history-clock.js';
import type { LargeScale } from './large-plan.js';
import type { Random } from './random.js';
import { must } from './seed-context.js';

const {
  activities,
  allocations,
  collectionEscalations,
  creditProfiles,
  documentSequences,
  documentSeries,
  partyBalances,
  partyLedger,
  payments,
  promisesToPay,
  siteCreditAccounts,
  stores: storesTable,
  taxDocuments,
} = schema;

/**
 * A large shop's receivables (MVP 3 scale): credit customers with opening balances
 * from the old books, invoices on account (some booked to a site), payments set
 * against the oldest bills first, holds, site accounts and promises to pay. Written
 * in bulk like the rest of the large shop (seed-large.ts), and kept exactly as the
 * API keeps them: every balance is the sum of its ledger, every advance the money
 * not yet allocated, and no allocation exceeds either of its ends.
 */
export type ReceivablesScale = Pick<LargeScale, 'creditCustomers' | 'invoicesPerCustomer'>;

export interface ReceivablesStore {
  readonly id: string;
  /** Who bills and takes payments there. */
  readonly memberId: string;
}

export interface ReceivablesCustomer {
  readonly id: string;
  readonly name: string;
  /** Index into the stores; null for a business-wide party (billed at the first store). */
  readonly store: number | null;
  /** Projects the party is the customer of, for site accounts. */
  readonly projectIds: readonly string[];
}

export interface ReceivablesInput {
  readonly organizationId: string;
  readonly stores: readonly ReceivablesStore[];
  readonly customers: readonly ReceivablesCustomer[];
  /** Payment modes money comes in by. */
  readonly modes: readonly { readonly id: string; readonly kind: 'bank_transfer' | 'upi' }[];
  /** How many days back billing went live, and how far back bills go (at most that). */
  readonly liveDaysAgo: number;
  readonly now: Date;
}

/** One bill or opening balance as it is planned, with what is still owed on it. */
interface Owed {
  readonly documentId: string | null;
  readonly ledgerId: string | null;
  readonly due: number;
  left: number;
}

/** Rows as planned: plain values (no SQL), as the tests read them back. */
type Rows<T extends PgTable> = T['$inferInsert'][];

/** Everything to write, in an order the database's rules accept. */
export interface ReceivablesPlan {
  readonly creditProfiles: Rows<typeof creditProfiles>;
  /** Invoices without their numbers, which writeReceivables takes from each store's series. */
  readonly invoices: (Omit<
    (typeof taxDocuments)['$inferInsert'],
    'number' | 'fy' | 'seriesId' | 'issuedOn'
  > & {
    readonly store: number;
    readonly issuedOn: string;
  })[];
  readonly ledger: Rows<typeof partyLedger>;
  /** Payments without their receipt numbers (writeReceivables numbers them). */
  readonly payments: Omit<(typeof payments)['$inferInsert'], 'number'>[];
  readonly balances: Rows<typeof partyBalances>;
  readonly allocations: Rows<typeof allocations>;
  readonly sites: Rows<typeof siteCreditAccounts>;
  readonly activities: Rows<typeof activities>;
  readonly promises: Rows<typeof promisesToPay>;
  readonly escalations: Rows<typeof collectionEscalations>;
}

const HOUR = 3_600_000;

/**
 * Plans the receivables of `scale.creditCustomers` customers: a pure function of
 * the random source, so the same seed gives the same books.
 */
export function planReceivables(
  random: Random,
  input: ReceivablesInput,
  scale: ReceivablesScale,
): ReceivablesPlan {
  const { organizationId, now } = input;
  const at = (daysAgo: number) =>
    new Date(dayOpensAt(daysAgo, now).getTime() + random.next() * 9 * HOUR);
  const plan: ReceivablesPlan = {
    creditProfiles: [],
    invoices: [],
    ledger: [],
    payments: [],
    balances: [],
    allocations: [],
    sites: [],
    activities: [],
    promises: [],
    escalations: [],
  };
  const customers = input.customers.slice(0, scale.creditCustomers);
  let late = 0;
  let promised = 0;
  for (const customer of customers) {
    const storeIndex = customer.store ?? 0;
    const store = must(input.stores[storeIndex], 'store');
    const creditDays = random.pick([15, 30, 30, 45, 60]);
    const limitPaise = random.int(1, 20) * 50_000_00;
    let balance = 0;
    const owed: Owed[] = [];
    /** Payments with money not yet set against a bill (the advance), oldest first. */
    const unallocated: { id: string; left: number }[] = [];
    // An opening balance from the old books for a third of them, some long overdue.
    const opening = random.chance(0.35) ? random.int(5, 200) * 1000_00 : 0;
    const overdueSince = opening > 0 && random.chance(0.6) ? random.int(0, 150) : null;
    if (opening > 0) {
      const id = randomUUID();
      plan.ledger.push({
        id,
        organizationId,
        partyId: customer.id,
        entryOn: indiaDate(input.liveDaysAgo, now),
        entryType: 'opening',
        amountPaise: opening,
        referenceType: 'go_live',
        referenceId: customer.id,
        note: 'Opening balance at go-live',
        createdByMemberId: store.memberId,
        createdAt: at(input.liveDaysAgo),
      });
      balance += opening;
      owed.push({
        documentId: null,
        ledgerId: id,
        due: input.liveDaysAgo + (overdueSince ?? 0),
        left: opening,
      });
    }
    // A site account on the first of its projects, for some, taking part of its bills.
    const projectId =
      customer.projectIds.length > 0 && random.chance(0.5) ? customer.projectIds[0] : undefined;
    if (projectId !== undefined) {
      plan.sites.push({
        organizationId,
        partyId: customer.id,
        projectId,
        limitPaise: Math.max(50_000_00, Math.floor(limitPaise / 2)),
        status: 'active',
        notes: 'Site account',
        createdByMemberId: store.memberId,
        createdAt: at(input.liveDaysAgo - 1),
      });
    }

    // Bills and payments day by day, oldest first; payments clear the oldest bills first.
    // One in four has paid nothing since going live: its oldest bills are long overdue.
    const bills = random.int(1, 2 * scale.invoicesPerCustomer - 1);
    const days = Array.from({ length: bills }, () => random.int(1, input.liveDaysAgo - 1)).sort(
      (a, b) => b - a,
    );
    const pays = random.chance(0.75);
    const events = days.flatMap((day) =>
      pays && random.chance(0.55)
        ? [
            { day, bill: true },
            { day: Math.max(1, day - random.int(3, 25)), bill: false },
          ]
        : [{ day, bill: true }],
    );
    events.sort((a, b) => b.day - a.day || Number(b.bill) - Number(a.bill));
    for (const event of events) {
      const when = at(event.day);
      if (event.bill) {
        const total = random.int(20, 900) * 100_00;
        // Prices include GST at 18%: tax split evenly between CGST and SGST.
        let taxable = Math.round((total * 100) / 118);
        if ((total - taxable) % 2 !== 0) taxable += 1;
        const id = randomUUID();
        const onSite = projectId !== undefined && random.chance(0.4);
        plan.invoices.push({
          id,
          organizationId,
          store: storeIndex,
          kind: 'invoice',
          status: 'issued',
          storeId: store.id,
          issuedOn: indiaDate(event.day, now),
          issuedAt: when,
          supplierStateCode: '36',
          partyId: customer.id,
          buyerName: customer.name,
          buyerStateCode: '36',
          placeOfSupplyCode: '36',
          supplyType: 'intra_state',
          gstClass: 'b2cs',
          taxablePaise: taxable,
          cgstPaise: (total - taxable) / 2,
          sgstPaise: (total - taxable) / 2,
          totalPaise: total,
          dueOn: indiaDate(event.day - creditDays, now),
          projectId: onSite ? projectId : null,
          createdByMemberId: store.memberId,
          issuedByMemberId: store.memberId,
          createdAt: when,
          updatedAt: when,
        });
        plan.ledger.push({
          organizationId,
          partyId: customer.id,
          storeId: store.id,
          entryOn: indiaDate(event.day, now),
          entryType: 'invoice',
          amountPaise: total,
          referenceType: 'tax_document',
          referenceId: id,
          createdByMemberId: store.memberId,
          createdAt: when,
        });
        balance += total;
        owed.push({ documentId: id, ledgerId: null, due: event.day - creditDays, left: total });
        // An advance is used on the next bill, as issuing an invoice does.
        const bill = must(owed.at(-1), 'bill');
        for (const source of unallocated) {
          const amount = Math.min(source.left, bill.left);
          if (amount === 0) continue;
          plan.allocations.push({
            organizationId,
            partyId: customer.id,
            paymentId: source.id,
            documentId: id,
            amountPaise: amount,
            createdByMemberId: store.memberId,
            createdAt: when,
          });
          bill.left -= amount;
          source.left -= amount;
        }
        continue;
      }
      const due = owed.reduce((sum, item) => sum + item.left, 0);
      if (due === 0) continue;
      // Part of what is owed, now and then a little more (an advance).
      const amount = Math.max(100_00, Math.round((due * random.int(30, 110)) / 100 / 100) * 100);
      const id = randomUUID();
      const mode = random.pick(input.modes);
      plan.payments.push({
        id,
        organizationId,
        storeId: store.id,
        direction: 'in',
        partyId: customer.id,
        modeId: mode.id,
        modeKind: mode.kind,
        amountPaise: amount,
        receivedOn: indiaDate(event.day, now),
        reference: `NEFT${random.digits(10)}`,
        createdByMemberId: store.memberId,
        createdAt: when,
      });
      plan.ledger.push({
        organizationId,
        partyId: customer.id,
        storeId: store.id,
        entryOn: indiaDate(event.day, now),
        entryType: 'payment_in',
        amountPaise: -amount,
        referenceType: 'payment',
        referenceId: id,
        createdByMemberId: store.memberId,
        createdAt: when,
      });
      balance -= amount;
      let left = amount;
      for (const item of [...owed].sort((a, b) => b.due - a.due)) {
        if (left === 0) break;
        const take = Math.min(left, item.left);
        if (take === 0) continue;
        plan.allocations.push({
          organizationId,
          partyId: customer.id,
          paymentId: id,
          documentId: item.documentId,
          partyLedgerId: item.ledgerId,
          amountPaise: take,
          createdByMemberId: store.memberId,
          createdAt: when,
        });
        item.left -= take;
        left -= take;
      }
      unallocated.push({ id, left });
    }

    // Holds: a few by hand, and every account more than 30 days overdue by the nightly
    // job (the default rules), as the job would have done.
    const oldestDue = Math.max(0, ...owed.filter((item) => item.left > 0).map((item) => item.due));
    const hold = random.chance(0.04)
      ? ('manual' as const)
      : oldestDue > 30
        ? ('auto' as const)
        : null;
    plan.creditProfiles.push({
      organizationId,
      partyId: customer.id,
      status: hold === null ? 'active' : 'on_hold',
      limitPaise,
      creditDays,
      risk: hold === null ? 'low' : 'high',
      openingOverdueSince:
        overdueSince === null ? null : indiaDate(input.liveDaysAgo + overdueSince, now),
      holdKind: hold,
      holdReason:
        hold === null
          ? null
          : hold === 'manual'
            ? 'Cheque returned unpaid'
            : `Overdue ${String(oldestDue)} days (automatic)`,
      heldAt: hold === null ? null : at(1),
      heldByMemberId: hold === 'manual' ? store.memberId : null,
      approvedByMemberId: store.memberId,
      approvedAt: at(input.liveDaysAgo),
    });
    plan.balances.push({
      organizationId,
      partyId: customer.id,
      balancePaise: balance,
      advancePaise: unallocated.reduce((sum, source) => sum + source.left, 0),
    });

    // Promises to pay from one in six who are late: two in three still open, the
    // others broken and escalated.
    if (oldestDue > 0 && balance > 1000_00 && late++ % 6 === 0) {
      const broken = promised++ % 3 === 0;
      const madeDaysAgo = broken ? random.int(8, 20) : random.int(0, 5);
      const promisedDaysAgo = broken ? madeDaysAgo - random.int(2, 6) : -random.int(2, 10);
      const amountPaise = Math.max(1000_00, Math.floor(balance / 2 / 1000_00) * 1000_00);
      const activityId = randomUUID();
      const promiseId = randomUUID();
      const made = at(madeDaysAgo);
      plan.activities.push({
        id: activityId,
        organizationId,
        recordType: 'party',
        recordId: customer.id,
        storeId: store.id,
        type: 'promise_to_pay',
        subject: `Promised ${formatINR(amountPaise)} by ${indiaDate(promisedDaysAgo, now)}`,
        completedAt: made,
        assignedMemberId: store.memberId,
        createdByMemberId: store.memberId,
        createdAt: made,
        updatedAt: made,
      });
      plan.promises.push({
        id: promiseId,
        organizationId,
        partyId: customer.id,
        amountPaise,
        madeOn: indiaDate(madeDaysAgo, now),
        promisedOn: indiaDate(promisedDaysAgo, now),
        status: broken ? 'broken' : 'open',
        activityId,
        paidPaise: broken ? 0 : null,
        closedAt: broken ? at(promisedDaysAgo - 1) : null,
        createdByMemberId: store.memberId,
        createdAt: made,
      });
      if (broken) {
        plan.escalations.push({
          organizationId,
          partyId: customer.id,
          promiseId,
          raisedOn: indiaDate(promisedDaysAgo - 1, now),
          notifiedCount: 2,
          createdAt: at(promisedDaysAgo - 1),
        });
      }
    }
  }
  return plan;
}

/** Rows per INSERT: inside PostgreSQL's 65,535 parameters for the widest table here. */
const CHUNK = 1_000;

async function insertAll<T extends PgTable>(
  tx: TenantTransaction,
  table: T,
  rows: readonly PgInsertValue<T>[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += CHUNK) {
    await tx.insert(table).values(rows.slice(start, start + CHUNK));
  }
}

/**
 * Writes a plan in the business's tenant transaction (row-level security and the
 * audit and allocation triggers apply): invoices numbered on from each store's
 * invoice series, payments from the receipt series, both saved back so the API's
 * next numbers follow on.
 */
export async function writeReceivables(
  tx: TenantTransaction,
  organizationId: string,
  plan: ReceivablesPlan,
): Promise<void> {
  const storeRows = await tx
    .select({ id: storesTable.id, code: storesTable.code, gstin: storesTable.gstin })
    .from(storesTable);
  const counters = new Map<string, number>();
  const next = async (key: string) => {
    if (!counters.has(key)) {
      const [row] = await tx
        .select({ value: documentSequences.lastValue })
        .from(documentSequences)
        .where(
          and(
            eq(documentSequences.organizationId, organizationId),
            eq(documentSequences.series, key),
          ),
        );
      counters.set(key, row?.value ?? 0);
    }
    const value = Number(counters.get(key)) + 1;
    counters.set(key, value);
    return value;
  };
  const seriesOf = new Map<string, { id: string; prefix: string; digits: number }>();
  const series = async (storeId: string, code: string) => {
    const known = seriesOf.get(storeId);
    if (known !== undefined) return known;
    const [existing] = await tx
      .select({
        id: documentSeries.id,
        prefix: documentSeries.prefix,
        digits: documentSeries.digits,
      })
      .from(documentSeries)
      .where(
        and(
          eq(documentSeries.storeId, storeId),
          eq(documentSeries.kind, 'invoice'),
          eq(documentSeries.isActive, true),
        ),
      );
    const found =
      existing ??
      must(
        (
          await tx
            .insert(documentSeries)
            .values({
              organizationId,
              storeId,
              kind: 'invoice',
              ...must(defaultSeries(code, 'invoice'), `invoice series for ${code}`),
            })
            .returning({
              id: documentSeries.id,
              prefix: documentSeries.prefix,
              digits: documentSeries.digits,
            })
        )[0],
        'invoice series',
      );
    seriesOf.set(storeId, found);
    return found;
  };

  const invoices: PgInsertValue<typeof taxDocuments>[] = [];
  for (const { store: _store, ...invoice } of plan.invoices) {
    const store = must(
      storeRows.find((row) => row.id === invoice.storeId),
      'store',
    );
    const gstin = must(store.gstin, `GSTIN of ${store.code}`);
    const { id, prefix, digits } = await series(store.id, store.code);
    const fy = financialYear(invoice.issuedOn);
    const serial = await next(`tax:invoice:${gstin}:${fy}:${prefix}`);
    invoices.push({
      ...invoice,
      seriesId: id,
      fy,
      number: formatTaxDocumentNumber(prefix, fy, serial, digits),
      supplierGstin: gstin,
    });
  }
  const receipts: PgInsertValue<typeof payments>[] = [];
  for (const payment of plan.payments) {
    receipts.push({
      ...payment,
      number: formatDocumentNumber('RC', await next('payment_receipt')),
    });
  }

  await insertAll(tx, creditProfiles, plan.creditProfiles);
  await insertAll(tx, taxDocuments, invoices);
  await insertAll(tx, payments, receipts);
  await insertAll(tx, partyLedger, plan.ledger);
  // Balances before allocations: the allocation rule locks the party's balance row.
  await insertAll(tx, partyBalances, plan.balances);
  await insertAll(tx, allocations, plan.allocations);
  await insertAll(tx, siteCreditAccounts, plan.sites);
  await insertAll(tx, activities, plan.activities);
  await insertAll(tx, promisesToPay, plan.promises);
  await insertAll(tx, collectionEscalations, plan.escalations);
  for (const [series, lastValue] of counters) {
    await tx
      .insert(documentSequences)
      .values({ organizationId, series, lastValue })
      .onConflictDoUpdate({
        target: [documentSequences.organizationId, documentSequences.series],
        set: { lastValue: sql`excluded.last_value` },
      });
  }
}
