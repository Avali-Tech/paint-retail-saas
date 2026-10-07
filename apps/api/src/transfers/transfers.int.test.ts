import { findStockMismatches, migrateDatabase, schema } from '@paint/db';
import { and, eq } from 'drizzle-orm';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Line {
  variantId: string;
  sku: string;
  requestedQuantity: number;
  approvedQuantity: number | null;
  dispatchedQuantity: number | null;
  receivedQuantity: number | null;
  damagedQuantity: number | null;
  shortQuantity: number | null;
  unitCostPaise: number | null;
  availableAtSource: number;
}
interface Transfer {
  id: string;
  number: string;
  status: string;
  from: { code: string };
  to: { code: string };
  closingReason: string | null;
  approvedAt: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  lines: Line[];
}
interface StockRow {
  store: { code: string };
  variant: { id: string };
  onHand: number;
  avgCostPaise: number | null;
}

let database: TestDatabase;
let t: TestApp;
let owner: string;
let hydManager: string;
let puneManager: string;
let hyd: string;
let pune: string;
let sec: string;
let seq = 0;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
});

async function signup(name: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  return response.json<{ token: string }>().token;
}

async function hire(roleKey: string, storeIds: string[]): Promise<string> {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await api(owner).post('/members', {
    fullName: `Staff ${roleKey}`,
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    storeIds,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

/** A new product with two variants, stocked at Pune: 20 × A at ₹100, 5 × B without cost. */
async function stockedAtPune(): Promise<{ a: string; b: string; skuA: string; skuB: string }> {
  seq += 1;
  const brandId = (await api(owner).post('/brands', { name: `T Brand ${String(seq)}` })).json<{
    id: string;
  }>().id;
  const product = (
    await api(owner).post('/products', {
      brandId,
      name: `T Product ${String(seq)}`,
      type: 'interior_paint',
      hsnCode: '3209',
      variants: [
        { sku: `T${String(seq)}-A`, packSize: 1, unit: 'l' },
        { sku: `T${String(seq)}-B`, packSize: 4, unit: 'l' },
      ],
    })
  ).json<{ variants: { id: string; sku: string }[] }>();
  const [a, b] = product.variants;
  await api(owner).post('/stock/movements', {
    storeId: pune,
    type: 'opening',
    lines: [
      { variantId: a?.id, quantity: 20, unitCostPaise: 10_000 },
      { variantId: b?.id, quantity: 5 },
    ],
  });
  return { a: a?.id ?? '', b: b?.id ?? '', skuA: a?.sku ?? '', skuB: b?.sku ?? '' };
}

const request = async (lines: { variantId: string; quantity: number }[], token = hydManager) =>
  api(token).post('/transfers', { fromStoreId: pune, toStoreId: hyd, lines });

async function stockAt(store: string, variantId: string): Promise<StockRow | undefined> {
  const page = (await api(owner).get(`/stock?storeId=${store}&limit=200`)).json<{
    items: StockRow[];
  }>();
  return page.items.find((row) => row.variant.id === variantId);
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyd = (
    await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD', gstin: '36AABCU9603R1ZO' })
  ).json<{ id: string }>().id;
  pune = (
    await api(owner).post('/stores', { name: 'Pune', code: 'PUN', gstin: '27AAPFU0939F1ZV' })
  ).json<{ id: string }>().id;
  sec = (
    await api(owner).post('/stores', {
      name: 'Secunderabad',
      code: 'SEC',
      gstin: '36AABCU9603R1ZO',
    })
  ).json<{ id: string }>().id;
  hydManager = await hire('branch_manager', [hyd]);
  puneManager = await hire('branch_manager', [pune]);
});

afterAll(async () => {
  expect(await findStockMismatches(t.connection.db)).toEqual([]);
  await t.close();
  await database.stop();
});

describe('the full journey: request, approve, dispatch, receive', () => {
  it('moves stock from Pune to Hyderabad, keeping its cost, with a challan', async () => {
    const { a, b, skuA, skuB } = await stockedAtPune();

    const requested = await request([
      { variantId: a, quantity: 10 },
      { variantId: b, quantity: 5 },
    ]);
    expect(requested.statusCode).toBe(201);
    const transfer = requested.json<Transfer>();
    expect(transfer).toMatchObject({
      status: 'requested',
      from: { code: 'PUN' },
      to: { code: 'HYD' },
    });
    expect(transfer.number).toMatch(/^TR-\d{6}$/);
    expect(transfer.lines.find((l) => l.sku === skuA)?.availableAtSource).toBe(20);

    const approved = (
      await api(puneManager).post(`/transfers/${transfer.id}/approve`, {
        lines: [
          { variantId: a, quantity: 8 },
          { variantId: b, quantity: 5 },
        ],
      })
    ).json<Transfer>();
    expect(approved.status).toBe('approved');
    expect(approved.lines.find((l) => l.sku === skuA)?.approvedQuantity).toBe(8);

    const dispatched = (
      await api(puneManager).post(`/transfers/${transfer.id}/dispatch`)
    ).json<Transfer>();
    expect(dispatched.status).toBe('in_transit');
    expect(dispatched.lines.find((l) => l.sku === skuA)).toMatchObject({
      dispatchedQuantity: 8,
      unitCostPaise: 10_000,
    });
    expect((await stockAt(pune, a))?.onHand).toBe(12);

    const challan = (await api(hydManager).get(`/transfers/${transfer.id}/challan`)).json<{
      requiresTaxInvoice: boolean;
      lines: { sku: string; quantity: number; hsnCode: string; valuePaise: number | null }[];
      totalValuePaise: number;
      from: { gstin: string };
    }>();
    expect(challan.requiresTaxInvoice).toBe(true);
    expect(challan.from.gstin).toBe('27AAPFU0939F1ZV');
    expect(challan.lines).toContainEqual({
      sku: skuA,
      description: expect.stringContaining('T Product'),
      hsnCode: '3209',
      quantity: 8,
      unitValuePaise: 10_000,
      valuePaise: 80_000,
    });
    expect(challan.lines.find((l) => l.sku === skuB)?.valuePaise).toBeNull();
    expect(challan.totalValuePaise).toBe(80_000);

    const received = (
      await api(hydManager).post(`/transfers/${transfer.id}/receive`, {
        note: 'Two cans dented, one missing',
        lines: [
          { variantId: a, received: 5, damaged: 2 },
          { variantId: b, received: 5 },
        ],
      })
    ).json<Transfer>();
    expect(received.status).toBe('received');
    expect(received.lines.find((l) => l.sku === skuA)).toMatchObject({
      receivedQuantity: 5,
      damagedQuantity: 2,
      shortQuantity: 1,
    });
    expect(await stockAt(hyd, a)).toMatchObject({ onHand: 5, avgCostPaise: 10_000 });
    expect((await stockAt(hyd, b))?.onHand).toBe(5);

    const ledger = (await api(owner).get(`/stock/ledger?storeId=${hyd}&variantId=${a}`)).json<{
      items: { movementType: string; quantity: number; note: string | null }[];
    }>();
    expect(ledger.items.map((e) => [e.movementType, e.quantity])).toEqual(
      expect.arrayContaining([
        ['transfer_in', 7],
        ['damage', -2],
      ]),
    );
  });

  it('takes the defaults: approve and dispatch everything, receive everything in good condition', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 3 }])).json<Transfer>();

    await api(puneManager).post(`/transfers/${id}/approve`);
    await api(puneManager).post(`/transfers/${id}/dispatch`);
    const received = (await api(hydManager).post(`/transfers/${id}/receive`)).json<Transfer>();

    expect(received.lines[0]).toMatchObject({
      receivedQuantity: 3,
      damagedQuantity: 0,
      shortQuantity: 0,
    });
    expect(received.dispatchedAt).not.toBeNull();
    expect(received.receivedAt).not.toBeNull();
  });

  it('numbers transfers one after another', async () => {
    const { a } = await stockedAtPune();
    const first = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>().number;
    const second = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>().number;

    expect(Number(second.slice(3))).toBe(Number(first.slice(3)) + 1);
  });

  it('marks same-GSTIN transfers as needing only a delivery challan', async () => {
    const { a } = await stockedAtPune();
    await api(owner).post('/stock/movements', {
      storeId: sec,
      type: 'opening',
      lines: [{ variantId: a, quantity: 2 }],
    });
    const { id } = (
      await api(owner).post('/transfers', {
        fromStoreId: sec,
        toStoreId: hyd,
        lines: [{ variantId: a, quantity: 1 }],
      })
    ).json<Transfer>();
    await api(owner).post(`/transfers/${id}/approve`);
    await api(owner).post(`/transfers/${id}/dispatch`);

    const challan = (await api(owner).get(`/transfers/${id}/challan`)).json<{
      requiresTaxInvoice: boolean;
    }>();

    expect(challan.requiresTaxInvoice).toBe(false);
  });
});

