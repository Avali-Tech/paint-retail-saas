import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  postPartyLedger,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

// MVP 3 round 4a (migrations 0079–0080): UPI payment links, the documents they pay,
// and payments a gateway reported for them.

const {
  auditLog,
  documentSeries,
  organizationMembers,
  organizations,
  parties,
  partyLedger,
  paymentLinkDocuments,
  paymentLinks,
  paymentModes,
  payments,
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
  readonly member: string;
  readonly party: string;
  readonly otherParty: string;
  readonly series: string;
  readonly linkMode: string;
  readonly cash: string;
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
  const series = id(
    await db
      .insert(documentSeries)
      .values({ organizationId: org, storeId: store, kind: 'invoice', prefix: 'AMP', digits: 6 })
      .returning(),
  );
  const linkMode = id(
    await db
      .insert(paymentModes)
      .values({ organizationId: org, kind: 'upi_link', name: 'UPI link' })
      .returning(),
  );
  const cash = id(
    await db
      .insert(paymentModes)
      .values({ organizationId: org, kind: 'cash', name: 'Cash' })
      .returning(),
  );
  return { org, store, member, party, otherParty, series, linkMode, cash };
}

let serial = 0;
/** An issued invoice of ₹236.00 to the party, with its ledger entry. */
async function invoice(t: Tenant): Promise<string> {
  serial += 1;
  return withTenant(connection.db, t.org, async (tx) => {
    const document = id(
      await tx
        .insert(taxDocuments)
        .values({
          organizationId: t.org,
          kind: 'invoice',
          storeId: t.store,
          partyId: t.party,
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
        partyId: t.party,
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

let links = 0;
/** Values for a test link; `expiresAt` may be SQL. */
type LinkValues = { [K in keyof typeof paymentLinks.$inferInsert]?: unknown };

const link = (t: Tenant, values: LinkValues = {}) => {
  links += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(paymentLinks)
        .values({
          organizationId: t.org,
          number: `PL-${String(links).padStart(6, '0')}`,
          storeId: t.store,
          partyId: t.party,
          purpose: 'invoice',
          origin: 'staff',
          amountPaise: 23_600,
          description: 'Invoice AMP/26-27/000001',
          provider: 'log',
          gatewayReference: `plink_log_${String(links)}`,
          url: `http://localhost:5173/pay/plink_log_${String(links)}`,
          expiresAt: sql`now() + interval '7 days'`,
          createdByMemberId: t.member,
          ...(values as Partial<typeof paymentLinks.$inferInsert>),
        })
        .returning(),
    ),
  );
};

const setLink = (t: Tenant, linkId: string, values: Partial<typeof paymentLinks.$inferInsert>) =>
  withTenant(connection.db, t.org, (tx) =>
    tx.update(paymentLinks).set(values).where(eq(paymentLinks.id, linkId)),
  );

let receipts = 0;
const linkPayment = (t: Tenant, values: Partial<typeof payments.$inferInsert>) => {
  receipts += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(payments)
        .values({
          organizationId: t.org,
          storeId: t.store,
          number: `RC-${String(receipts).padStart(6, '0')}`,
          direction: 'in',
          partyId: t.party,
          modeId: t.linkMode,
          modeKind: 'upi_link',
          amountPaise: 10_000,
          receivedOn: '2026-10-07',
          gatewayReference: `pay_log_${String(receipts)}`,
          ...values,
        })
        .returning(),
    ),
  );
};

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

describe('payment links', () => {
  it.each([
    [{ number: 'PL-12' }, /payment_links_number_format/],
    [{ amountPaise: 0 }, /payment_links_amount_positive/],
    [{ paidPaise: -1 }, /payment_links_paid/],
    [{ expiresAt: sql`now() - interval '1 day'` }, /payment_links_expiry/],
    [{ status: 'paid' as const }, /payment_links_status/],
    [{ paidAt: new Date() }, /payment_links_status/],
    [{ status: 'cancelled' as const }, /payment_links_status/],
    [{ description: '' }, /payment_links_text_lengths/],
    [{ url: 'x'.repeat(501) }, /payment_links_text_lengths/],
  ])('refuse inconsistent links: %o', async (values, constraint) => {
    expect(await failureMessage(link(a, values))).toMatch(constraint);
  });

  it('keep the gateway reference unique per provider and the number per business', async () => {
    await link(a, { gatewayReference: 'plink_same', number: 'PL-900001' });
    expect(
      await failureMessage(link(b, { gatewayReference: 'plink_same', number: 'PL-900002' })),
    ).toMatch(/payment_links_gateway_reference_unique/);
    expect(await failureMessage(link(a, { number: 'PL-900001' }))).toMatch(
      /payment_links_number_unique/,
    );
    // Another business may use the same number.
    await expect(link(b, { number: 'PL-900001' })).resolves.toBeTruthy();
  });

  it('move forward only: created → paid, expired or cancelled; expired or cancelled → paid', async () => {
    const expired = await link(a);
    await setLink(a, expired, { status: 'expired' });
    expect(await failureMessage(setLink(a, expired, { status: 'created' }))).toMatch(
      /a expired payment link cannot become created/,
    );
    expect(
      await failureMessage(setLink(a, expired, { status: 'cancelled', cancelledAt: new Date() })),
    ).toMatch(/cannot become cancelled/);
    await setLink(a, expired, { status: 'paid', paidAt: new Date(), paidPaise: 23_600 });
    expect(await failureMessage(setLink(a, expired, { status: 'expired', paidAt: null }))).toMatch(
      /a paid payment link cannot become expired/,
    );

    const cancelled = await link(a);
    await setLink(a, cancelled, {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledByMemberId: a.member,
    });
    expect(
      await failureMessage(setLink(a, cancelled, { cancelledByMemberId: null, cancelledAt: null })),
    ).toMatch(/payment_links_status|written once/);
    await setLink(a, cancelled, { status: 'paid', paidAt: new Date(), paidPaise: 100 });
  });

  it('keep what they asked for; what was paid only grows and the payment time is written once', async () => {
    const asked = await link(a);
    expect(await failureMessage(setLink(a, asked, { amountPaise: 1 }))).toMatch(
      /keeps what it asked for/,
    );
    expect(await failureMessage(setLink(a, asked, { partyId: a.otherParty }))).toMatch(
      /keeps what it asked for|payment_links/,
    );
    // A part payment leaves it open.
    await setLink(a, asked, { paidPaise: 10_000 });
    expect(await failureMessage(setLink(a, asked, { paidPaise: 5_000 }))).toMatch(/only grows/);
    await setLink(a, asked, { status: 'paid', paidAt: new Date('2026-10-07T10:00:00Z') });
    expect(
      await failureMessage(setLink(a, asked, { paidAt: new Date('2026-10-08T10:00:00Z') })),
    ).toMatch(/written once/);
    // More money on a paid link (an overpayment) is still recorded.
    await setLink(a, asked, { paidPaise: 30_000 });
  });

  it('are never deleted by a tenant, and are audited', async () => {
    const kept = await link(a);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(paymentLinks).where(eq(paymentLinks.id, kept)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(connection.db.delete(paymentLinks).where(eq(paymentLinks.id, kept))),
    ).toMatch(/never deleted/);
    await setLink(a, kept, { status: 'cancelled', cancelledAt: new Date() });
    const audit = await connection.db
      .select({ action: auditLog.action, newValues: auditLog.newValues })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'payment_links' and ${auditLog.recordId} = ${kept}`)
      .orderBy(auditLog.id);
    expect(audit.map((row) => row.action)).toEqual(['insert', 'update']);
    expect(audit[1]?.newValues).toMatchObject({ status: 'cancelled' });
  });

  it("stay within their business: another business's links are invisible", async () => {
    await link(b, { partyId: b.party, storeId: b.store });
    const seen = await withTenant(connection.db, a.org, (tx) =>
      tx
        .select({ organizationId: paymentLinks.organizationId })
        .from(paymentLinks)
        .where(eq(paymentLinks.organizationId, b.org)),
    );
    expect(seen).toEqual([]);
  });
});

describe('payment link documents', () => {
  it("name the link's own party's documents, one target each, and never change", async () => {
    const document = await invoice(a);
    const owned = await link(a);
    const write = (values: Partial<typeof paymentLinkDocuments.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx
          .insert(paymentLinkDocuments)
          .values({
            organizationId: a.org,
            linkId: owned,
            partyId: a.party,
            documentId: document,
            position: 0,
            outstandingPaise: 23_600,
            ...values,
          })
          .returning(),
      );
    expect(await failureMessage(write({ partyId: a.otherParty }))).toMatch(
      /payment_link_documents_(link|document)_fk/,
    );
    const row = id(await write({}));
    expect(await failureMessage(write({ position: 1 }))).toMatch(
      /payment_link_documents_document_unique/,
    );
    expect(
      await failureMessage(write({ documentId: null, partyLedgerId: null, position: 3 })),
    ).toMatch(/payment_link_documents_one_target/);
    expect(await failureMessage(write({ outstandingPaise: 0, position: 4 }))).toMatch(
      /payment_link_documents_amounts/,
    );
    const [opening] = await connection.db
      .select({ id: partyLedger.id })
      .from(partyLedger)
      .where(eq(partyLedger.referenceId, document));
    expect(
      await failureMessage(
        write({
          documentId: null,
          partyLedgerId: String(opening?.id),
          partyId: a.otherParty,
          position: 5,
        }),
      ),
    ).toMatch(/payment_link_documents_(link|party_ledger)_fk/);
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx
            .update(paymentLinkDocuments)
            .set({ position: 9 })
            .where(eq(paymentLinkDocuments.id, row)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db.delete(paymentLinkDocuments).where(eq(paymentLinkDocuments.id, row)),
      ),
    ).toMatch(/append-only/);
    expect(
      await failureMessage(connection.db.execute(sql`truncate payment_link_documents cascade`)),
    ).toMatch(/append-only/);
  });
});

describe('payments for a link', () => {
  it('come from a gateway: money in, with its payment id, no member and no register', async () => {
    const paid = await link(a);
    await expect(linkPayment(a, { paymentLinkId: paid })).resolves.toBeTruthy();
    expect(
      await failureMessage(linkPayment(a, { paymentLinkId: paid, gatewayReference: null })),
    ).toMatch(/payments_link/);
    expect(await failureMessage(linkPayment(a, { paymentLinkId: null }))).toMatch(/payments_link/);
    expect(
      await failureMessage(
        linkPayment(a, {
          paymentLinkId: null,
          modeId: a.cash,
          modeKind: 'cash',
          gatewayReference: null,
        }),
      ),
    ).toMatch(/payments_link/);
    expect(
      await failureMessage(
        linkPayment(a, { paymentLinkId: paid, modeId: a.cash, modeKind: 'cash' }),
      ),
    ).toMatch(/payments_link/);
    const session = await withTenant(connection.db, a.org, async (tx) =>
      id(
        await tx
          .insert(registerSessions)
          .values({
            organizationId: a.org,
            storeId: a.store,
            registerCode: 'COUNTER1',
            openedByMemberId: a.member,
            openingFloatPaise: 0,
          })
          .returning(),
      ),
    );
    expect(
      await failureMessage(linkPayment(a, { paymentLinkId: paid, registerSessionId: session })),
    ).toMatch(/payments_link/);
    // A member's payment still names its member.
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.insert(payments).values({
            organizationId: a.org,
            storeId: a.store,
            number: 'RC-999999',
            direction: 'in',
            partyId: a.party,
            modeId: a.cash,
            modeKind: 'cash',
            amountPaise: 100,
            receivedOn: '2026-10-07',
          }),
        ),
      ),
    ).toMatch(/payments_link/);
  });

  it("record a gateway's payment once per business, for the link's own party", async () => {
    const paid = await link(a);
    await linkPayment(a, { paymentLinkId: paid, gatewayReference: 'pay_once' });
    expect(
      await failureMessage(linkPayment(a, { paymentLinkId: paid, gatewayReference: 'pay_once' })),
    ).toMatch(/payments_link_gateway_reference_unique/);
    expect(
      await failureMessage(
        linkPayment(a, { paymentLinkId: paid, partyId: a.otherParty, gatewayReference: 'pay_2' }),
      ),
    ).toMatch(/payments_payment_link_fk/);
    // A typed reference on a member's payment may repeat, as before.
    const typed = (number: string) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(payments).values({
          organizationId: a.org,
          storeId: a.store,
          number,
          direction: 'in',
          partyId: a.party,
          modeId: a.cash,
          modeKind: 'cash',
          amountPaise: 100,
          receivedOn: '2026-10-07',
          gatewayReference: 'pay_once',
          createdByMemberId: a.member,
        }),
      );
    await typed('RC-888881');
    await expect(typed('RC-888882')).resolves.toBeTruthy();
  });
});
