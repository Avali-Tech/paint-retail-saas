import { migrateDatabase, schema } from '@paint/db';
import type { AuthProfile, InboxView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  api,
  billingBusiness,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

/**
 * The inbox reads seven queues for every member, and the badge asks for its
 * count every minute: neither may run more queries as the queues grow. An N+1
 * would show as a query count before it shows as time (as in
 * receivables-scale.int.test.ts).
 */

const { collectionEscalations, promisesToPay } = schema;
const DAY = 86_400_000;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let manager: string;
let ownerMemberId: string;
let managerMemberId: string;
let brandId: string;
let paints: string;
let batch = 0;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  manager = await b.member('branch_manager', [b.stores.amp]);
  ownerMemberId = ok(await api(t, b.owner).get('/auth/me')).json<AuthProfile>().memberId;
  managerMemberId = ok(await api(t, manager).get('/auth/me')).json<AuthProfile>().memberId;
  ok(await api(t, b.owner).post('/sales/go-live', {}));
  brandId = ok(await api(t, b.owner).post('/brands', { name: 'Shades' })).json<{ id: string }>().id;
  const options = ok(await api(t, b.owner).get('/tax-categories/options')).json<{
    categories: { id: string; key: string }[];
  }>();
  paints = String(options.categories.find((category) => category.key === 'paints')?.id);
  await grow(1);
}, 300_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

/** `size` more items of every kind waiting on the owner (and the Ameerpet manager). */
async function grow(size: number) {
  batch += 1;
  const owner = api(t, b.owner);
  for (let n = 0; n < size; n += 1) {
    const tag = `${String(batch)}-${String(n)}`;
    const partyId = ok(
      await owner.post('/parties', {
        displayName: `Customer ${tag}`,
        phone: uniquePhone(),
        roles: ['customer'],
        homeStoreId: b.stores.amp,
      }),
    ).json<{ id: string }>().id;
    // A credit request, and a limit for a sale past it the manager asks the owner about.
    ok(await owner.post('/credit-requests', { partyId, limitPaise: 100_000, creditDays: 30 }));
    const contractor = ok(
      await owner.post('/parties', {
        displayName: `Contractor ${tag}`,
        phone: uniquePhone(),
        roles: ['contractor'],
        homeStoreId: b.stores.amp,
      }),
    ).json<{ id: string }>().id;
    const request = ok(
      await owner.post('/credit-requests', {
        partyId: contractor,
        limitPaise: 100_000,
        creditDays: 30,
      }),
    ).json<{ id: string }>();
    ok(await owner.post(`/credit-requests/${request.id}/approve`, {}));
    const draft = await b.draft(
      {
        partyId: contractor,
        lines: [{ variantId: b.apex, quantity: 1, unitPricePaise: 200_000 }],
      },
      manager,
    );
    ok(
      await api(t, manager).post('/credit-approvals', {
        invoiceId: draft.id,
        amountPaise: 200_000,
        reason: 'Big order',
      }),
    );
    // A transfer to approve, a follow-up due, a broken promise.
    ok(
      await owner.post('/transfers', {
        fromStoreId: b.stores.amp,
        toStoreId: b.stores.kkp,
        lines: [{ variantId: b.apex, quantity: 1 }],
      }),
    );
    for (const memberId of [ownerMemberId, managerMemberId]) {
      ok(
        await owner.post('/activities', {
          recordType: 'party',
          recordId: partyId,
          type: 'call',
          subject: `Call ${tag}`,
          dueAt: new Date(Date.now() - DAY).toISOString(),
          assignedMemberId: memberId,
        }),
      );
    }
    // As the morning run leaves it (that runs once a day).
    const [promise] = await t.connection.db
      .insert(promisesToPay)
      .values({
        organizationId: b.organizationId,
        partyId,
        amountPaise: 50_000,
        madeOn: new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10),
        promisedOn: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10),
        status: 'broken',
        paidPaise: 0,
        closedAt: new Date(),
        createdByMemberId: ownerMemberId,
      })
      .returning({ id: promisesToPay.id });
    await t.connection.db.insert(collectionEscalations).values({
      organizationId: b.organizationId,
      partyId,
      promiseId: String(promise?.id),
      notifiedCount: 1,
    });
  }
  // Low stock: a product per item, every one below its minimum at both stores.
  const product = ok(
    await owner.post('/products', {
      brandId,
      name: `Shade ${String(batch)}`,
      type: 'interior_paint',
      hsnCode: '32091090',
      taxCategoryId: paints,
      variants: Array.from({ length: size }, (_, n) => ({
        sku: `SH-${String(batch)}-${String(n)}`,
        packSize: n + 1,
        unit: 'l',
        sellingPricePaise: 10_000,
      })),
    }),
  ).json<{ variants: { id: string }[] }>();
  ok(
    await owner.put('/reorder-rules', {
      rules: product.variants.flatMap((variant) =>
        [b.stores.amp, b.stores.kkp].map((storeId) => ({
          storeId,
          variantId: variant.id,
          minQuantity: 5,
          reorderLevel: 10,
          maxQuantity: 20,
        })),
      ),
    }),
  );
}

/** The fewest queries of three calls (after one to warm up), and the median time of five. */
async function measure(url: string, token: string): Promise<{ ms: number; queries: number }> {
  const call = async () => ok(await api(t, token).get(url));
  await call();
  const counts: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    await call();
    counts.push(spy.mock.calls.length);
    spy.mockRestore();
  }
  const times: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const start = performance.now();
    await call();
    times.push(performance.now() - start);
  }
  return {
    ms: Math.round(times.sort((x, y) => x - y)[2] ?? 0),
    queries: Math.min(...counts),
  };
}

describe('the inbox as its queues grow', { timeout: 300_000 }, () => {
  it('runs the same number of queries for 1 item of each kind as for 40', async () => {
    const small = {
      owner: await measure('/inbox', b.owner),
      manager: await measure('/inbox', manager),
      count: await measure('/inbox/count', b.owner),
    };
    const before = ok(await api(t, b.owner).get('/inbox')).json<InboxView>();
    await grow(39);
    const after = ok(await api(t, b.owner).get('/inbox')).json<InboxView>();
    // Every kind did grow (the owner decides credit requests; the manager asked for the sales).
    for (const kind of ['credit_approval', 'credit_request', 'transfer', 'escalation'] as const) {
      const was = before.groups.find((entry) => entry.kind === kind)?.total ?? 0;
      const now = after.groups.find((entry) => entry.kind === kind)?.total ?? 0;
      expect({ kind, grew: now >= was + 39 }).toEqual({ kind, grew: true });
    }
    const large = {
      owner: await measure('/inbox', b.owner),
      manager: await measure('/inbox', manager),
      count: await measure('/inbox/count', b.owner),
    };
    expect(large.owner.queries).toBe(small.owner.queries);
    expect(large.manager.queries).toBe(small.manager.queries);
    expect(large.count.queries).toBe(small.count.queries);
    expect(large.owner.ms).toBeLessThan(3_000);
    expect(large.count.ms).toBeLessThan(2_000);
  });
});
