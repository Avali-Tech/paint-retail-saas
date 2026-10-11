import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  findPartyBalanceMismatches,
  migrateDatabase,
  postPartyLedger,
  schema,
  withTenant,
  type DatabaseConnection,
  type PartyLedgerEntry,
} from './index.js';

const {
  brands,
  documentSeries,
  idempotencyKeys,
  organizationMembers,
  organizations,
  parties,
  partyBalances,
  partyLedger,
  productVariants,
  products,
  roles,
  stores,
  taxDocumentLines,
  taxDocumentLinks,
  taxDocumentTaxRows,
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
  readonly variant: string;
  readonly series: string;
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
  return { org, store, member, party, variant, series };
}

/** A draft with one line, as the API writes it. */
async function draft(t: Tenant): Promise<string> {
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
    await tx.insert(taxDocumentLines).values({
      organizationId: t.org,
      documentId: document,
      lineNo: 1,
      variantId: t.variant,
      quantity: 2,
      unitPricePaise: 11_800,
    });
    return document;
  });
}

let serial = 0;
/** Issues a draft the way the API does: lines and tax rows first, then the header. */
async function issue(t: Tenant, document: string): Promise<void> {
  serial += 1;
  await withTenant(connection.db, t.org, async (tx) => {
    await tx
      .update(taxDocumentLines)
      .set({
        hsnCode: '32091090',
        uqc: 'LTR',
        grossPaise: 23_600,
        taxablePaise: 20_000,
        rateBps: 1800,
        taxNature: 'taxable',
        cgstPaise: 1_800,
        sgstPaise: 1_800,
        totalPaise: 23_600,
      })
      .where(eq(taxDocumentLines.documentId, document));
    await tx.insert(taxDocumentTaxRows).values({
      organizationId: t.org,
      documentId: document,
      hsnCode: '32091090',
      rateBps: 1800,
      taxablePaise: 20_000,
      cgstPaise: 1_800,
      sgstPaise: 1_800,
      igstPaise: 0,
      cessPaise: 0,
    });
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
  });
}

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

describe('tax documents: tenant isolation', () => {
  it("never shows or changes another business's documents, lines, ledger or keys", async () => {
    const document = await draft(b);
    await withTenant(connection.db, b.org, (tx) =>
      postPartyLedger(tx, [
        {
          organizationId: b.org,
          partyId: b.party,
          entryOn: '2026-10-07',
          entryType: 'opening',
          amountPaise: 500,
        },
      ]),
    );
    await withTenant(connection.db, b.org, (tx) =>
      tx
        .insert(idempotencyKeys)
        .values({ organizationId: b.org, memberId: b.member, key: 'k', requestHash: 'h' }),
    );

    const seen = await withTenant(connection.db, a.org, async (tx) => ({
      documents: await tx.select().from(taxDocuments).where(eq(taxDocuments.id, document)),
      lines: await tx
        .select()
        .from(taxDocumentLines)
        .where(eq(taxDocumentLines.documentId, document)),
      ledger: await tx.select().from(partyLedger).where(eq(partyLedger.partyId, b.party)),
      balances: await tx.select().from(partyBalances).where(eq(partyBalances.partyId, b.party)),
      keys: await tx.select().from(idempotencyKeys),
      series: await tx.select().from(documentSeries).where(eq(documentSeries.id, b.series)),
      changed: await tx
        .update(taxDocuments)
        .set({ note: 'hijack' })
        .where(eq(taxDocuments.id, document))
        .returning(),
    }));
    expect(seen).toEqual({
      documents: [],
      lines: [],
      ledger: [],
      balances: [],
      keys: [],
      series: [],
      changed: [],
    });

    // Nor can a row point into another business (composite foreign keys).
    const message = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(taxDocuments).values({
          organizationId: a.org,
          kind: 'invoice',
          storeId: b.store,
          createdByMemberId: a.member,
        }),
      ),
    );
    expect(message).toMatch(/tax_documents_store_fk/);
    const written = await failureMessage(
      withTenant(connection.db, a.org, (tx) =>
        tx.insert(taxDocuments).values({
          organizationId: b.org,
          kind: 'invoice',
          storeId: b.store,
          createdByMemberId: b.member,
        }),
      ),
    );
    expect(written).toMatch(/row-level security/);
  });
});

