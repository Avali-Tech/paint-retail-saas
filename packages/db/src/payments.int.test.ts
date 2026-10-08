import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  adjustPartyAdvance,
  createDatabase,
  findAllocationMismatches,
  findPartyBalanceMismatches,
  migrateDatabase,
  postPartyLedger,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  accountingExports,
  allocations,
  brands,
  documentSeries,
  ledgerMappings,
  organizationMembers,
  organizations,
  parties,
  partyBalances,
  partyLedger,
  paymentModes,
  payments,
  productVariants,
  products,
  registerCashMovements,
  registerSessions,
  roles,
  stores,
  taxDocuments,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

interface Tenant {
  readonly org: string;
  readonly store: string;
  readonly otherStore: string;
  readonly member: string;
  readonly party: string;
  readonly otherParty: string;
  readonly variant: string;
  readonly series: string;
  readonly cash: string;
  readonly cheque: string;
}
let a: Tenant;
let b: Tenant;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

function id(rows: { id: string }[]): string {
  const [row] = rows;
  if (!row) throw new Error('Expected a row');
  return row.id;
}

async function tenant(name: string): Promise<Tenant> {
  const { db } = connection;
  const org = id(await db.insert(organizations).values({ name }).returning());
  const store = id(
    await db
      .insert(stores)
      .values({ organizationId: org, name: 'Ameerpet', code: 'AMP' })
      .returning(),
  );
  const otherStore = id(
    await db
      .insert(stores)
      .values({ organizationId: org, name: 'Kukatpally', code: 'KKP' })
      .returning(),
  );
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'x', name: 'X' }).returning(),
  );
  const user = id(
    await db
      .insert(users)
      .values({ fullName: 'Ravi', email: `ravi-${crypto.randomUUID()}@example.com` })
      .returning(),
  );
  const member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  const party = id(
    await db.insert(parties).values({ organizationId: org, displayName: 'Lakshmi' }).returning(),
  );
  const otherParty = id(
    await db.insert(parties).values({ organizationId: org, displayName: 'Ramesh' }).returning(),
  );
  const brand = id(
    await db.insert(brands).values({ organizationId: org, name: 'Asian' }).returning(),
  );
  const product = id(
    await db
      .insert(products)
      .values({
        organizationId: org,
        brandId: brand,
        name: 'Apex',
        type: 'exterior_paint',
        hsnCode: '32091090',
        gstRateBps: 1800,
      })
      .returning(),
  );
  const variant = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'AP-1L', packSize: 1, unit: 'l' })
      .returning(),
  );
  const series = id(
    await db
      .insert(documentSeries)
      .values({ organizationId: org, storeId: store, kind: 'invoice', prefix: 'AMP', digits: 6 })
      .returning(),
  );
  const cash = id(
    await db
      .insert(paymentModes)
      .values({ organizationId: org, kind: 'cash', name: 'Cash' })
      .returning(),
  );
  const cheque = id(
    await db
      .insert(paymentModes)
      .values({ organizationId: org, kind: 'cheque', name: 'Cheque' })
      .returning(),
  );
  return { org, store, otherStore, member, party, otherParty, variant, series, cash, cheque };
}

let serial = 0;
/** An issued invoice of ₹236.00 to `party`, with its ledger entry, as the API writes it. */
async function invoice(t: Tenant, party = t.party): Promise<string> {
  serial += 1;
  return withTenant(connection.db, t.org, async (tx) => {
    const document = id(
      await tx
        .insert(taxDocuments)
        .values({
          organizationId: t.org,
          kind: 'invoice',
          storeId: t.store,
          partyId: party,
          createdByMemberId: t.member,
        })
        .returning(),
    );
    await tx
      .update(taxDocuments)
      .set({
        status: 'issued',
        seriesId: t.series,
        number: `AMP/26-27/${String(serial).padStart(6, '0')}`,
        fy: '2026-27',
        issuedOn: '2026-10-07',
        issuedAt: sql`now()`,
        supplierGstin: '36AABCS1429B1Z5',
        supplierStateCode: '36',
        issuedByMemberId: t.member,
        supplyType: 'intra_state',
        placeOfSupplyCode: '36',
        gstClass: 'b2cs',
        taxablePaise: 20_000,
        cgstPaise: 1_800,
        sgstPaise: 1_800,
        totalPaise: 23_600,
      })
      .where(eq(taxDocuments.id, document));
    await postPartyLedger(tx, [
      {
        organizationId: t.org,
        partyId: party,
        entryOn: '2026-10-07',
        entryType: 'invoice',
        amountPaise: 23_600,
        referenceType: 'tax_document',
        referenceId: document,
      },
    ]);
    return document;
  });
}

