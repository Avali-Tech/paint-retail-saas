import { migrateDatabase, postStockMovements, schema, withTenant } from '@paint/db';
import type { TaxCategoryOptions } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';
import { Notifier } from './notifier.js';
import { SLOW_MOVER_NOTICE_LINES, alertSlowMovers } from './slow-mover-alerts.js';

const { notifications } = schema;

let database: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

const check = () => alertSlowMovers(t.connection.db, t.app.get(Notifier));

/** Moves a product's stock history at a store `days` into the past (the ledger refuses edits). */
async function age(storeId: string, variantId: string, days: number): Promise<void> {
  await t.connection.db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = 'replica'`);
    await tx.execute(sql`
      update stock_ledger set created_at = now() - make_interval(days => ${days})
      where store_id = ${storeId} and variant_id = ${variantId}`);
  });
}

/** The slow-mover notices a business's members got, one per notice (not per member). */
async function notices(b: BillingBusiness) {
  const rows = await t.connection.db
    .selectDistinct({
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, b.organizationId),
        eq(notifications.event, 'slow_movers'),
      ),
    )
    .orderBy(asc(notifications.title));
  return rows;
}

async function memberIdOf(token: string): Promise<string> {
  return ok(await api(t, token).get('/auth/me')).json<{ memberId: string }>().memberId;
}

describe('slow-mover alerts', () => {
  it('tells the store’s stock staff about stock idle for 90 days, once', async () => {
    const b = await billingBusiness(t);
    const stockman = await b.member('inventory_manager', [b.stores.amp]);
    const cashier = await b.member('store_employee', [b.stores.amp]);
    await age(b.stores.amp, b.apex, 100);
    await age(b.stores.kkp, b.apex, 10);

    expect(await check()).toBe(1);
    expect(await notices(b)).toEqual([
      {
        title: 'Slow movers at Ameerpet: 1 product(s) not moved in 90 days',
        body: 'APX-1L Apex Ultima 1 l: 10000 on hand, not moved for 100 days',
        link: `/stock/slow-movers?store=${b.stores.amp}&days=90`,
      },
    ]);
    const told = await t.connection.db
      .select({ memberId: notifications.memberId })
      .from(notifications)
      .where(eq(notifications.event, 'slow_movers'));
    expect(told.map((row) => row.memberId)).toContain(await memberIdOf(stockman));
    expect(told.map((row) => row.memberId)).not.toContain(await memberIdOf(cashier));

    // Once per idle stretch.
    expect(await check()).toBe(0);
    expect(await notices(b)).toHaveLength(1);
  });

  it('tells again after it sells and sits again, and follows the business’s setting', async () => {
    const b = await billingBusiness(t);
    await age(b.stores.amp, b.apex, 100);
    expect(await check()).toBe(1);

    // A sale re-arms it; once idle again, it is announced again.
    await b.invoice({ quantity: 1 });
    expect(await check()).toBe(0);
    await age(b.stores.amp, b.apex, 200);
    expect(await check()).toBe(1);

    // Off: nothing more, even when it sells and sits again.
    ok(await api(t, b.owner).put('/sales/settings', { slowMoverAlertDays: null }));
    await b.invoice({ quantity: 1 });
    // The day's check sees the sale (and re-arms it), as it would before the stock sits again.
    expect(await check()).toBe(0);
    await age(b.stores.amp, b.apex, 400);
    expect(await check()).toBe(0);

    // A shorter window catches what has sat for it.
    ok(await api(t, b.owner).put('/sales/settings', { slowMoverAlertDays: 45 }));
    expect(await check()).toBe(1);
    expect((await notices(b)).map((notice) => notice.title)).toContain(
      'Slow movers at Ameerpet: 1 product(s) not moved in 45 days',
    );
    expect(
      (await api(t, b.owner).put('/sales/settings', { slowMoverAlertDays: 60 })).statusCode,
    ).toBe(400);
  });

  it('lists the first few in the notice and counts the rest', async () => {
    const b = await billingBusiness(t);
    const o = api(t, b.owner);
    const options = ok(await o.get('/tax-categories/options')).json<TaxCategoryOptions>();
    const brandId = ok(await o.post('/brands', { name: 'Berger' })).json<{ id: string }>().id;
    const sizes = SLOW_MOVER_NOTICE_LINES + 2;
    const { variants } = ok(
      await o.post('/products', {
        brandId,
        name: 'Silk',
        type: 'interior_paint',
        hsnCode: '32091090',
        taxCategoryId: options.categories.find((c) => c.key === 'paints')?.id,
        variants: Array.from({ length: sizes }, (_, index) => ({
          sku: `SLK-${String(index + 10)}`,
          packSize: index + 1,
          unit: 'l',
          sellingPricePaise: 10_000,
        })),
      }),
    ).json<{ variants: { id: string }[] }>();
    await withTenant(t.connection.db, b.organizationId, (tx) =>
      postStockMovements(
        tx,
        variants.map((variant) => ({
          organizationId: b.organizationId,
          storeId: b.stores.kkp,
          variantId: variant.id,
          movementType: 'opening' as const,
          quantity: 2,
        })),
      ),
    );
    for (const variant of variants) await age(b.stores.kkp, variant.id, 120);

    expect(await check()).toBe(sizes);
    const [notice] = await notices(b);
    const lines = String(notice?.body).split('\n');
    expect(notice?.title).toBe(
      `Slow movers at Kukatpally: ${String(sizes)} product(s) not moved in 90 days`,
    );
    expect(lines).toHaveLength(SLOW_MOVER_NOTICE_LINES + 1);
    expect(lines.at(-1)).toBe('…and 2 more');
  });

  it('is checked by one server at a time', async () => {
    const b = await billingBusiness(t);
    await age(b.stores.amp, b.apex, 100);
    const other = new pg.Client({ connectionString: database.connectionString });
    await other.connect();
    try {
      await other.query('begin');
      await other.query("select pg_advisory_xact_lock(hashtext('paint:slow-mover-check'))");
      expect(await check()).toBe(0);
      await other.query('rollback');
    } finally {
      await other.end();
    }
    expect(await check()).toBe(1);
  });
});