describe('tax documents: immutability', () => {
  it('lets a draft change freely, its lines too, and be deleted with them', async () => {
    const document = await draft(a);
    await withTenant(connection.db, a.org, async (tx) => {
      await tx
        .update(taxDocuments)
        .set({ note: 'Hold for Ravi' })
        .where(eq(taxDocuments.id, document));
      await tx
        .update(taxDocumentLines)
        .set({ quantity: 3 })
        .where(eq(taxDocumentLines.documentId, document));
      await tx.delete(taxDocuments).where(eq(taxDocuments.id, document));
    });
    const left = await connection.db
      .select()
      .from(taxDocumentLines)
      .where(eq(taxDocumentLines.documentId, document));
    expect(left).toEqual([]);
  });

  it('refuses any edit or delete of an issued document, its lines, tax rows and links', async () => {
    const document = await draft(a);
    const other = await draft(a);
    await issue(a, document);
    const asTenant = (work: Parameters<typeof withTenant>[2]) =>
      failureMessage(withTenant(connection.db, a.org, work));

    const refusals = [
      await asTenant((tx) =>
        tx.update(taxDocuments).set({ totalPaise: 1 }).where(eq(taxDocuments.id, document)),
      ),
      await asTenant((tx) =>
        tx.update(taxDocuments).set({ note: 'later' }).where(eq(taxDocuments.id, document)),
      ),
      await asTenant((tx) =>
        tx.update(taxDocuments).set({ status: 'draft' }).where(eq(taxDocuments.id, document)),
      ),
      await asTenant((tx) => tx.delete(taxDocuments).where(eq(taxDocuments.id, document))),
      await asTenant((tx) =>
        tx
          .update(taxDocumentLines)
          .set({ quantity: 1 })
          .where(eq(taxDocumentLines.documentId, document)),
      ),
      await asTenant((tx) =>
        tx.delete(taxDocumentLines).where(eq(taxDocumentLines.documentId, document)),
      ),
      await asTenant((tx) =>
        tx.insert(taxDocumentLines).values({
          organizationId: a.org,
          documentId: document,
          lineNo: 2,
          variantId: a.variant,
          quantity: 1,
          unitPricePaise: 1,
        }),
      ),
      await asTenant((tx) =>
        tx
          .update(taxDocumentTaxRows)
          .set({ taxablePaise: 1 })
          .where(eq(taxDocumentTaxRows.documentId, document)),
      ),
      await asTenant((tx) =>
        tx.insert(taxDocumentLinks).values({
          organizationId: a.org,
          fromDocumentId: document,
          toDocumentId: other,
          kind: 'replaces',
        }),
      ),
      // Moving a draft's line onto the issued document is refused as well.
      await asTenant((tx) =>
        tx
          .update(taxDocumentLines)
          .set({ documentId: document, lineNo: 9 })
          .where(eq(taxDocumentLines.documentId, other)),
      ),
    ];
    for (const message of refusals) expect(message).toMatch(/issued tax document/);
    // Even the database owner, outside tenant scope, cannot change one.
    expect(
      await failureMessage(
        connection.db
          .update(taxDocuments)
          .set({ totalPaise: 1 })
          .where(eq(taxDocuments.id, document)),
      ),
    ).toMatch(/cannot be changed/);
  });

  it('allows filling the e-invoice details once, then cancelling, and nothing after', async () => {
    const document = await draft(a);
    await issue(a, document);
    const update = (changes: Partial<typeof taxDocuments.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.update(taxDocuments).set(changes).where(eq(taxDocuments.id, document)),
      );

    await update({
      irn: 'IRN-1',
      ackNo: 'ACK-1',
      ackAt: new Date(0),
      signedQr: 'QR',
      itcReversalStatus: 'unknown',
    });
    for (const changes of [
      { irn: 'IRN-2' },
      { ackNo: 'ACK-2' },
      { ackAt: new Date(1) },
      { signedQr: 'QR2' },
    ]) {
      expect(await failureMessage(update(changes))).toMatch(/cannot be changed/);
    }
    await update({
      status: 'cancelled',
      cancelReason: 'Wrong customer',
      cancelledAt: new Date(),
      cancelledByMemberId: a.member,
    });
    expect(await failureMessage(update({ itcReversalStatus: 'reversed' }))).toMatch(
      /cannot be changed/,
    );
    expect(
      await failureMessage(
        update({
          status: 'issued',
          cancelReason: null,
          cancelledAt: null,
          cancelledByMemberId: null,
        }),
      ),
    ).toMatch(/cannot be changed/);
    await update({ updatedAt: new Date() });
  });

  it('keeps an issued document complete and its taxes consistent', async () => {
    const document = await draft(a);
    const set = (changes: Partial<typeof taxDocuments.$inferInsert>) =>
      failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.update(taxDocuments).set(changes).where(eq(taxDocuments.id, document)),
        ),
      );
    expect(await set({ status: 'issued' })).toMatch(/tax_documents_issued_complete/);
    expect(await set({ taxablePaise: 100, totalPaise: 99 })).toMatch(/tax_documents_total/);
    expect(await set({ kind: 'bill_of_supply', igstPaise: 9, totalPaise: 9 })).toMatch(
      /tax_documents_bill_of_supply_untaxed/,
    );
    expect(await set({ roundOffPaise: 51, totalPaise: 51 })).toMatch(/tax_documents_round_off/);
  });

  it('numbers once per GSTIN, financial year and kind', async () => {
    const first = await draft(a);
    const second = await draft(a);
    await issue(a, first);
    const [row] = await connection.db.select().from(taxDocuments).where(eq(taxDocuments.id, first));
    serial -= 1;
    expect(await failureMessage(issue(a, second))).toMatch(/tax_documents_number_unique/);
    expect(row?.number).toMatch(/^AMP\/26-27\/\d{6}$/);
    serial += 1;
  });
});