let receipts = 0;
/** Money received from `party`, with its ledger entry, unallocated. */
async function payment(
  t: Tenant,
  amountPaise: number,
  options: { party?: string; cheque?: boolean; session?: string; store?: string } = {},
): Promise<string> {
  receipts += 1;
  const party = options.party ?? t.party;
  return withTenant(connection.db, t.org, async (tx) => {
    const row = id(
      await tx
        .insert(payments)
        .values({
          organizationId: t.org,
          storeId: options.store ?? t.store,
          number: `RC-${String(receipts).padStart(6, '0')}`,
          direction: 'in',
          partyId: party,
          modeId: options.cheque ? t.cheque : t.cash,
          modeKind: options.cheque ? 'cheque' : 'cash',
          amountPaise,
          receivedOn: '2026-10-07',
          reference: options.cheque ? '000123' : null,
          chequeDate: options.cheque ? '2026-10-07' : null,
          chequeStatus: options.cheque ? 'pending' : null,
          registerSessionId: options.session,
          createdByMemberId: t.member,
        })
        .returning(),
    );
    await postPartyLedger(tx, [
      {
        organizationId: t.org,
        partyId: party,
        entryOn: '2026-10-07',
        entryType: 'payment_in',
        amountPaise: -amountPaise,
        referenceType: 'payment',
        referenceId: row,
      },
    ]);
    await adjustPartyAdvance(tx, party, amountPaise);
    return row;
  });
}

/** Allocates part of a payment to a document, as the API does. */
function allocate(t: Tenant, paymentId: string, documentId: string, amountPaise: number) {
  return withTenant(connection.db, t.org, async (tx) => {
    const row = id(
      await tx
        .insert(allocations)
        .values({
          organizationId: t.org,
          partyId: t.party,
          paymentId,
          documentId,
          amountPaise,
          createdByMemberId: t.member,
        })
        .returning(),
    );
    await adjustPartyAdvance(tx, t.party, -amountPaise);
    return row;
  });
}

async function openSession(t: Tenant, code: string, store = t.store): Promise<string> {
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(registerSessions)
        .values({
          organizationId: t.org,
          storeId: store,
          registerCode: code,
          openedByMemberId: t.member,
          openingFloatPaise: 50_000,
        })
        .returning(),
    ),
  );
}

const closeSession = (t: Tenant, session: string) =>
  withTenant(connection.db, t.org, (tx) =>
    tx
      .update(registerSessions)
      .set({
        status: 'closed',
        closedByMemberId: t.member,
        closedAt: sql`now()`,
        expectedCashPaise: 50_000,
        countedCashPaise: 49_000,
        variancePaise: -1_000,
      })
      .where(eq(registerSessions.id, session)),
  );

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  a = await tenant('ABC Paints');
  b = await tenant('XYZ Paints');
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('payments: tenant isolation', () => {
  it("never shows or changes another business's payments, allocations, registers or settings", async () => {
    const document = await invoice(b);
    const paid = await payment(b, 10_000);
    await allocate(b, paid, document, 10_000);
    const session = await openSession(b, 'COUNTER1');
    await withTenant(connection.db, b.org, async (tx) => {
      await tx.insert(registerCashMovements).values({
        organizationId: b.org,
        sessionId: session,
        kind: 'pay_in',
        amountPaise: 100,
        reason: 'Change',
        createdByMemberId: b.member,
      });
      await tx.insert(ledgerMappings).values({
        organizationId: b.org,
        purpose: 'round_off',
        tallyLedgerName: 'Rounding',
      });
      await tx.insert(accountingExports).values({
        organizationId: b.org,
        periodFrom: '2026-10-01',
        periodTo: '2026-10-31',
        kinds: ['sales'],
        format: 'tally_xml',
        createdByMemberId: b.member,
      });
    });

    const seen = await withTenant(connection.db, a.org, async (tx) => ({
      payments: await tx.select().from(payments).where(eq(payments.partyId, b.party)),
      allocations: await tx.select().from(allocations).where(eq(allocations.partyId, b.party)),
      sessions: await tx.select().from(registerSessions).where(eq(registerSessions.id, session)),
      movements: await tx.select().from(registerCashMovements),
      modes: await tx.select().from(paymentModes).where(eq(paymentModes.id, b.cash)),
      mappings: await tx.select().from(ledgerMappings),
      exports: await tx.select().from(accountingExports),
    }));
    expect(seen).toEqual({
      payments: [],
      allocations: [],
      sessions: [],
      movements: [],
      modes: [],
      mappings: [],
      exports: [],
    });

    // Nor can a row point into another business (composite foreign keys).
    const message = await failureMessage(payment(a, 100, { party: b.party }));
    expect(message).toMatch(/payments_party_fk/);
    const allocated = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(allocations).values({
          organizationId: a.org,
          partyId: a.party,
          paymentId: paid,
          documentId: document,
          amountPaise: 1,
        }),
      ),
    );
    expect(allocated).toMatch(/allocations_payment_fk|nothing to allocate/);
  });
});