describe('who can do each step', () => {
  it('only the receiving store requests, only the sending store approves and dispatches, only the receiver receives', async () => {
    const { a } = await stockedAtPune();

    expect((await request([{ variantId: a, quantity: 1 }], puneManager)).statusCode).toBe(403);
    const { id } = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>();
    expect((await api(hydManager).post(`/transfers/${id}/approve`)).statusCode).toBe(403);
    await api(puneManager).post(`/transfers/${id}/approve`);
    expect((await api(hydManager).post(`/transfers/${id}/dispatch`)).statusCode).toBe(403);
    await api(puneManager).post(`/transfers/${id}/dispatch`);
    expect((await api(puneManager).post(`/transfers/${id}/receive`)).statusCode).toBe(403);
    expect((await api(hydManager).post(`/transfers/${id}/receive`)).statusCode).toBe(200);
  });

  it('hides transfers between other stores', async () => {
    const { a } = await stockedAtPune();
    await api(owner).post('/stock/movements', {
      storeId: sec,
      type: 'opening',
      lines: [{ variantId: a, quantity: 1 }],
    });
    const { id } = (
      await api(owner).post('/transfers', {
        fromStoreId: sec,
        toStoreId: pune,
        lines: [{ variantId: a, quantity: 1 }],
      })
    ).json<Transfer>();

    expect((await api(hydManager).get(`/transfers/${id}`)).statusCode).toBe(404);
    expect((await api(hydManager).post(`/transfers/${id}/approve`)).statusCode).toBe(404);
    expect((await api(puneManager).get(`/transfers/${id}`)).statusCode).toBe(200);
  });

  it('lets read-only staff view but not act', async () => {
    const employee = await hire('store_employee', [hyd]);
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>();

    expect((await api(employee).get(`/transfers/${id}`)).statusCode).toBe(200);
    expect((await request([{ variantId: a, quantity: 1 }], employee)).statusCode).toBe(403);
  });
});

