import { migrateDatabase, schema } from '@paint/db';
import type { SchemeView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { NotificationsWorker } from '../notifications/notifications-worker.js';
import { Notifier } from '../notifications/notifier.js';
import { api, ok } from '../test-support/billing-business.js';
import { seedSchemeBusiness, type SchemeBusiness } from '../test-support/scheme-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';
import { noticeSchemesForBusinesses } from './scheme-notices.js';

// Brand scheme notices (P2-M33): a slab within reach as the period ends, and a claim
// past its due date, each told once to the people who manage schemes.

const { notifications } = schema;

let database: TestDatabase;
let t: TestApp;
let biz: SchemeBusiness;

const base = () => ({
  brandId: biz.brands.apex,
  brandReference: null,
  dateBasis: 'grn_date',
  mode: 'retro',
  note: null,
  productIds: [],
  categoryIds: [],
});

const told = (event: 'scheme_slab_near' | 'scheme_claim_overdue') =>
  t.connection.db
    .select({ title: notifications.title, body: notifications.body, link: notifications.link })
    .from(notifications)
    .where(
      and(eq(notifications.organizationId, biz.organizationId), eq(notifications.event, event)),
    );

let quarter: SchemeView;
let july: SchemeView;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  biz = await seedSchemeBusiness(t);
  const owner = api(t, biz.owner);
  // ₹60,000 bought by 25 September; ₹5,000 short of the ₹65,000 slab with 5 days left.
  quarter = ok(
    await owner.post('/brand-schemes', {
      ...base(),
      name: 'Quarter',
      startsOn: '2026-07-01',
      endsOn: '2026-09-30',
      measure: 'value',
      settlementDays: 45,
      slabs: [
        { target: 50_000_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] },
        { target: 65_000_00, benefits: [{ kind: 'rebate', basisPoints: 150 }] },
      ],
    }),
  ).json<SchemeView>();
  // 220 L in July at ₹5/L, due 10 August, nothing received.
  july = ok(
    await owner.post('/brand-schemes', {
      ...base(),
      name: 'July litres',
      startsOn: '2026-07-01',
      endsOn: '2026-07-31',
      measure: 'litres',
      settlementDays: 10,
      slabs: [{ target: 100_000, benefits: [{ kind: 'per_litre', paisePerLitre: 500 }] }],
    }),
  ).json<SchemeView>();
  // A litres slab far away: never "within reach".
  const far = ok(
    await owner.post('/brand-schemes', {
      ...base(),
      name: 'Far litres',
      startsOn: '2026-07-01',
      endsOn: '2026-09-30',
      measure: 'litres',
      settlementDays: 45,
      slabs: [{ target: 5_000_000, benefits: [{ kind: 'per_litre', paisePerLitre: 100 }] }],
    }),
  ).json<SchemeView>();
  for (const scheme of [quarter, july, far]) {
    ok(await owner.post(`/brand-schemes/${scheme.id}/activate`));
  }
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('brand scheme notices', () => {
  it('waits while another server is sending them', async () => {
    const notifier = t.app.get(Notifier);
    const sent = await t.connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('paint:scheme-notices'), hashtext(${biz.organizationId}))`,
      );
      return noticeSchemesForBusinesses(t.connection.db, notifier, '2026-09-25');
    });
    expect(sent).toBe(0);
  });

  it('tells scheme managers of a slab within reach and an overdue claim, once each, once a day', async () => {
    const worker = t.app.get(NotificationsWorker);
    // Mid-August: the quarter's slab is not near its end yet; July's claim is overdue.
    const august = await worker.runOnce(new Date('2026-08-15T06:30:00Z'));
    expect(august.schemeNotices).toBe(1);
    expect(await told('scheme_slab_near')).toEqual([]);
    expect(await told('scheme_claim_overdue')).toEqual([
      {
        title: 'Scheme claim overdue: Apex Paints · July litres',
        body: '₹1,100.00 still owed, due 2026-08-10',
        link: `/brand-schemes/${july.id}`,
      },
    ]);
    // The same day again: nothing is looked at.
    expect((await worker.runOnce(new Date('2026-08-15T10:30:00Z'))).schemeNotices).toBe(0);

    const late = await worker.runOnce(new Date('2026-09-25T06:30:00Z'));
    expect(late.schemeNotices).toBe(1);
    expect(await told('scheme_slab_near')).toEqual([
      {
        title: 'Next slab within reach: Apex Paints · Quarter',
        body: '₹5,000.00 more to slab 2 in 5 days (₹1,000.00 a day)',
        link: `/brand-schemes/${quarter.id}`,
      },
    ]);
    // Another day: each was told already.
    expect((await worker.runOnce(new Date('2026-09-26T06:30:00Z'))).schemeNotices).toBe(0);
    expect(await told('scheme_claim_overdue')).toHaveLength(1);
  });

  it('names litres in litres', async () => {
    const owner = api(t, biz.owner);
    const near = ok(
      await owner.post('/brand-schemes', {
        ...base(),
        name: 'Near litres',
        startsOn: '2026-07-01',
        endsOn: '2026-09-30',
        measure: 'litres',
        settlementDays: 45,
        slabs: [{ target: 300_000, benefits: [{ kind: 'per_litre', paisePerLitre: 100 }] }],
      }),
    ).json<SchemeView>();
    ok(await owner.post(`/brand-schemes/${near.id}/activate`));
    const sent = await noticeSchemesForBusinesses(
      t.connection.db,
      t.app.get(Notifier),
      '2026-09-27',
    );
    expect(sent).toBe(1);
    const rows = await told('scheme_slab_near');
    expect(rows.find((row) => row.link === `/brand-schemes/${near.id}`)?.body).toBe(
      '20 L more to slab 1 in 3 days (6.667 L a day)',
    );
  });
});