describe('payments: immutability', () => {
  it('never edits or deletes a payment; a pending cheque clears or bounces once', async () => {
    const cash = await payment(a, 5_000);
    const edit = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx.update(payments).set({ amountPaise: 1 }).where(eq(payments.id, cash)),
      ),
    );
    expect(edit).toMatch(/a payment cannot be changed/);
    const removed = await failureMessage(
      withTenant(connection.db, a.org, (tx) => tx.delete(payments).where(eq(payments.id, cash))),
    );
    expect(removed).toMatch(/permission denied/);
    const ownerDelete = await failureMessage(
      connection.db.delete(payments).where(eq(payments.id, cash)),
    );
    expect(ownerDelete).toMatch(/a payment is never deleted/);

    const cheque = await payment(a, 7_000, { cheque: true });
    const cleared = await withTenant(connection.db, a.org, (tx) =>
      tx
        .update(payments)
        .set({ chequeStatus: 'cleared', chequeClearedOn: '2026-10-08' })
        .where(eq(payments.id, cheque))
        .returning({ status: payments.chequeStatus }),
    );
    expect(cleared).toEqual([{ status: 'cleared' }]);
    const again = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx
          .update(payments)
          .set({
            chequeStatus: 'bounced',
            chequeClearedOn: null,
            chequeBouncedOn: '2026-10-09',
            bounceReason: 'Late',
          })
          .where(eq(payments.id, cheque)),
      ),
    );
    expect(again).toMatch(/a payment cannot be changed/);
    const back = await failureMessage(
      withTenant(connection.db, a.org, async (tx) => {
        const pending = await payment(a, 100, { cheque: true });
        await tx.update(payments).set({ chequeStatus: 'pending' }).where(eq(payments.id, pending));
      }),
    );
    expect(back).toMatch(/a payment cannot be changed/);
  });

  it('keeps a payment complete: its mode kind, cheque details, cash tendered and voucher', async () => {
    const base = {
      organizationId: a.org,
      storeId: a.store,
      direction: 'in' as const,
      partyId: a.party,
      receivedOn: '2026-10-07',
      createdByMemberId: a.member,
    };
    const insert = (values: Partial<typeof payments.$inferInsert>) =>
      failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(payments).values({
            ...base,
            number: 'RC-999999',
            modeId: a.cash,
            modeKind: 'cash',
            amountPaise: 100,
            ...values,
          }),
        ),
      );
    expect(await insert({ modeKind: 'upi' })).toMatch(/payments_mode_fk/);
    expect(await insert({ modeId: a.cheque, modeKind: 'cheque' })).toMatch(/payments_cheque/);
    expect(await insert({ tenderedPaise: 50 })).toMatch(/payments_tendered/);
    expect(await insert({ amountPaise: 0 })).toMatch(/payments_amount_positive/);
    expect(await insert({ number: 'R-1' })).toMatch(/payments_number_format/);
    expect(await insert({ voucherNumber: 'AMPA/26-27/000001' })).toMatch(/payments_voucher/);
  });

  it('takes cash only into an open session at its own store', async () => {
    const session = await openSession(a, 'COUNTER9');
    const other = await openSession(a, 'COUNTER9', a.otherStore);
    expect(await failureMessage(payment(a, 100, { session: other }))).toMatch(
      /payments_register_session_fk/,
    );
    await payment(a, 100, { session });
    await closeSession(a, session);
    expect(await failureMessage(payment(a, 100, { session }))).toMatch(
      /this register session is closed/,
    );
  });
});