describe('rejecting and cancelling', () => {
  it('the sending store can reject a request, with a reason', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>();

    const rejected = (
      await api(puneManager).post(`/transfers/${id}/reject`, { reason: 'Needed for a site order' })
    ).json<Transfer>();

    expect(rejected).toMatchObject({
      status: 'rejected',
      closingReason: 'Needed for a site order',
    });
    expect(rejected.closedAt).not.toBeNull();
    expect((await api(puneManager).post(`/transfers/${id}/approve`)).statusCode).toBe(409);
  });

  it('the requesting store can cancel before dispatch, but not after', async () => {
    const { a } = await stockedAtPune();
    const first = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>().id;
    const second = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>().id;
    await api(puneManager).post(`/transfers/${second}/approve`);
    await api(puneManager).post(`/transfers/${second}/dispatch`);

    expect(
      (
        await api(hydManager).post(`/transfers/${first}/cancel`, { reason: 'Ordered elsewhere' })
      ).json<Transfer>().status,
    ).toBe('cancelled');
    const late = await api(hydManager).post(`/transfers/${second}/cancel`, { reason: 'Too late' });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ message: string }>().message).toBe('This transfer is in transit');
  });

  it('answers 400 without a reason', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>();

    expect(
      (await api(puneManager).post(`/transfers/${id}/reject`, { reason: '' })).statusCode,
    ).toBe(400);
  });
});

