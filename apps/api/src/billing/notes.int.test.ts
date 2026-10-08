import {
  findAllocationMismatches,
  findPartyBalanceMismatches,
  findStockMismatches,
  migrateDatabase,
  postStockMovements,
  schema,
  withTenant,
} from '@paint/db';
import {
  computeReturn,
  creditNoteWindow,
  financialYear,
  gstinCheckCharacter,
  noteSourceOf,
  type InvoiceAdjustments,
  type NotePage,
  type NoteView,
  type SalesReturnView,
  type TaxCategoryOptions,
  type TaxDocumentView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

const { partyBalances, partyLedger, stockBalances, stockLedger, taxDocumentLines, taxDocuments } =
  schema;

let database: TestDatabase;
let t: TestApp;

const PAN = 'AABCS1429B';
const gstin = (state: string, pan = PAN, entity = '1') => {
  const first14 = `${state}${pan}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;
const api = (token: string, headers: Record<string, string> = {}) => {
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { ...bearer(token), ...headers }, payload });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: object = {}) => call('POST', url, payload),
  };
};
const ok = (reply: Reply): Reply => {
  if (reply.statusCode >= 400) throw new Error(`${String(reply.statusCode)}: ${reply.body}`);
  return reply;
};
const issuesOf = (reply: Reply) =>
  reply.json<{ issues: { path: string; message: string }[] }>().issues.map((issue) => issue.path);
const messageOf = (reply: Reply) => reply.json<{ message: string }>().message;

interface Business {
  readonly owner: string;
  readonly organizationId: string;
  readonly stores: { amp: string; kkp: string; sec: string };
  readonly variants: { apex1: string; brush: string; card: string };
  readonly parties: { customer: string; dealer: string; apCustomer: string };
  member(roleKey: string, storeIds: string[]): Promise<string>;
}

async function dbToday(): Promise<string> {
  const result = await t.connection.db.execute<{ today: string }>(
    sql`select ((now() at time zone 'Asia/Kolkata')::date)::text as today`,
  );
  return String(result.rows[0]?.today);
}

let businesses = 0;
async function business(): Promise<Business> {
  businesses += 1;
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: `Varna Paints ${String(businesses)}`,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Varna@2026',
    },
  });
  const { token: owner, organizationId } = signup.json<{ token: string; organizationId: string }>();
  const o = api(owner);
  const put = (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(owner), payload });
  const store = async (name: string, code: string) =>
    ok(await o.post('/stores', { name, code })).json<{ id: string }>().id;
  const stores = {
    amp: await store('Ameerpet', 'AMP'),
    kkp: await store('Kukatpally', 'KKP'),
    sec: await store('Secunderabad', 'SEC'),
  };
  ok(await put('/gst-registrations/business', { legalName: 'Varna Paints Private Limited' }));
  const register = async (storeId: string, registrationType: string, entity: string) =>
    ok(
      await put(`/gst-registrations/stores/${storeId}`, {
        registrationType,
        stateCode: '36',
        gstin: gstin('36', PAN, entity),
        addressLine: '1-2-3 Main Road',
        city: 'Hyderabad',
        pincode: '500016',
      }),
    );
  await register(stores.amp, 'regular', '1');
  await register(stores.kkp, 'regular', '1');
  await register(stores.sec, 'composition', '2');

  const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
  const category = (key: string) => String(options.categories.find((c) => c.key === key)?.id);
  const brandId = ok(await o.post('/brands', { name: 'Berger' })).json<{ id: string }>().id;
  const product = async (body: object) =>
    ok(await o.post('/products', { brandId, ...body })).json<{ variants: { id: string }[] }>()
      .variants[0]?.id;
  const variants = {
    apex1: String(
      await product({
        name: 'Weathercoat',
        type: 'exterior_paint',
        hsnCode: '32091090',
        taxCategoryId: category('paints'),
        variants: [{ sku: 'WC-1L', packSize: 1, unit: 'l', sellingPricePaise: 11_800 }],
      }),
    ),
    brush: String(
      await product({
        name: 'Roller',
        type: 'tool',
        hsnCode: '96034000',
        taxCategoryId: category('brushes_rollers'),
        variants: [{ sku: 'RL-9', packSize: 1, unit: 'piece', sellingPricePaise: 333 }],
      }),
    ),
    card: String(
      await product({
        name: 'Shade card',
        type: 'other',
        hsnCode: '49111010',
        taxCategoryId: category('exempt'),
        variants: [{ sku: 'SC-1', packSize: 1, unit: 'piece', sellingPricePaise: 0 }],
      }),
    ),
  };
  await withTenant(t.connection.db, organizationId, (tx) =>
    postStockMovements(
      tx,
      Object.values(stores).flatMap((storeId) =>
        Object.values(variants).map((variantId) => ({
          organizationId,
          storeId,
          variantId,
          movementType: 'opening' as const,
          quantity: 1_000,
        })),
      ),
    ),
  );
  const party = async (body: object) =>
    ok(await o.post('/parties', { roles: ['customer'], ...body })).json<{ id: string }>().id;
  const parties = {
    customer: await party({ displayName: 'Lakshmi', phone: uniquePhone(), placeOfSupply: '36' }),
    dealer: await party({
      kind: 'organization',
      displayName: 'Deccan Interiors',
      gstin: gstin('36', 'AAACT2727Q'),
    }),
    apCustomer: await party({
      displayName: 'Ramana',
      phone: uniquePhone(),
      placeOfSupply: '37',
    }),
  };
  const roles = ok(await o.get('/roles')).json<{ id: string; key: string }[]>();
  return {
    owner,
    organizationId,
    stores,
    variants,
    parties,
    async member(roleKey, storeIds) {
      const phone = uniquePhone();
      ok(
        await o.post('/members', {
          fullName: `Staff ${roleKey}`,
          phone,
          password: 'Staff@2026',
          roleId: roles.find((role) => role.key === roleKey)?.id,
          storeIds,
        }),
      );
      const login = await t.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { identifier: phone, password: 'Staff@2026' },
      });
      return login.json<{ token: string }>().token;
    },
  };
}

let b: Business;
let today: string;

const line = (variantId: string, quantity = 1, extra: object = {}) => ({
  variantId,
  quantity,
  ...extra,
});
/** An issued invoice (Ameerpet, the walk-in customer Lakshmi by default). */
async function issued(body: object, token = b.owner): Promise<TaxDocumentView> {
  const draft = ok(
    await api(token).post('/invoices', {
      storeId: b.stores.amp,
      partyId: b.parties.customer,
      ...body,
    }),
  ).json<TaxDocumentView>();
  return ok(await api(token).post(`/invoices/${draft.id}/issue`)).json<TaxDocumentView>();
}
const lineId = (invoice: TaxDocumentView, lineNo: number) =>
  String(invoice.lines.find((l) => l.lineNo === lineNo)?.id);
const returnGoods = (body: object, token = b.owner, headers: Record<string, string> = {}) =>
  api(token, headers).post('/sales-returns', body);
const returned = async (body: object) => ok(await returnGoods(body)).json<SalesReturnView>();

async function onHand(storeId: string, variantId: string): Promise<number> {
  const [row] = await t.connection.db
    .select({ onHand: stockBalances.onHand })
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, storeId), eq(stockBalances.variantId, variantId)));
  return Number(row?.onHand);
}
async function balanceOf(partyId: string): Promise<number> {
  const [row] = await t.connection.db
    .select({ balancePaise: partyBalances.balancePaise })
    .from(partyBalances)
    .where(eq(partyBalances.partyId, partyId));
  return Number(row?.balancePaise);
}
const ledgerOf = (documentId: string) =>
  t.connection.db
    .select({ entryType: partyLedger.entryType, amountPaise: partyLedger.amountPaise })
    .from(partyLedger)
    .where(eq(partyLedger.referenceId, documentId));
const movementsOf = (documentId: string) =>
  t.connection.db
    .select({
      movementType: stockLedger.movementType,
      quantity: stockLedger.quantity,
      variantId: stockLedger.variantId,
      note: stockLedger.note,
    })
    .from(stockLedger)
    .where(eq(stockLedger.referenceId, documentId))
    .orderBy(asc(stockLedger.createdAt), asc(stockLedger.movementType));
const serialOf = (number: string | null) => Number(String(number).split('/')[2]);
const heads = (document: {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
}) => ({
  taxablePaise: document.taxablePaise,
  cgstPaise: document.cgstPaise,
  sgstPaise: document.sgstPaise,
  igstPaise: document.igstPaise,
  cessPaise: document.cessPaise,
});
const sumHeads = (documents: Parameters<typeof heads>[0][]) =>
  documents.map(heads).reduce((total, next) => ({
    taxablePaise: total.taxablePaise + next.taxablePaise,
    cgstPaise: total.cgstPaise + next.cgstPaise,
    sgstPaise: total.sgstPaise + next.sgstPaise,
    igstPaise: total.igstPaise + next.igstPaise,
    cessPaise: total.cessPaise + next.cessPaise,
  }));

/** Moves an issued invoice's date back by `days` (only a test can: the trigger is off for it). */
async function backDate(invoiceId: string, days: number): Promise<string> {
  return t.connection.db.transaction(async (tx) => {
    await tx.execute(sql`alter table tax_documents disable trigger tax_documents_immutable`);
    const result = await tx.execute<{ issued_on: string }>(
      sql`update tax_documents set issued_on = issued_on - ${days}::integer
          where id = ${invoiceId} returning issued_on::text`,
    );
    await tx.execute(sql`alter table tax_documents enable trigger tax_documents_immutable`);
    return String(result.rows[0]?.issued_on);
  });
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await business();
  today = await dbToday();
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('sales returns', () => {
  it('returns part, then the rest: stock comes back and the notes reverse the tax exactly', async () => {
    const invoice = await issued({
      lines: [line(b.variants.apex1, 3), line(b.variants.brush, 2.5)],
    });
    const apexBefore = await onHand(b.stores.amp, b.variants.apex1);
    const balanceBefore = await balanceOf(b.parties.customer);

    const first = await returned({
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
      note: 'Wrong shade',
    });
    expect(first.number).toMatch(/^SR-\d{6}$/);
    expect(first).toMatchObject({
      invoiceId: invoice.id,
      storeId: b.stores.amp,
      note: 'Wrong shade',
    });
    expect(first.lines).toEqual([
      {
        id: expect.any(String),
        invoiceLineId: lineId(invoice, 1),
        description: 'Weathercoat 1 l',
        quantity: 1,
        disposition: 'restock',
        reason: null,
      },
    ]);
    const note = first.creditNote;
    const fy = financialYear(today);
    expect(note).toMatchObject({
      kind: 'credit_note',
      status: 'issued',
      reason: 'return',
      number: `AMPC/${fy.slice(2)}/${String(serialOf(note.number)).padStart(5, '0')}`,
      issuedOn: today,
      itcReversalStatus: null,
      salesReturnId: first.id,
      invoice: { id: invoice.id, number: invoice.number, issuedOn: invoice.issuedOn },
      supplier: invoice.supplier,
      buyer: invoice.buyer,
      placeOfSupplyCode: '36',
      supplyType: 'intra_state',
      gstClass: 'b2cs',
    });
    // At the invoice's rate, a third of line 1: what the engine says, to the paisa.
    const engine = computeReturn(
      noteSourceOf(invoice),
      [{ lineIndex: 1, quantity: 1, previouslyReturnedQuantity: 0 }],
      true,
    );
    expect(heads(note)).toEqual(heads(engine.totals));
    expect(note.totalPaise).toBe(engine.totals.payablePaise);
    expect(note.roundOffPaise).toBe(engine.totals.roundOffPaise);
    expect(note.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        sourceLineId: lineId(invoice, 1),
        variantId: b.variants.apex1,
        hsnCode: '32091090',
        uqc: 'LTR',
        quantity: 1,
        unitPricePaise: 11_800,
        rateBps: 1800,
        taxablePaise: 10_000,
        cgstPaise: 900,
        sgstPaise: 900,
        totalPaise: 11_800,
      }),
    ]);
    expect(note.taxRows).toEqual([
      {
        hsnCode: '32091090',
        rateBps: 1800,
        taxablePaise: 10_000,
        cgstPaise: 900,
        sgstPaise: 900,
        igstPaise: 0,
        cessPaise: 0,
      },
    ]);
    expect(await onHand(b.stores.amp, b.variants.apex1)).toBe(apexBefore + 1);
    expect(await movementsOf(note.id)).toEqual([
      {
        movementType: 'sale_return',
        quantity: 1,
        variantId: b.variants.apex1,
        note: `Return ${first.number}`,
      },
    ]);
    expect(await ledgerOf(note.id)).toEqual([
      { entryType: 'credit_note', amountPaise: -note.totalPaise },
    ]);
    expect(await balanceOf(b.parties.customer)).toBe(balanceBefore - note.totalPaise);

    // The rest: one to stock and one damaged, and every roller.
    const brushBefore = await onHand(b.stores.amp, b.variants.brush);
    const rest = await returned({
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId: lineId(invoice, 2), quantity: 2.5, disposition: 'restock' },
        { invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' },
        {
          invoiceLineId: lineId(invoice, 1),
          quantity: 1,
          disposition: 'damage',
          reason: 'Dented tin',
        },
      ],
    });
    expect(rest.lines.map((l) => [l.quantity, l.disposition, l.reason])).toEqual([
      [1, 'restock', null],
      [1, 'damage', 'Dented tin'],
      [2.5, 'restock', null],
    ]);
    expect(rest.creditNote.lines.map((l) => [l.sourceLineId, l.quantity])).toEqual([
      [lineId(invoice, 1), 2],
      [lineId(invoice, 2), 2.5],
    ]);
    expect(serialOf(rest.creditNote.number)).toBe(serialOf(note.number) + 1);
    // Both notes together reverse every head of the invoice exactly.
    expect(sumHeads([note, rest.creditNote])).toEqual(heads(invoice));
    expect(await onHand(b.stores.amp, b.variants.apex1)).toBe(apexBefore + 2);
    expect(await onHand(b.stores.amp, b.variants.brush)).toBe(brushBefore + 2.5);
    expect(await movementsOf(rest.creditNote.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          movementType: 'sale_return',
          quantity: 1,
          note: `Return ${rest.number}`,
        }),
        {
          movementType: 'damage',
          quantity: -1,
          variantId: b.variants.apex1,
          note: `Damaged on return ${rest.number}: Dented tin`,
        },
      ]),
    );
    expect(await movementsOf(rest.creditNote.id)).toHaveLength(4);

    // Nothing is left to return.
    const over = await returnGoods({
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 0.001, disposition: 'restock' }],
    });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({
      message: 'More would come back than was sold',
      issues: [{ path: 'lines.0.quantity', message: 'At most 0 of line 1 can come back' }],
    });

    const adjustments = ok(
      await api(b.owner).get(`/invoices/${invoice.id}/adjustments`),
    ).json<InvoiceAdjustments>();
    expect(adjustments).toEqual({
      invoiceId: invoice.id,
      creditNoteWindow: creditNoteWindow(today, today),
      lines: [
        {
          invoiceLineId: lineId(invoice, 1),
          lineNo: 1,
          soldQuantity: 3,
          returnedQuantity: 3,
          creditedTaxablePaise: invoice.lines[0]?.taxablePaise,
          debitedTaxablePaise: 0,
        },
        {
          invoiceLineId: lineId(invoice, 2),
          lineNo: 2,
          soldQuantity: 2.5,
          returnedQuantity: 2.5,
          creditedTaxablePaise: invoice.lines[1]?.taxablePaise,
          debitedTaxablePaise: 0,
        },
      ],
      notes: [
        expect.objectContaining({
          id: note.id,
          reason: 'return',
          invoice: { id: invoice.id, number: invoice.number },
        }),
        expect.objectContaining({ id: rest.creditNote.id }),
      ],
    });
    // A note on the invoice keeps it from being cancelled, and a note is never cancelled.
    expect(
      (await api(b.owner).post(`/invoices/${invoice.id}/cancel`, { reason: 'Mistake' })).statusCode,
    ).toBe(409);
    const cancelNote = await api(b.owner).post(`/invoices/${note.id}/cancel`, {
      reason: 'Not needed',
    });
    expect(cancelNote.statusCode).toBe(409);
    expect(messageOf(cancelNote)).toMatch(/never cancelled/);
  });

  it('refunds a whole invoice exactly in one note, inter-state too', async () => {
    const invoice = await issued({
      partyId: b.parties.apCustomer,
      lines: [line(b.variants.apex1, 2), line(b.variants.brush, 3)],
    });
    expect(invoice.supplyType).toBe('inter_state');
    const whole = await returned({
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId: lineId(invoice, 1), quantity: 2, disposition: 'restock' },
        { invoiceLineId: lineId(invoice, 2), quantity: 3, disposition: 'damage' },
      ],
    });
    const note = whole.creditNote;
    expect(heads(note)).toEqual(heads(invoice));
    expect(note.totalPaise).toBe(invoice.totalPaise);
    expect(note.roundOffPaise).toBe(invoice.roundOffPaise);
    expect(note.igstPaise).toBeGreaterThan(0);
    expect(note.taxRows).toEqual(invoice.taxRows);
    expect(await movementsOf(note.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          movementType: 'damage',
          quantity: -3,
          note: `Damaged on return ${whole.number}`,
        }),
      ]),
    );
    expect(ok(await api(b.owner).get(`/sales-returns/${whole.id}`)).json()).toEqual(whole);
  });

  it('refuses lines of another invoice, drafts, cancelled invoices and notes', async () => {
    const invoice = await issued({ lines: [line(b.variants.apex1)] });
    const other = await issued({ lines: [line(b.variants.apex1)] });
    const stranger = await returnGoods({
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(other, 1), quantity: 1, disposition: 'restock' }],
    });
    expect(stranger.statusCode).toBe(400);
    expect(issuesOf(stranger)).toEqual(['lines.0.invoiceLineId']);
    expect(
      issuesOf(
        await returnGoods({
          invoiceId: invoice.id,
          lines: [
            { invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' },
            { invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' },
          ],
        }),
      ),
    ).toEqual(['lines']);
    // Two units of a line sold once: one to stock, one to damage, is still too many.
    const twice = await returnGoods({
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' },
        { invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'damage' },
      ],
    });
    expect(issuesOf(twice)).toEqual(['lines.0.quantity', 'lines.1.quantity']);
    expect(twice.json()).toMatchObject({
      issues: [{ message: 'At most 1 of line 1 can come back' }, expect.anything()],
    });

    const draft = ok(
      await api(b.owner).post('/invoices', {
        storeId: b.stores.amp,
        lines: [line(b.variants.apex1)],
      }),
    ).json<TaxDocumentView>();
    const drafted = await returnGoods({
      invoiceId: draft.id,
      lines: [{ invoiceLineId: lineId(draft, 1), quantity: 1, disposition: 'restock' }],
    });
    expect(drafted.statusCode).toBe(409);
    expect(messageOf(drafted)).toBe('Only an issued invoice takes notes; this one is draft');

    const cancelled = await issued({ lines: [line(b.variants.apex1)] });
    ok(await api(b.owner).post(`/invoices/${cancelled.id}/cancel`, { reason: 'Typed wrong' }));
    expect(
      (
        await returnGoods({
          invoiceId: cancelled.id,
          lines: [{ invoiceLineId: lineId(cancelled, 1), quantity: 1, disposition: 'restock' }],
        })
      ).statusCode,
    ).toBe(409);

    const { creditNote } = await returned({
      invoiceId: other.id,
      lines: [{ invoiceLineId: lineId(other, 1), quantity: 1, disposition: 'restock' }],
    });
    const ofNote = await returnGoods({
      invoiceId: creditNote.id,
      lines: [{ invoiceLineId: creditNote.lines[0]?.id, quantity: 1, disposition: 'restock' }],
    });
    expect(ofNote.statusCode).toBe(400);
    expect(issuesOf(ofNote)).toEqual(['invoiceId']);
    expect((await returnGoods({ invoiceId: invoice.id, lines: [] })).statusCode).toBe(400);
  });

  it('takes back a bill of supply without tax, numbered in the composition store’s series', async () => {
    const bill = await issued({ storeId: b.stores.sec, lines: [line(b.variants.apex1, 2)] });
    expect(bill.kind).toBe('bill_of_supply');
    const { creditNote } = await returned({
      invoiceId: bill.id,
      lines: [{ invoiceLineId: lineId(bill, 1), quantity: 1, disposition: 'restock' }],
    });
    expect(creditNote).toMatchObject({
      number: `SECC/${financialYear(today).slice(2)}/00001`,
      taxablePaise: 11_800,
      cgstPaise: 0,
      sgstPaise: 0,
      totalPaise: 11_800,
      taxRows: [],
    });
    expect(creditNote.lines[0]?.rateBps).toBeNull();
    const debit = await api(b.owner).post('/debit-notes', {
      invoiceId: bill.id,
      lines: [{ invoiceLineId: lineId(bill, 1), valuePaise: 100 }],
    });
    expect(debit.statusCode).toBe(409);
    expect(messageOf(debit)).toMatch(/composition store/);
  });

  it('returns free goods without a ledger entry', async () => {
    const free = await issued({ lines: [line(b.variants.card, 5)] });
    expect(free.totalPaise).toBe(0);
    const { creditNote } = await returned({
      invoiceId: free.id,
      lines: [{ invoiceLineId: lineId(free, 1), quantity: 5, disposition: 'restock' }],
    });
    expect(creditNote.totalPaise).toBe(0);
    expect(creditNote.number).not.toBeNull();
    expect(await ledgerOf(creditNote.id)).toEqual([]);
  });
});

describe('credit and debit notes', () => {
  it('credits a discount under a scheme, at the invoice rate, inclusive by default', async () => {
    const invoice = await issued({
      partyId: b.parties.dealer,
      lines: [line(b.variants.apex1, 10), line(b.variants.brush, 4)],
    });
    expect(invoice.gstClass).toBe('b2b');
    const noScheme = await api(b.owner).post('/credit-notes', {
      invoiceId: invoice.id,
      reason: 'discount',
      lines: [{ invoiceLineId: lineId(invoice, 1), valuePaise: 118_00 }],
    });
    expect(issuesOf(noScheme)).toEqual(['schemeReference']);

    const balanceBefore = await balanceOf(b.parties.dealer);
    const stockBefore = await onHand(b.stores.amp, b.variants.apex1);
    const discount = ok(
      await api(b.owner).post('/credit-notes', {
        invoiceId: invoice.id,
        reason: 'discount',
        schemeReference: 'Diwali 2026 volume scheme',
        lines: [{ invoiceLineId: lineId(invoice, 1), valuePaise: 118_00 }],
      }),
    ).json<NoteView>();
    expect(discount).toMatchObject({
      kind: 'credit_note',
      reason: 'discount',
      schemeReference: 'Diwali 2026 volume scheme',
      note: null,
      taxablePaise: 100_00,
      cgstPaise: 9_00,
      sgstPaise: 9_00,
      totalPaise: 118_00,
      gstClass: 'b2b',
      // s.34(2) proviso: the dealer must reverse the input credit first.
      itcReversalStatus: 'unknown',
      salesReturnId: null,
    });
    expect(discount.lines).toEqual([
      expect.objectContaining({
        sourceLineId: lineId(invoice, 1),
        quantity: 10,
        unitPricePaise: 0,
        taxablePaise: 100_00,
      }),
    ]);
    expect(await onHand(b.stores.amp, b.variants.apex1)).toBe(stockBefore);
    expect(await movementsOf(discount.id)).toEqual([]);
    expect(await balanceOf(b.parties.dealer)).toBe(balanceBefore - 118_00);

    // Exclusive values, and an overcharge with a note.
    const overcharge = ok(
      await api(b.owner).post('/credit-notes', {
        invoiceId: invoice.id,
        reason: 'overcharge',
        valueIncludesTax: false,
        note: 'Billed at the old price',
        lines: [
          { invoiceLineId: lineId(invoice, 2), valuePaise: 1_00 },
          { invoiceLineId: lineId(invoice, 1), valuePaise: 50_00 },
        ],
      }),
    ).json<NoteView>();
    expect(overcharge).toMatchObject({
      note: 'Billed at the old price',
      taxablePaise: 51_00,
      cgstPaise: 4_59,
      sgstPaise: 4_59,
      roundOffPaise: -18,
      totalPaise: 60_00,
    });
    expect(serialOf(overcharge.number)).toBe(serialOf(discount.number) + 1);

    // Never more than the line was charged: the rollers' taxable value is what is left.
    const rollers = invoice.lines[1]?.taxablePaise ?? 0;
    const tooMuch = await api(b.owner).post('/credit-notes', {
      invoiceId: invoice.id,
      reason: 'deficient',
      valueIncludesTax: false,
      lines: [{ invoiceLineId: lineId(invoice, 2), valuePaise: rollers }],
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json()).toMatchObject({
      message: 'This would credit more than was charged',
      issues: [
        {
          path: 'lines.0.valuePaise',
          message: `Line 2 has ${String(rollers - 1_00)} paise of taxable value left to credit`,
        },
      ],
    });

    // A debit note for an undercharge raises the balance and makes room for more credit.
    const debit = ok(
      await api(b.owner).post('/debit-notes', {
        invoiceId: invoice.id,
        valueIncludesTax: false,
        lines: [{ invoiceLineId: lineId(invoice, 2), valuePaise: 1_00 }],
      }),
    ).json<NoteView>();
    expect(debit).toMatchObject({
      kind: 'debit_note',
      reason: 'undercharge',
      itcReversalStatus: null,
      note: null,
      taxablePaise: 1_00,
      cgstPaise: 9,
      sgstPaise: 9,
      totalPaise: 1_00,
      roundOffPaise: -18,
    });
    expect(debit.number).toMatch(new RegExp(`^AMPD/${financialYear(today).slice(2)}/\\d{5}$`));
    expect(await ledgerOf(debit.id)).toEqual([{ entryType: 'debit_note', amountPaise: 1_00 }]);
    ok(
      await api(b.owner).post('/credit-notes', {
        invoiceId: invoice.id,
        reason: 'deficient',
        valueIncludesTax: false,
        lines: [{ invoiceLineId: lineId(invoice, 2), valuePaise: rollers }],
      }),
    );
    // A return now would credit the rollers twice.
    const back = await returnGoods({
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 2), quantity: 4, disposition: 'restock' }],
    });
    expect(back.statusCode).toBe(422);
    expect(issuesOf(back)).toEqual(['lines.0.quantity']);

    const adjustments = ok(
      await api(b.owner).get(`/invoices/${invoice.id}/adjustments`),
    ).json<InvoiceAdjustments>();
    expect(adjustments.lines[1]).toMatchObject({
      creditedTaxablePaise: rollers + 1_00,
      debitedTaxablePaise: 1_00,
      returnedQuantity: 0,
    });
    expect(adjustments.notes.map((note) => note.kind)).toEqual([
      'credit_note',
      'credit_note',
      'debit_note',
      'credit_note',
    ]);
  });

  it('pays what is due on the invoice, and keeps the rest as the party’s advance', async () => {
    const modes = ok(await api(b.owner).get('/payment-modes')).json<
      { id: string; kind: string }[]
    >();
    const upi = String(modes.find((mode) => mode.kind === 'upi')?.id);
    const pay = async (invoice: TaxDocumentView, amountPaise: number) =>
      ok(
        await api(b.owner).post('/payments', {
          storeId: b.stores.amp,
          partyId: b.parties.apCustomer,
          modeId: upi,
          amountPaise,
          reference: `UTR${invoice.id.slice(0, 8)}`,
          allocations: [{ documentId: invoice.id, amountPaise }],
        }),
      );
    const advanceOf = async () => {
      const [row] = await t.connection.db
        .select({ advance: partyBalances.advancePaise })
        .from(partyBalances)
        .where(eq(partyBalances.partyId, b.parties.apCustomer));
      return Number(row?.advance);
    };
    const allocatedFrom = (noteId: string) =>
      t.connection.db
        .select({
          documentId: schema.allocations.documentId,
          amount: schema.allocations.amountPaise,
        })
        .from(schema.allocations)
        .where(eq(schema.allocations.creditNoteId, noteId));

    // Unpaid: the whole note settles the invoice.
    const unpaid = await issued({
      partyId: b.parties.apCustomer,
      lines: [line(b.variants.apex1, 2)],
    });
    const before = await advanceOf();
    const first = await returned({
      invoiceId: unpaid.id,
      lines: [{ invoiceLineId: lineId(unpaid, 1), quantity: 1, disposition: 'restock' }],
    });
    expect(await allocatedFrom(first.creditNote.id)).toEqual([
      { documentId: unpaid.id, amount: first.creditNote.totalPaise },
    ]);
    expect(await advanceOf()).toBe(before);

    // Paid but for ₹50: ₹50 settles it, the rest is an advance.
    const paid = await issued({
      partyId: b.parties.apCustomer,
      lines: [line(b.variants.apex1, 2)],
    });
    await pay(paid, paid.totalPaise - 50_00);
    const second = await returned({
      invoiceId: paid.id,
      lines: [{ invoiceLineId: lineId(paid, 1), quantity: 2, disposition: 'restock' }],
    });
    expect(await allocatedFrom(second.creditNote.id)).toEqual([
      { documentId: paid.id, amount: 50_00 },
    ]);
    expect(await advanceOf()).toBe(before + second.creditNote.totalPaise - 50_00);

    // Fully paid: all of it is an advance.
    const full = await issued({
      partyId: b.parties.apCustomer,
      lines: [line(b.variants.apex1, 1)],
    });
    await pay(full, full.totalPaise);
    const third = ok(
      await api(b.owner).post('/credit-notes', {
        invoiceId: full.id,
        reason: 'overcharge',
        lines: [{ invoiceLineId: lineId(full, 1), valuePaise: 10_00 }],
      }),
    ).json<NoteView>();
    expect(await allocatedFrom(third.id)).toEqual([]);
    expect(await advanceOf()).toBe(
      before + second.creditNote.totalPaise - 50_00 + third.totalPaise,
    );
    expect(await findAllocationMismatches(t.connection.db)).toEqual([]);
  });

  it('refuses unknown lines, nothing to adjust and a value of zero', async () => {
    const invoice = await issued({ lines: [line(b.variants.apex1)] });
    const other = await issued({ lines: [line(b.variants.apex1)] });
    expect(
      issuesOf(
        await api(b.owner).post('/debit-notes', {
          invoiceId: invoice.id,
          lines: [{ invoiceLineId: lineId(other, 1), valuePaise: 100 }],
        }),
      ),
    ).toEqual(['lines.0.invoiceLineId']);
    expect(
      issuesOf(
        await api(b.owner).post('/credit-notes', {
          invoiceId: invoice.id,
          reason: 'overcharge',
          lines: [
            { invoiceLineId: lineId(invoice, 1), valuePaise: 100 },
            { invoiceLineId: lineId(invoice, 1), valuePaise: 200 },
          ],
        }),
      ),
    ).toEqual(['lines']);
    expect(
      issuesOf(
        await api(b.owner).post('/credit-notes', {
          invoiceId: invoice.id,
          reason: 'return',
          lines: [{ invoiceLineId: lineId(invoice, 1), valuePaise: 0 }],
        }),
      ),
    ).toEqual(['lines.0.valuePaise', 'reason']);
  });

  it('numbers notes gap-free in each kind’s series, even when one is refused', async () => {
    const invoices = await Promise.all(
      Array.from({ length: 8 }, () =>
        issued({ storeId: b.stores.kkp, lines: [line(b.variants.brush, 2)] }),
      ),
    );
    const [firstInvoice] = invoices;
    if (!firstInvoice) throw new Error('Eight invoices were issued');
    const refused = await returnGoods({
      invoiceId: firstInvoice.id,
      lines: [{ invoiceLineId: lineId(firstInvoice, 1), quantity: 3, disposition: 'restock' }],
    });
    expect(refused.statusCode).toBe(422);
    const notes = await Promise.all(
      invoices.map((invoice) =>
        returned({
          invoiceId: invoice.id,
          lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
        }),
      ),
    );
    const serials = notes.map((n) => serialOf(n.creditNote.number)).sort((x, y) => x - y);
    expect(serials).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(notes.every((n) => n.creditNote.number?.startsWith('KKPC/'))).toBe(true);
    const returnSerials = notes.map((n) => Number(n.number.slice(3)));
    expect(Math.max(...returnSerials) - Math.min(...returnSerials)).toBe(7);
    expect(new Set(returnSerials).size).toBe(8);
  });
});

describe('time limit (s.34(2))', () => {
  it('refuses credit notes after 30 November of the next year, and allows debit notes', async () => {
    const invoice = await issued({ lines: [line(b.variants.apex1, 2)] });
    // Three years back: its credit-note window closed long ago.
    const issuedOn = await backDate(invoice.id, 3 * 366);
    const window = creditNoteWindow(issuedOn, today);
    expect(window.status).toBe('closed');
    const late = await returnGoods({
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
    });
    expect(late.statusCode).toBe(409);
    expect(messageOf(late)).toBe(
      `The last day for a credit note on this invoice was ${window.deadline} (s.34(2))`,
    );
    expect(
      (
        await api(b.owner).post('/credit-notes', {
          invoiceId: invoice.id,
          reason: 'overcharge',
          lines: [{ invoiceLineId: lineId(invoice, 1), valuePaise: 100 }],
        })
      ).statusCode,
    ).toBe(409);
    ok(
      await api(b.owner).post('/debit-notes', {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: lineId(invoice, 1), valuePaise: 100 }],
      }),
    );
    const adjustments = ok(
      await api(b.owner).get(`/invoices/${invoice.id}/adjustments`),
    ).json<InvoiceAdjustments>();
    expect(adjustments.creditNoteWindow).toEqual(window);
  });

  it('flags no window on a draft or a note', async () => {
    const draft = ok(
      await api(b.owner).post('/invoices', {
        storeId: b.stores.amp,
        lines: [line(b.variants.apex1)],
      }),
    ).json<TaxDocumentView>();
    const adjustments = ok(
      await api(b.owner).get(`/invoices/${draft.id}/adjustments`),
    ).json<InvoiceAdjustments>();
    expect(adjustments).toMatchObject({ creditNoteWindow: null, notes: [] });
    expect(adjustments.lines[0]).toMatchObject({ returnedQuantity: 0, creditedTaxablePaise: 0 });

    const invoice = await issued({ lines: [line(b.variants.apex1)] });
    const { creditNote } = await returned({
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
    });
    expect(
      ok(
        await api(b.owner).get(`/invoices/${creditNote.id}/adjustments`),
      ).json<InvoiceAdjustments>().creditNoteWindow,
    ).toBeNull();
  });
});

describe('immutability', () => {
  it('never changes or deletes an issued note, its lines or its link', async () => {
    const invoice = await issued({ lines: [line(b.variants.apex1, 2)] });
    const { creditNote } = await returned({
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
    });
    const db = t.connection.db;
    await expect(
      db.update(taxDocuments).set({ totalPaise: 1 }).where(eq(taxDocuments.id, creditNote.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(taxDocuments).where(eq(taxDocuments.id, creditNote.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(taxDocumentLines)
        .set({ quantity: 2 })
        .where(eq(taxDocumentLines.documentId, creditNote.id)),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`delete from tax_document_links where from_document_id = ${creditNote.id}`),
    ).rejects.toThrow();
    // The ITC reversal status is the one thing that may still change.
    await db
      .update(taxDocuments)
      .set({ itcReversalStatus: 'reversed' })
      .where(eq(taxDocuments.id, creditNote.id));
  });
});

describe('access', () => {
  it('needs the right to issue notes, the store, and the business', async () => {
    const invoice = await issued({ lines: [line(b.variants.apex1, 2)] });
    const body = {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
    };
    const sales = await b.member('sales_executive', [b.stores.amp]);
    expect((await returnGoods(body, sales)).statusCode).toBe(403);
    expect((await api(sales).get(`/invoices/${invoice.id}/adjustments`)).statusCode).toBe(200);
    const elsewhere = await b.member('branch_manager', [b.stores.kkp]);
    expect((await returnGoods(body, elsewhere)).statusCode).toBe(404);

    const mine = await returned(body);
    expect((await api(elsewhere).get(`/notes/${mine.creditNote.id}`)).statusCode).toBe(404);
    expect((await api(elsewhere).get(`/sales-returns/${mine.id}`)).statusCode).toBe(404);
    expect(ok(await api(elsewhere).get(`/notes?invoiceId=${invoice.id}`)).json<NotePage>()).toEqual(
      { items: [], total: 0 },
    );

    const other = await business();
    const o = api(other.owner);
    expect((await o.get(`/notes/${mine.creditNote.id}`)).statusCode).toBe(404);
    expect((await o.get(`/sales-returns/${mine.id}`)).statusCode).toBe(404);
    expect((await o.get(`/invoices/${invoice.id}/adjustments`)).statusCode).toBe(404);
    expect((await returnGoods(body, other.owner)).statusCode).toBe(404);
    expect(ok(await o.get('/notes')).json<NotePage>().total).toBe(0);
    // Their own invoice cannot be returned with our lines.
    const theirs = await issued(
      {
        storeId: other.stores.amp,
        partyId: other.parties.customer,
        lines: [line(other.variants.apex1)],
      },
      other.owner,
    );
    expect(
      issuesOf(
        await returnGoods(
          {
            invoiceId: theirs.id,
            lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
          },
          other.owner,
        ),
      ),
    ).toEqual(['lines.0.invoiceLineId']);
  });
});

describe('reading', () => {
  it('lists notes by invoice, kind, store and party, and shows one', async () => {
    const invoice = await issued({
      storeId: b.stores.kkp,
      partyId: b.parties.dealer,
      lines: [line(b.variants.apex1, 4)],
    });
    const credit = (
      await returned({
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
      })
    ).creditNote;
    const debit = ok(
      await api(b.owner).post('/debit-notes', {
        invoiceId: invoice.id,
        lines: [{ invoiceLineId: lineId(invoice, 1), valuePaise: 500 }],
      }),
    ).json<NoteView>();
    const page = (query: string) =>
      api(b.owner)
        .get(`/notes?${query}`)
        .then((reply) => ok(reply).json<NotePage>());
    expect(await page(`invoiceId=${invoice.id}`)).toEqual({
      items: [
        {
          id: debit.id,
          kind: 'debit_note',
          status: 'issued',
          storeId: b.stores.kkp,
          number: debit.number,
          issuedOn: today,
          reason: 'undercharge',
          buyerName: 'Deccan Interiors',
          totalPaise: debit.totalPaise,
          itcReversalStatus: null,
          invoice: { id: invoice.id, number: invoice.number },
        },
        expect.objectContaining({ id: credit.id, itcReversalStatus: 'unknown', reason: 'return' }),
      ],
      total: 2,
    });
    expect((await page(`invoiceId=${invoice.id}&kind=credit_note`)).items.map((n) => n.id)).toEqual(
      [credit.id],
    );
    expect(
      (await page(`storeId=${b.stores.kkp}&partyId=${b.parties.dealer}&limit=1&offset=1`)).items,
    ).toHaveLength(1);
    expect(ok(await api(b.owner).get(`/notes/${debit.id}`)).json()).toEqual(debit);
    // The invoice list can leave notes out.
    const sales = ok(
      await api(b.owner).get(`/invoices?storeId=${b.stores.kkp}&kinds=invoice,bill_of_supply`),
    ).json<{ items: { kind: string }[] }>();
    expect(new Set(sales.items.map((item) => item.kind))).toEqual(new Set(['invoice']));
    expect((await api(b.owner).get('/invoices?kinds=receipt')).statusCode).toBe(400);
    expect((await api(b.owner).get(`/notes/${invoice.id}`)).statusCode).toBe(404);
    expect(
      (await api(b.owner).get('/sales-returns/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
  });

  it('answers a repeated return with the first one, and keeps every balance equal to its ledger', async () => {
    const invoice = await issued({ lines: [line(b.variants.apex1, 2)] });
    const body = {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), quantity: 1, disposition: 'restock' }],
    };
    const key = { 'idempotency-key': `return-${invoice.id}` };
    const first = ok(await returnGoods(body, b.owner, key)).json<SalesReturnView>();
    const again = ok(await returnGoods(body, b.owner, key)).json<SalesReturnView>();
    expect(again).toEqual(first);
    const adjustments = ok(
      await api(b.owner).get(`/invoices/${invoice.id}/adjustments`),
    ).json<InvoiceAdjustments>();
    expect(adjustments.lines[0]?.returnedQuantity).toBe(1);
    const credit = (path: string, payload: object) =>
      api(b.owner, { 'idempotency-key': `${path}-${invoice.id}` }).post(path, payload);
    const valueBody = {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: lineId(invoice, 1), valuePaise: 100 }],
    };
    const c1 = ok(
      await credit('/credit-notes', { ...valueBody, reason: 'overcharge' }),
    ).json<NoteView>();
    expect(
      ok(await credit('/credit-notes', { ...valueBody, reason: 'overcharge' })).json(),
    ).toEqual(c1);
    const d1 = ok(await credit('/debit-notes', valueBody)).json<NoteView>();
    expect(ok(await credit('/debit-notes', valueBody)).json()).toEqual(d1);

    expect(await findPartyBalanceMismatches(t.connection.db)).toEqual([]);
    expect(await findAllocationMismatches(t.connection.db)).toEqual([]);
    expect(await findStockMismatches(t.connection.db)).toEqual([]);
    // §4.6: the balance is invoices − credit notes + debit notes (no payments yet).
    const [totals] = await t.connection.db
      .select({
        balance:
          sql<number>`sum(case ${taxDocuments.kind} when 'credit_note' then -${taxDocuments.totalPaise} else ${taxDocuments.totalPaise} end)`.mapWith(
            Number,
          ),
      })
      .from(taxDocuments)
      .where(and(eq(taxDocuments.partyId, b.parties.customer), eq(taxDocuments.status, 'issued')));
    expect(await balanceOf(b.parties.customer)).toBe(totals?.balance);
  });
});