describe('allocations', () => {
  it('keeps every bill and payment within its amount, and undoes rows only by reversal', async () => {
    const document = await invoice(a);
    const first = await payment(a, 20_000);
    const second = await payment(a, 23_600);
    const row = await allocate(a, first, document, 20_000);
    expect(await failureMessage(allocate(a, second, document, 3_601))).toMatch(
      /more than is outstanding/,
    );
    const other = await invoice(a);
    expect(await failureMessage(allocate(a, first, other, 1))).toMatch(
      /more than is left to allocate/,
    );

    const change = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx.update(allocations).set({ amountPaise: 1 }).where(eq(allocations.id, row)),
      ),
    );
    expect(change).toMatch(/permission denied/);
    const ownerChange = await failureMessage(
      connection.db.delete(allocations).where(eq(allocations.id, row)),
    );
    expect(ownerChange).toMatch(/allocations are append-only/);
    expect(await failureMessage(connection.db.execute(sql`truncate allocations cascade`))).toMatch(
      /allocations are append-only/,
    );

    const reverse = (amountPaise: number) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(allocations).values({
          organizationId: a.org,
          partyId: a.party,
          paymentId: first,
          documentId: document,
          amountPaise,
          reversesAllocationId: row,
        }),
      );
    expect(await failureMessage(reverse(-100))).toMatch(/a reversal must undo exactly one/);
    await reverse(-20_000);
    await withTenant(connection.db, a.org, (tx) => adjustPartyAdvance(tx, a.party, 20_000));
    expect(await failureMessage(reverse(-20_000))).toMatch(/allocations_reverses_unique/);
    await allocate(a, second, document, 23_600);
  });

  it('pays only issued bills, opening balances and charges of the same party', async () => {
    const paid = await payment(a, 50_000);
    const draft = await withTenant(connection.db, a.org, async (tx) =>
      id(
        await tx
          .insert(taxDocuments)
          .values({
            organizationId: a.org,
            kind: 'invoice',
            storeId: a.store,
            partyId: a.party,
            createdByMemberId: a.member,
          })
          .returning(),
      ),
    );
    expect(await failureMessage(allocate(a, paid, draft, 100))).toMatch(/only an issued invoice/);
    const theirs = await invoice(a, a.otherParty);
    expect(await failureMessage(allocate(a, paid, theirs, 100))).toMatch(/allocations_document_fk/);

    const toEntry = (entry: string) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(allocations).values({
          organizationId: a.org,
          partyId: a.party,
          paymentId: paid,
          partyLedgerId: entry,
          amountPaise: 1_000,
        }),
      );
    const [opening, paymentEntry] = await withTenant(connection.db, a.org, async (tx) => {
      await postPartyLedger(tx, [
        {
          organizationId: a.org,
          partyId: a.party,
          entryOn: '2026-04-01',
          entryType: 'opening',
          amountPaise: 1_000,
          referenceType: 'opening',
          referenceId: a.party,
        },
      ]);
      const rows = await tx
        .select({ id: partyLedger.id, type: partyLedger.entryType })
        .from(partyLedger)
        .where(eq(partyLedger.partyId, a.party));
      return [
        String(rows.find((entry) => entry.type === 'opening')?.id),
        String(rows.find((entry) => entry.type === 'payment_in')?.id),
      ];
    });
    await toEntry(opening);
    expect(await failureMessage(toEntry(opening))).toMatch(/more than is outstanding/);
    expect(await failureMessage(toEntry(paymentEntry))).toMatch(/only an opening balance/);
    await withTenant(connection.db, a.org, (tx) => adjustPartyAdvance(tx, a.party, -1_000));
  });

  it('refunds only cleared money into a refund, and never allocates a bounced cheque', async () => {
    const cheque = await payment(a, 9_000, { cheque: true });
    const refund = await withTenant(connection.db, a.org, async (tx) =>
      id(
        await tx
          .insert(payments)
          .values({
            organizationId: a.org,
            storeId: a.store,
            number: 'RF-000001',
            direction: 'out',
            partyId: a.party,
            modeId: a.cash,
            modeKind: 'cash',
            amountPaise: 9_000,
            receivedOn: '2026-10-07',
            createdByMemberId: a.member,
          })
          .returning(),
      ),
    );
    const toRefund = (source: string) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(allocations).values({
          organizationId: a.org,
          partyId: a.party,
          paymentId: source,
          refundPaymentId: refund,
          amountPaise: 9_000,
        }),
      );
    expect(await failureMessage(toRefund(cheque))).toMatch(/refunded only after it clears/);
    const notRefund = await payment(a, 9_000);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(allocations).values({
            organizationId: a.org,
            partyId: a.party,
            paymentId: cheque,
            refundPaymentId: notRefund,
            amountPaise: 9_000,
          }),
        ),
      ),
    ).toMatch(/paid back only by a refund/);
    const bill = await invoice(a);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(allocations).values({
            organizationId: a.org,
            partyId: a.party,
            paymentId: refund,
            documentId: bill,
            amountPaise: 1,
          }),
        ),
      ),
    ).toMatch(/only money received/);
    await withTenant(connection.db, a.org, async (tx) => {
      await tx
        .update(payments)
        .set({ chequeStatus: 'bounced', chequeBouncedOn: '2026-10-08', bounceReason: 'Funds' })
        .where(eq(payments.id, cheque));
      await postPartyLedger(tx, [
        {
          organizationId: a.org,
          partyId: a.party,
          entryOn: '2026-10-08',
          entryType: 'cheque_bounce',
          amountPaise: 9_000,
          referenceType: 'payment',
          referenceId: cheque,
        },
      ]);
      await adjustPartyAdvance(tx, a.party, -9_000);
    });
    expect(await failureMessage(allocate(a, cheque, await invoice(a), 1))).toMatch(
      /only money received, and not bounced/,
    );
  });

  it('lets only one of two racing allocations take the same amount', async () => {
    const document = await invoice(a);
    const first = await payment(a, 23_600);
    const second = await payment(a, 23_600);
    const results = await Promise.allSettled([
      allocate(a, first, document, 23_600),
      allocate(a, second, document, 23_600),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('refuses to cancel a document with money against it', async () => {
    const document = await invoice(a);
    await allocate(a, await payment(a, 100), document, 100);
    const message = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx
          .update(taxDocuments)
          .set({
            status: 'cancelled',
            cancelReason: 'Mistake',
            cancelledAt: sql`now()`,
            cancelledByMemberId: a.member,
          })
          .where(eq(taxDocuments.id, document)),
      ),
    );
    expect(message).toMatch(/a paid document cannot be cancelled/);
  });
});