describe('quantities', () => {
  it('cannot approve more than requested, or dispatch more than approved', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 2 }])).json<Transfer>();

    const overApproved = await api(puneManager).post(`/transfers/${id}/approve`, {
      lines: [{ variantId: a, quantity: 3 }],
    });
    await api(puneManager).post(`/transfers/${id}/approve`, {
      lines: [{ variantId: a, quantity: 1 }],
    });
    const overDispatched = await api(puneManager).post(`/transfers/${id}/dispatch`, {
      lines: [{ variantId: a, quantity: 2 }],
    });

    expect(overApproved.statusCode).toBe(400);
    expect(overDispatched.statusCode).toBe(400);
  });

  it('cannot approve or dispatch nothing', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 2 }])).json<Transfer>();

    expect(
      (
        await api(puneManager).post(`/transfers/${id}/approve`, {
          lines: [{ variantId: a, quantity: 0 }],
        })
      ).statusCode,
    ).toBe(400);
    await api(puneManager).post(`/transfers/${id}/approve`);
    expect(
      (
        await api(puneManager).post(`/transfers/${id}/dispatch`, {
          lines: [{ variantId: a, quantity: 0 }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('dispatches some products and not others', async () => {
    const { a, b, skuB } = await stockedAtPune();
    const { id } = (
      await request([
        { variantId: a, quantity: 1 },
        { variantId: b, quantity: 1 },
      ])
    ).json<Transfer>();
    await api(puneManager).post(`/transfers/${id}/approve`);

    const dispatched = (
      await api(puneManager).post(`/transfers/${id}/dispatch`, {
        lines: [
          { variantId: a, quantity: 1 },
          { variantId: b, quantity: 0 },
        ],
      })
    ).json<Transfer>();
    const received = (await api(hydManager).post(`/transfers/${id}/receive`)).json<Transfer>();

    expect(dispatched.lines.find((l) => l.sku === skuB)?.dispatchedQuantity).toBe(0);
    expect(received.lines.find((l) => l.sku === skuB)?.receivedQuantity).toBe(0);
  });

  it('refuses to dispatch more than the sending store has', async () => {
    const { a, skuA } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 25 }])).json<Transfer>();
    await api(puneManager).post(`/transfers/${id}/approve`);

    const response = await api(puneManager).post(`/transfers/${id}/dispatch`);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toBe(
      `Not enough stock of ${skuA} at the sending store`,
    );
    expect((await api(owner).get(`/transfers/${id}`)).json<Transfer>().status).toBe('approved');
  });

  it('leaves the transfer in transit when receiving fails unexpectedly', async () => {
    const { a } = await stockedAtPune();
    await api(owner).post('/stock/movements', {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: a, quantity: 1 }],
    });
    const { id } = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>();
    await api(puneManager).post(`/transfers/${id}/approve`);
    await api(puneManager).post(`/transfers/${id}/dispatch`);
    const balance = and(
      eq(schema.stockBalances.storeId, hyd),
      eq(schema.stockBalances.variantId, a),
    );
    // Push Hyderabad's balance to the column's limit so receiving overflows it.
    await t.connection.db
      .update(schema.stockBalances)
      .set({ onHand: 99_999_999_999 })
      .where(balance);
    try {
      const response = await api(hydManager).post(`/transfers/${id}/receive`);

      expect(response.statusCode).toBe(500);
      expect((await api(owner).get(`/transfers/${id}`)).json<Transfer>().status).toBe('in_transit');
    } finally {
      await t.connection.db.update(schema.stockBalances).set({ onHand: 1 }).where(balance);
    }
  });

  it('cannot receive more than was dispatched', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 2 }])).json<Transfer>();
    await api(puneManager).post(`/transfers/${id}/approve`);
    await api(puneManager).post(`/transfers/${id}/dispatch`);

    const response = await api(hydManager).post(`/transfers/${id}/receive`, {
      lines: [{ variantId: a, received: 2, damaged: 1 }],
    });

    expect(response.statusCode).toBe(400);
  });

  it.each(['approve', 'dispatch', 'receive'])(
    'must list every product exactly once to %s with quantities',
    async (step) => {
      const { a, b } = await stockedAtPune();
      const { id } = (
        await request([
          { variantId: a, quantity: 1 },
          { variantId: b, quantity: 1 },
        ])
      ).json<Transfer>();
      if (step !== 'approve') await api(puneManager).post(`/transfers/${id}/approve`);
      if (step === 'receive') await api(puneManager).post(`/transfers/${id}/dispatch`);
      const actor = step === 'receive' ? hydManager : puneManager;
      const line = (variantId: string) =>
        step === 'receive' ? { variantId, received: 1 } : { variantId, quantity: 1 };
      const stranger = '00000000-0000-4000-8000-000000000000';

      const missing = await api(actor).post(`/transfers/${id}/${step}`, { lines: [line(a)] });
      const wrong = await api(actor).post(`/transfers/${id}/${step}`, {
        lines: [line(a), line(stranger)],
      });

      expect(missing.statusCode).toBe(400);
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json<{ message: string }>().message).toBe(
        'List every product on the transfer, exactly once',
      );
    },
  );
});

