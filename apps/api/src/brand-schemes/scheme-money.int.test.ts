import { migrateDatabase, schema, withTenant } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { seedSchemeBusiness, type SchemeBusiness } from '../test-support/scheme-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';
import { schemeMoneyByBrand } from './scheme-money.js';

// schemeMoneyByBrand: the scheme figures brand profitability (P2-M35) adds per brand.

const { brandBenefitReceipts, brandSchemeBenefits, brandSchemeSlabs, brandSchemes } = schema;

let database: TestDatabase;
let t: TestApp;
let biz: SchemeBusiness;

interface SchemeSpec {
  readonly brandId: string;
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'draft' | 'active' | 'closed' | 'cancelled';
  /** Rebate in basis points at ₹50,000. */
  readonly rebateBps: number;
  readonly received: readonly number[];
}

async function scheme(spec: SchemeSpec): Promise<string> {
  const org = biz.organizationId;
  return withTenant(t.connection.db, org, async (tx) => {
    const [row] = await tx
      .insert(brandSchemes)
      .values({
        organizationId: org,
        brandId: spec.brandId,
        name: spec.name,
        startsOn: spec.startsOn,
        endsOn: spec.endsOn,
        measure: 'value',
        status: spec.status === 'draft' ? 'draft' : 'active',
        createdByMemberId: biz.ownerMemberId,
      })
      .returning();
    const schemeId = String(row?.id);
    const [slab] = await tx
      .insert(brandSchemeSlabs)
      .values({ organizationId: org, schemeId, position: 1, target: 50_000_00 })
      .returning();
    await tx.insert(brandSchemeBenefits).values({
      organizationId: org,
      schemeId,
      slabId: String(slab?.id),
      position: 1,
      kind: 'rebate',
      basisPoints: spec.rebateBps,
    });
    for (const amountPaise of spec.received) {
      await tx.insert(brandBenefitReceipts).values({
        organizationId: org,
        schemeId,
        kind: 'money',
        receivedOn: '2026-10-10',
        amountPaise,
        moneyForm: 'credit_note',
        reference: 'CN-1',
        recordedByMemberId: biz.ownerMemberId,
      });
    }
    if (spec.status === 'closed' || spec.status === 'cancelled') {
      await tx
        .update(brandSchemes)
        .set({ status: spec.status, endedAt: new Date(), endedByMemberId: biz.ownerMemberId })
        .where(eq(brandSchemes.id, schemeId));
    }
    return schemeId;
  });
}

const money = (from: string, to: string, asOf?: string) =>
  withTenant(t.connection.db, biz.organizationId, (tx) =>
    schemeMoneyByBrand(tx, biz.organizationId, from, to, asOf),
  );

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  biz = await seedSchemeBusiness(t);
  // Apex Q2 (Jul–Sep): ₹60,000 bought, slab ₹50,000 at 1 % = ₹600; ₹300 came.
  await scheme({
    brandId: biz.brands.apex,
    name: 'Apex Q2',
    startsOn: '2026-07-01',
    endsOn: '2026-09-30',
    status: 'active',
    rebateBps: 100,
    received: [400_00, -100_00],
  });
  // Ignored: a draft and a cancelled Apex scheme.
  await scheme({
    brandId: biz.brands.apex,
    name: 'Apex draft',
    startsOn: '2026-07-01',
    endsOn: '2026-09-30',
    status: 'draft',
    rebateBps: 500,
    received: [],
  });
  await scheme({
    brandId: biz.brands.apex,
    name: 'Apex withdrawn',
    startsOn: '2026-07-01',
    endsOn: '2026-09-30',
    status: 'cancelled',
    rebateBps: 500,
    received: [],
  });
  // Berger year (Apr–Mar, 365 days): ₹15,000 bought, under the slab; ₹730 came anyway
  // and it was closed, so nothing more is expected.
  await scheme({
    brandId: biz.brands.berger,
    name: 'Berger year',
    startsOn: '2026-04-01',
    endsOn: '2027-03-31',
    status: 'closed',
    rebateBps: 100,
    received: [730_00],
  });
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('schemeMoneyByBrand', () => {
  it('gives each brand the money received and still expected on its counted schemes', async () => {
    const rows = await money('2026-07-01', '2026-09-30', '2026-10-15');
    const expected = [
      { brandId: biz.brands.apex, receivedPaise: 300_00, expectedPaise: 300_00 },
      // 92 of the year's 365 days: ⌊73,000 × 92 ÷ 365⌋.
      { brandId: biz.brands.berger, receivedPaise: 18_400, expectedPaise: 0 },
    ].sort((a, b) => a.brandId.localeCompare(b.brandId));
    expect(rows).toEqual(expected);
  });

  it('counts a scheme in proportion to its days inside the period', async () => {
    const rows = await money('2026-08-01', '2026-08-31', '2026-10-15');
    // Apex: 31 of 92 days of ₹300 each; Berger: 31 of 365 days of ₹730.
    expect(rows).toContainEqual({
      brandId: biz.brands.apex,
      receivedPaise: 10_108,
      expectedPaise: 10_108,
    });
    expect(rows).toContainEqual({
      brandId: biz.brands.berger,
      receivedPaise: 6_200,
      expectedPaise: 0,
    });
  });

  it('takes the schemes as they stood on the day asked, today by default', async () => {
    // On 31 July only the 10 July GRN (₹40,000) and the putty (₹5,000) counted: no slab.
    expect(await money('2026-07-01', '2026-09-30', '2026-07-31')).toContainEqual({
      brandId: biz.brands.apex,
      receivedPaise: 0,
      expectedPaise: 0,
    });
    // Today is after every receipt and the period: the same as 15 October.
    expect(await money('2026-07-01', '2026-09-30')).toEqual(
      await money('2026-07-01', '2026-09-30', '2026-10-15'),
    );
  });

  it('lists no brand without a counted scheme in the period, and refuses a backwards period', async () => {
    expect(await money('2025-01-01', '2025-03-31', '2026-10-15')).toEqual([]);
    await expect(money('2026-09-30', '2026-07-01')).rejects.toThrow(/ends before it starts/);
  });
});