describe('scheme reference on notes (for round 3c)', () => {
  it('keeps a scheme reference on a document, fixed once issued', async () => {
    const document = await invoice(a);
    const change = (schemeReference: string) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.update(taxDocuments).set({ schemeReference }).where(eq(taxDocuments.id, document)),
      );
    expect(await failureMessage(change('Diwali 2026'))).toMatch(/cannot be changed/);
    const draft = await withTenant(connection.db, a.org, async (tx) =>
      tx
        .insert(taxDocuments)
        .values({
          organizationId: a.org,
          kind: 'credit_note',
          storeId: a.store,
          partyId: a.party,
          schemeReference: 'Diwali 2026',
          createdByMemberId: a.member,
        })
        .returning({ schemeReference: taxDocuments.schemeReference }),
    );
    expect(draft).toEqual([{ schemeReference: 'Diwali 2026' }]);
  });
});

describe('register sessions', () => {
  it('keeps one open session per register, closes it once and never changes it after', async () => {
    const session = await openSession(a, 'COUNTER2');
    expect(await failureMessage(openSession(a, 'COUNTER2'))).toMatch(/register_sessions_one_open/);
    const movement = (sessionId: string) =>
      withTenant(connection.db, a.org, (tx) =>
        tx
          .insert(registerCashMovements)
          .values({
            organizationId: a.org,
            sessionId,
            kind: 'pay_out',
            amountPaise: 500,
            reason: 'Tea',
            createdByMemberId: a.member,
          })
          .returning(),
      );
    const [moved] = await movement(session);
    expect(
      await failureMessage(
        connection.db
          .update(registerCashMovements)
          .set({ amountPaise: 1 })
          .where(eq(registerCashMovements.id, String(moved?.id))),
      ),
    ).toMatch(/append-only/);
    const float = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx
          .update(registerSessions)
          .set({ openingFloatPaise: 1 })
          .where(eq(registerSessions.id, session)),
      ),
    );
    expect(float).toMatch(/only closes, once/);
    await closeSession(a, session);
    expect(await failureMessage(closeSession(a, session))).toMatch(/only closes, once/);
    expect(await failureMessage(movement(session))).toMatch(/this register session is closed/);
    expect(
      await failureMessage(
        connection.db.delete(registerSessions).where(eq(registerSessions.id, session)),
      ),
    ).toMatch(/never deleted/);
    // The register opens again the next day.
    const next = await openSession(a, 'COUNTER2');
    const wrong = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx
          .update(registerSessions)
          .set({
            status: 'closed',
            closedByMemberId: a.member,
            closedAt: sql`now()`,
            expectedCashPaise: 100,
            countedCashPaise: 100,
            variancePaise: 5,
          })
          .where(eq(registerSessions.id, next)),
      ),
    );
    expect(wrong).toMatch(/register_sessions_variance/);
  });
});