describe('series', () => {
  it('keeps numbers within 16 characters of A–Z 0–9, one active series per store and kind', async () => {
    const insert = (
      prefix: string,
      digits: number,
      kind: 'invoice' | 'credit_note' = 'credit_note',
    ) =>
      failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx
            .insert(documentSeries)
            .values({ organizationId: a.org, storeId: a.store, kind, prefix, digits }),
        ),
      );
    expect(await insert('AMPC', 6)).toMatch(/document_series_length/);
    expect(await insert('amp', 3)).toMatch(/document_series_prefix_format/);
    expect(await insert('AMPX', 3, 'invoice')).toMatch(/document_series_one_active/);
  });
});

describe('postPartyLedger', () => {
  const post = (entries: Omit<PartyLedgerEntry, 'organizationId'>[]) =>
    withTenant(connection.db, a.org, (tx) =>
      postPartyLedger(
        tx,
        entries.map((entry) => ({ organizationId: a.org, ...entry })),
      ),
    );
  const balanceOf = async (partyId: string) =>
    (await connection.db.select().from(partyBalances).where(eq(partyBalances.partyId, partyId)))[0];

  it('appends entries and keeps the balance equal to their sum', async () => {
    const party = id(
      await connection.db
        .insert(parties)
        .values({ organizationId: a.org, displayName: 'Kiran' })
        .returning(),
    );
    await post([
      { partyId: party, entryOn: '2026-10-07', entryType: 'opening', amountPaise: 10_000 },
      {
        partyId: party,
        storeId: a.store,
        entryOn: '2026-10-07',
        entryType: 'invoice',
        amountPaise: 23_600,
        referenceType: 'tax_document',
        referenceId: crypto.randomUUID(),
      },
      {
        partyId: a.party,
        entryOn: '2026-10-07',
        entryType: 'adjustment',
        amountPaise: -1,
        note: 'Rounding',
      },
    ]);
    await post([
      { partyId: party, entryOn: '2026-10-08', entryType: 'payment_in', amountPaise: -3_600 },
    ]);

    expect(await balanceOf(party)).toMatchObject({ balancePaise: 30_000, advancePaise: 0 });
    expect(await findPartyBalanceMismatches(connection.db)).toEqual([]);
  });

  it('refuses an amount whose sign does not match its type, and a second entry for one document', async () => {
    expect(
      await failureMessage(
        post([{ partyId: a.party, entryOn: '2026-10-07', entryType: 'invoice', amountPaise: -5 }]),
      ),
    ).toMatch(/party_ledger_amount_sign/);
    expect(
      await failureMessage(
        post([
          { partyId: a.party, entryOn: '2026-10-07', entryType: 'cancellation', amountPaise: 5 },
        ]),
      ),
    ).toMatch(/party_ledger_amount_sign/);
    const referenceId = crypto.randomUUID();
    const entry = {
      partyId: a.party,
      entryOn: '2026-10-07',
      entryType: 'invoice',
      amountPaise: 5,
      referenceType: 'tax_document',
      referenceId,
    } as const;
    await post([entry]);
    expect(await failureMessage(post([entry]))).toMatch(/party_ledger_reference_unique/);
  });

  it('is append-only, even for the database owner', async () => {
    const [entry] = await connection.db.select().from(partyLedger).limit(1);
    if (!entry) throw new Error('Expected an entry');
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.update(partyLedger).set({ note: 'x' }).where(eq(partyLedger.id, entry.id)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db.update(partyLedger).set({ note: 'x' }).where(eq(partyLedger.id, entry.id)),
      ),
    ).toMatch(/append-only/);
    expect(
      await failureMessage(connection.db.delete(partyLedger).where(eq(partyLedger.id, entry.id))),
    ).toMatch(/append-only/);
    expect(await failureMessage(connection.db.execute(sql`truncate party_ledger cascade`))).toMatch(
      /append-only/,
    );
  });

  it('reports a balance that has drifted from its ledger', async () => {
    const party = id(
      await connection.db
        .insert(parties)
        .values({ organizationId: a.org, displayName: 'Drift' })
        .returning(),
    );
    await connection.db
      .insert(partyBalances)
      .values({ organizationId: a.org, partyId: party, balancePaise: 700 });
    expect(await findPartyBalanceMismatches(connection.db)).toEqual([
      { organizationId: a.org, partyId: party, balancePaise: 700, ledgerTotalPaise: 0 },
    ]);
    await connection.db.delete(partyBalances).where(eq(partyBalances.partyId, party));
  });
});