describe('races', () => {
  it('dispatches only once when two people click at the same moment', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 2 }])).json<Transfer>();
    await api(puneManager).post(`/transfers/${id}/approve`);
    const before = (await stockAt(pune, a))?.onHand ?? 0;

    // Make the race deterministic: hold a lock on the transfer so both requests
    // read "approved" and then queue at the status update. When the lock is
    // released, one wins and the other finds the status already changed.
    const blocker = new pg.Client({ connectionString: database.connectionString });
    await blocker.connect();
    let results: Awaited<ReturnType<ReturnType<typeof api>['post']>>[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM transfers WHERE id = $1 FOR UPDATE', [id]);
      const racing = Promise.all([
        api(puneManager).post(`/transfers/${id}/dispatch`),
        api(owner).post(`/transfers/${id}/dispatch`),
      ]);
      await vi.waitFor(
        async () => {
          // Polled from a separate connection: inside the blocker's transaction
          // pg_stat_activity would keep returning its first snapshot.
          const waiting = await withPgClient(database.connectionString, (client) =>
            client.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            ),
          );
          expect((waiting.rows[0] as { n: number }).n).toBe(2);
        },
        { timeout: 10_000, interval: 50 },
      );
      await blocker.query('ROLLBACK');
      results = await racing;
    } finally {
      await blocker.end();
    }

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    expect(loser?.json<{ message: string }>().message).toBe(
      'Someone else just changed this transfer; reload it',
    );
    expect((await stockAt(pune, a))?.onHand).toBe(before - 2);
  });
});