describe('ledger mappings and accounting exports', () => {
  it('matches a mapping only on facts its purpose has', async () => {
    const insert = (values: Partial<typeof ledgerMappings.$inferInsert>) =>
      failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(ledgerMappings).values({
            organizationId: a.org,
            purpose: 'sales',
            tallyLedgerName: 'Sales',
            ...values,
          }),
        ),
      );
    expect(await insert({ modeKind: 'cash' })).toMatch(/ledger_mappings_match_fits_purpose/);
    expect(await insert({ purpose: 'payment_mode', rateBps: 1800 })).toMatch(/match_fits_purpose/);
    expect(await insert({ purpose: 'party', supplyType: 'inter_state' })).toMatch(
      /match_fits_purpose/,
    );
    expect(await insert({ tallyGroup: 'Assets' })).toMatch(/ledger_mappings_group/);
    await withTenant(connection.db, a.org, (tx) =>
      tx.insert(ledgerMappings).values([
        { organizationId: a.org, purpose: 'payment_mode', modeId: a.cash, tallyLedgerName: 'Till' },
        { organizationId: a.org, purpose: 'party', partyId: a.party, tallyLedgerName: 'Lakshmi' },
        {
          organizationId: a.org,
          purpose: 'sales',
          rateBps: 1800,
          supplyType: 'intra_state',
          storeId: a.store,
          tallyGroup: 'Sales Accounts',
          tallyLedgerName: 'Sales 18% AMP',
        },
      ]),
    );
  });

  it('keeps an export as sent, filing its file once', async () => {
    const insert = (kinds: string[]) =>
      withTenant(connection.db, a.org, async (tx) =>
        id(
          await tx
            .insert(accountingExports)
            .values({
              organizationId: a.org,
              periodFrom: '2026-10-01',
              periodTo: '2026-10-31',
              kinds,
              format: 'xlsx',
              createdByMemberId: a.member,
            })
            .returning(),
        ),
      );
    expect(await failureMessage(insert(['purchases']))).toMatch(/accounting_exports_kinds/);
    const exported = await insert(['sales', 'receipt']);
    const change = (values: Partial<typeof accountingExports.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.update(accountingExports).set(values).where(eq(accountingExports.id, exported)),
      );
    expect(await failureMessage(change({ periodTo: '2026-10-30' }))).toMatch(/never changes/);
    const file = await failureMessage(change({ documentId: crypto.randomUUID() }));
    expect(file).toMatch(/accounting_exports_document_fk/);
    expect(
      await failureMessage(
        connection.db.delete(accountingExports).where(eq(accountingExports.id, exported)),
      ),
    ).toMatch(/never changes/);
  });
});

describe('reconciliation', () => {
  it('finds no party whose balance, advance or allocations disagree', async () => {
    expect(await findPartyBalanceMismatches(connection.db)).toEqual([]);
    expect(await findAllocationMismatches(connection.db)).toEqual([]);
  });

  it('reports an advance that drifted from the payments, and refuses one below zero', async () => {
    const party = id(
      await connection.db
        .insert(parties)
        .values({ organizationId: a.org, displayName: 'Drift' })
        .returning(),
    );
    await payment(a, 1_000, { party });
    await withTenant(connection.db, a.org, (tx) => adjustPartyAdvance(tx, party, -400));
    expect(await findAllocationMismatches(connection.db)).toEqual([
      {
        organizationId: a.org,
        partyId: party,
        balancePaise: -1_000,
        advancePaise: 600,
        outstandingPaise: 0,
        unallocatedPaise: 1_000,
      },
    ]);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) => adjustPartyAdvance(tx, party, -601)),
      ),
    ).toMatch(/party_balances_advance_not_negative/);
    await withTenant(connection.db, a.org, (tx) => adjustPartyAdvance(tx, party, 400));
    const [row] = await connection.db
      .select({ advance: partyBalances.advancePaise })
      .from(partyBalances)
      .where(eq(partyBalances.partyId, party));
    expect(row).toEqual({ advance: 1_000 });
    expect(await findAllocationMismatches(connection.db)).toEqual([]);
  });
});
