import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  brands,
  emailOutbox,
  lowStockAlerts,
  notificationPreferences,
  notifications,
  organizationMembers,
  organizations,
  productVariants,
  products,
  roles,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let store: string;
let variant: string;

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

const email = (values: Partial<typeof emailOutbox.$inferInsert> = {}) =>
  connection.db
    .insert(emailOutbox)
    .values({
      organizationId: org,
      memberId: member,
      event: 'low_stock',
      toAddress: 'owner@abc.example',
      subject: 'Low stock',
      textBody: 'Apex 1 L is low at HYD',
      ...values,
    })
    .returning();

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  org = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  otherOrg = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'owner', name: 'Owner' }).returning(),
  );
  const user = id(
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100003' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  store = id(
    await db.insert(stores).values({ organizationId: org, name: 'HYD', code: 'HYD' }).returning(),
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
        hsnCode: '3209',
        gstRateBps: 1800,
      })
      .returning(),
  );
  variant = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'AP-1L', packSize: 1, unit: 'l' })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('notifications', () => {
  it('belong to a member of the same business, and are private to it', async () => {
    const [saved] = await connection.db
      .insert(notifications)
      .values({
        organizationId: org,
        memberId: member,
        event: 'low_stock',
        title: 'Low stock',
        body: 'Apex 1 L is low at HYD',
        link: '/stock/low',
      })
      .returning();

    expect(saved?.readAt).toBeNull();
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(notifications)),
    ).toEqual([]);
    expect(
      await failureMessage(
        connection.db.insert(notifications).values({
          organizationId: otherOrg,
          memberId: member,
          event: 'low_stock',
          title: 'x',
          body: 'x',
          link: '/',
        }),
      ),
    ).toMatch(/notifications_member_fk/);
  });

  it('keeps one preference per member and event', async () => {
    const preference = {
      organizationId: org,
      memberId: member,
      event: 'low_stock' as const,
      inApp: true,
      email: false,
    };
    await connection.db.insert(notificationPreferences).values(preference);

    expect(
      await failureMessage(connection.db.insert(notificationPreferences).values(preference)),
    ).toMatch(/notification_preferences_member_id_event_pk/);
  });
});

describe('email outbox', () => {
  it('starts pending with no attempts, due now', async () => {
    const [queued] = await email();

    expect(queued).toMatchObject({ status: 'pending', attempts: 0, sentAt: null, lastError: null });
  });

  it.each([
    [{ status: 'sent' as const }, /email_outbox_sent_when_sent/],
    [{ sentAt: new Date() }, /email_outbox_sent_when_sent/],
    [{ attempts: -1 }, /email_outbox_attempts_not_negative/],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(email(values))).toMatch(constraint);
  });
});

describe('low stock alerts', () => {
  it('records each store and product once, and goes when the product does', async () => {
    await connection.db
      .insert(lowStockAlerts)
      .values({ organizationId: org, storeId: store, variantId: variant });

    expect(
      await failureMessage(
        connection.db
          .insert(lowStockAlerts)
          .values({ organizationId: org, storeId: store, variantId: variant }),
      ),
    ).toMatch(/low_stock_alerts_store_id_variant_id_pk/);

    await connection.db.delete(productVariants).where(eq(productVariants.id, variant));
    expect(await connection.db.select().from(lowStockAlerts)).toEqual([]);
  });
});
