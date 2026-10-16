import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

// MVP 3 round 5 (migrations 0086–0087): the settings brand profitability reads.

const { auditLog, loyaltySettings, organizations, salesSettings } = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

const audited = (table: string) =>
  connection.db
    .select({ newValues: auditLog.newValues })
    .from(auditLog)
    .where(
      sql`${auditLog.tableName} = ${table} and ${auditLog.action} = 'update'
        and ${auditLog.organizationId} = ${org}`,
    );

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const [row] = await connection.db
    .insert(organizations)
    .values({ name: 'ABC Paints' })
    .returning();
  org = String(row?.id);
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('profitability settings', () => {
  it('keep the cost of money: 12 % a year by default, 0 to 100 %, audited', async () => {
    await withTenant(connection.db, org, (tx) =>
      tx.insert(salesSettings).values({ organizationId: org }),
    );
    const set = (costOfMoneyBps: number) =>
      withTenant(connection.db, org, (tx) =>
        tx
          .update(salesSettings)
          .set({ costOfMoneyBps })
          .where(eq(salesSettings.organizationId, org)),
      );
    const [row] = await connection.db
      .select({ bps: salesSettings.costOfMoneyBps })
      .from(salesSettings)
      .where(eq(salesSettings.organizationId, org));
    expect(row?.bps).toBe(1200);
    expect(await failureMessage(set(10_001))).toMatch(/sales_settings_cost_of_money/);
    expect(await failureMessage(set(-1))).toMatch(/sales_settings_cost_of_money/);
    await set(0);
    await set(1500);
    expect((await audited('sales_settings')).map((entry) => entry.newValues)).toEqual([
      { cost_of_money_bps: 0 },
      { cost_of_money_bps: 1500 },
    ]);
  });

  it('keep what a point is worth: ₹1 by default, never negative, audited', async () => {
    await withTenant(connection.db, org, (tx) =>
      tx.insert(loyaltySettings).values({ organizationId: org }),
    );
    const set = (pointValuePaise: number) =>
      withTenant(connection.db, org, (tx) =>
        tx
          .update(loyaltySettings)
          .set({ pointValuePaise })
          .where(eq(loyaltySettings.organizationId, org)),
      );
    const [row] = await connection.db
      .select({ paise: loyaltySettings.pointValuePaise })
      .from(loyaltySettings)
      .where(eq(loyaltySettings.organizationId, org));
    expect(row?.paise).toBe(100);
    expect(await failureMessage(set(-1))).toMatch(/loyalty_settings_point_value/);
    await set(25);
    expect((await audited('loyalty_settings')).map((entry) => entry.newValues)).toEqual([
      { point_value_paise: 25 },
    ]);
  });
});