describe('requests', () => {
  it.each([
    [{ toStoreId: 'PUNE' }, 'toStoreId'],
    [{ lines: [] }, 'lines'],
    [{ lines: [{ quantity: 0 }] }, 'lines.0.quantity'],
    [{ lines: [{ quantity: 1 }, { quantity: 1 }] }, 'lines.1.variantId'],
  ])('answers 400 for %o', async (overrides, field) => {
    const { a } = await stockedAtPune();
    const body = {
      fromStoreId: pune,
      toStoreId: hyd,
      lines: [{ variantId: a, quantity: 1 }],
      ...overrides,
    };
    if (body.toStoreId === 'PUNE') body.toStoreId = pune;
    body.lines = body.lines.map((line) => ({ variantId: a, ...line }));

    const response = await api(owner).post('/transfers', body);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it('refuses unknown stores and products', async () => {
    const { a } = await stockedAtPune();
    const ghost = '00000000-0000-4000-8000-000000000000';

    expect(
      (
        await api(owner).post('/transfers', {
          fromStoreId: ghost,
          toStoreId: hyd,
          lines: [{ variantId: a, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(owner).post('/transfers', {
          fromStoreId: pune,
          toStoreId: hyd,
          lines: [{ variantId: ghost, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('answers 409 for a challan before dispatch, and 404 for an unknown transfer', async () => {
    const { a } = await stockedAtPune();
    const { id } = (await request([{ variantId: a, quantity: 1 }])).json<Transfer>();

    expect((await api(owner).get(`/transfers/${id}/challan`)).statusCode).toBe(409);
    expect(
      (await api(owner).get('/transfers/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
  });
});

describe('GET /transfers', () => {
  it('lists newest first and filters by status, direction and store', async () => {
    const token = await signup('List Paints');
    const make = async (code: string) =>
      (await api(token).post('/stores', { name: code, code })).json<{ id: string }>().id;
    const x = await make('XX');
    const y = await make('YY');
    const z = await make('ZZ');
    const brandId = (await api(token).post('/brands', { name: 'L Brand' })).json<{ id: string }>()
      .id;
    const variantId = (
      await api(token).post('/products', {
        brandId,
        name: 'L Product',
        type: 'primer',
        hsnCode: '3209',
        variants: [{ sku: 'L-1', packSize: 1, unit: 'l' }],
      })
    ).json<{ variants: { id: string }[] }>().variants[0]?.id;
    const transfer = (from: string, to: string) =>
      api(token).post('/transfers', {
        fromStoreId: from,
        toStoreId: to,
        lines: [{ variantId, quantity: 1 }],
      });
    const first = (await transfer(x, y)).json<Transfer>();
    await transfer(y, z);
    const third = (await transfer(z, x)).json<Transfer>();
    await api(token).post(`/transfers/${first.id}/reject`, { reason: 'Not now' });

    const numbers = async (query: string) =>
      (await api(token).get(`/transfers${query}`)).json<{
        items: { number: string }[];
        total: number;
      }>();

    expect((await numbers('')).items.map((i) => i.number)).toEqual([
      third.number,
      'TR-000002',
      first.number,
    ]);
    expect((await numbers('?status=rejected')).items.map((i) => i.number)).toEqual([first.number]);
    expect((await numbers(`?storeId=${x}`)).total).toBe(2);
    expect((await numbers(`?storeId=${x}&direction=incoming`)).items.map((i) => i.number)).toEqual([
      third.number,
    ]);
    expect((await numbers(`?storeId=${x}&direction=outgoing`)).items.map((i) => i.number)).toEqual([
      first.number,
    ]);
    expect((await numbers('?direction=incoming')).total).toBe(3);
    expect((await numbers('?limit=1')).items).toHaveLength(1);
  });

  it('shows store staff only their stores’ transfers, by direction too', async () => {
    const { a } = await stockedAtPune();
    await request([{ variantId: a, quantity: 1 }]);

    const incoming = (await api(hydManager).get('/transfers?direction=incoming')).json<{
      items: Transfer[];
    }>();
    const outgoing = (await api(hydManager).get('/transfers?direction=outgoing')).json<{
      items: Transfer[];
    }>();
    const all = (await api(hydManager).get('/transfers')).json<{ items: Transfer[] }>();

    expect(incoming.items.every((item) => item.to.code === 'HYD')).toBe(true);
    expect(incoming.items.length).toBeGreaterThan(0);
    expect(outgoing.items).toEqual([]);
    expect(all.items.every((item) => item.to.code === 'HYD' || item.from.code === 'HYD')).toBe(
      true,
    );
    expect((await api(hydManager).get(`/transfers?storeId=${pune}`)).statusCode).toBe(404);
  });
});

describe('another business', () => {
  it('cannot see ABC Paints’ transfers', async () => {
    const rival = await signup('Rival Paints');

    expect((await api(rival).get('/transfers')).json<{ items: Transfer[] }>().items).toEqual([]);
  });
});
