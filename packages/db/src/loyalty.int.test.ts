import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  auditLog,
  brands,
  loyaltyAccounts,
  loyaltyEarnRules,
  loyaltyLedger,
  loyaltySettings,
  organizationMembers,
  organizations,
  parties,
  roles,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let account: string;

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

const entry = (values: Partial<typeof loyaltyLedger.$inferInsert> = {}) =>
  connection.db
    .insert(loyaltyLedger)
    .values({
      organizationId: org,
      accountId: account,
      kind: 'award',
      points: 100,
      createdByMemberId: member,
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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100026' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  const party = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Ravi Painter' })
      .returning(),
  );
  account = id(
    await db
      .insert(loyaltyAccounts)
      .values({ organizationId: org, partyId: party, createdByMemberId: member })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('loyalty accounts', () => {
  it('start active, one per party, private to their business', async () => {
    const [row] = await connection.db
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.id, account));

    expect(row?.status).toBe('active');
    expect(
      await failureMessage(
        connection.db.insert(loyaltyAccounts).values({
          organizationId: org,
          partyId: String(row?.partyId),
          createdByMemberId: member,
        }),
      ),
    ).toMatch(/loyalty_accounts_party_unique/);
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(loyaltyAccounts)),
    ).toEqual([]);
  });
});

describe('the points ledger', () => {
  it.each([
    [{ points: 0 }, /loyalty_ledger_points_sign/],
    [{ kind: 'redeem' as const, points: 10 }, /loyalty_ledger_points_sign/],
    [
      { kind: 'expire' as const, points: 10, createdByMemberId: null },
      /loyalty_ledger_points_sign/,
    ],
    [{ kind: 'adjust' as const, points: 0, note: 'x' }, /loyalty_ledger_points_sign/],
    [{ kind: 'purchase' as const, reference: 'INV-1' }, /loyalty_ledger_purchase/],
    [{ manualPurchasePaise: 100 }, /loyalty_ledger_purchase/],
    [
      { kind: 'purchase' as const, manualPurchasePaise: 0, reference: 'INV-1' },
      /loyalty_ledger_purchase/,
    ],
    [{ kind: 'purchase' as const, manualPurchasePaise: 100 }, /loyalty_ledger_reference/],
    [{ kind: 'campaign' as const }, /loyalty_ledger_reference/],
    [{ kind: 'adjust' as const, points: 5 }, /loyalty_ledger_adjust_reason/],
    [
      { kind: 'redeem' as const, points: -5, expiresOn: '2027-01-01' },
      /loyalty_ledger_expiry_on_lots/,
    ],
    [{ kind: 'expire' as const, points: -5 }, /loyalty_ledger_system_expiry/],
    [{ createdByMemberId: null }, /loyalty_ledger_system_expiry/],
  ])('refuses inconsistent entries: %o', async (values, constraint) => {
    expect(await failureMessage(entry(values))).toMatch(constraint);
  });

  it('is append-only, whatever the role', async () => {
    const written = id(await entry());

    const change = connection.db
      .update(loyaltyLedger)
      .set({ points: 1_000 })
      .where(eq(loyaltyLedger.id, written));
    const remove = connection.db.delete(loyaltyLedger).where(eq(loyaltyLedger.id, written));
    // Started only when awaited, so its failure is never left unhandled.
    const asTenant = () =>
      withTenant(connection.db, org, (tx) =>
        tx.delete(loyaltyLedger).where(eq(loyaltyLedger.id, written)),
      );

    expect(await failureMessage(change)).toMatch(/loyalty_ledger is append-only/);
    expect(await failureMessage(remove)).toMatch(/loyalty_ledger is append-only/);
    expect(await failureMessage(asTenant())).toMatch(/permission denied/);
    expect(await failureMessage(connection.db.execute(sql`truncate loyalty_ledger`))).toMatch(
      /append-only/,
    );
  });

  it('audits adjustments only', async () => {
    await entry({ kind: 'adjust', points: -20, note: 'Duplicate award' });
    await entry({ kind: 'redeem', points: -10 });

    const entries = await connection.db
      .select({ newValues: auditLog.newValues })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'loyalty_ledger' and ${auditLog.recordId} = ${account}`);
    expect(entries).toEqual([{ newValues: { points: -20, note: 'Duplicate award' } }]);
  });
});

describe('loyalty settings', () => {
  it('keep earning positive, expiry positive and tiers an array', async () => {
    const settings = (values: Partial<typeof loyaltySettings.$inferInsert>) =>
      connection.db.insert(loyaltySettings).values({ organizationId: otherOrg, ...values });

    expect(await failureMessage(settings({ earnPoints: 0 }))).toMatch(
      /loyalty_settings_earn_positive/,
    );
    expect(await failureMessage(settings({ earnPerPaise: 0 }))).toMatch(
      /loyalty_settings_earn_positive/,
    );
    expect(await failureMessage(settings({ expiryDays: 0 }))).toMatch(
      /loyalty_settings_expiry_positive/,
    );
    expect(await failureMessage(settings({ minRedemptionPoints: -1 }))).toMatch(
      /loyalty_settings_min_redemption/,
    );
    expect(
      await failureMessage(
        connection.db.execute(
          sql`insert into loyalty_settings (organization_id, tiers) values (${otherOrg}, '{}'::jsonb)`,
        ),
      ),
    ).toMatch(/loyalty_settings_tiers_array/);
    await settings({});
    const [saved] = await connection.db
      .select()
      .from(loyaltySettings)
      .where(eq(loyaltySettings.organizationId, otherOrg));
    expect(saved).toMatchObject({
      earnPoints: 1,
      earnPerPaise: 10_000,
      tiers: [],
      expiryDays: null,
      minRedemptionPoints: 0,
    });
  });
});

describe('influencer points (P2-M36)', () => {
  // The invoice is not created here: foreign keys are set aside (replica mode)
  // so only the ledger's own rules are exercised.
  const influencer = (values: Partial<typeof loyaltyLedger.$inferInsert>) =>
    connection.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      return tx
        .insert(loyaltyLedger)
        .values({
          organizationId: org,
          accountId: account,
          kind: 'influencer',
          points: 40,
          reference: 'INV-000001',
          createdByMemberId: member,
          ...values,
        })
        .returning();
    });

  it('names the invoice and its number, earns positive points, once per invoice', async () => {
    const invoice = crypto.randomUUID();

    expect(await failureMessage(influencer({}))).toMatch(/loyalty_ledger_influencer/);
    expect(await failureMessage(influencer({ taxDocumentId: invoice, reference: null }))).toMatch(
      /loyalty_ledger_reference/,
    );
    expect(await failureMessage(influencer({ taxDocumentId: invoice, points: -5 }))).toMatch(
      /loyalty_ledger_points_sign/,
    );
    expect(
      await failureMessage(influencer({ taxDocumentId: invoice, manualPurchasePaise: 100 })),
    ).toMatch(/loyalty_ledger_purchase/);
    const [row] = await influencer({ taxDocumentId: invoice, expiresOn: '2027-10-16' });
    expect(row).toMatchObject({ kind: 'influencer', points: 40, taxDocumentId: invoice });
    expect(await failureMessage(influencer({ taxDocumentId: invoice }))).toMatch(
      /loyalty_ledger_invoice_influencer_unique/,
    );
    // The bill-to party's purchase on the same invoice is a separate entry.
    await influencer({ kind: 'purchase', taxDocumentId: invoice });
  });
});

describe('loyalty earn rules (P2-M36)', () => {
  let brand: string;
  beforeAll(async () => {
    brand = id(
      await connection.db
        .insert(brands)
        .values({ organizationId: org, name: 'Asian Paints' })
        .returning(),
    );
  });

  const rule = (values: Partial<typeof loyaltyEarnRules.$inferInsert> = {}) =>
    connection.db
      .insert(loyaltyEarnRules)
      .values({
        organizationId: org,
        name: `Rule ${crypto.randomUUID()}`,
        basis: 'value',
        points: 1,
        perPaise: 10_000,
        createdByMemberId: member,
        ...values,
      })
      .returning();

  it.each([
    [{ name: ' Padded ' }, /loyalty_earn_rules_name/],
    [{ name: '' }, /loyalty_earn_rules_name/],
    [{ points: 0 }, /loyalty_earn_rules_points_positive/],
    [{ perPaise: null }, /loyalty_earn_rules_basis/],
    [{ perPaise: 0 }, /loyalty_earn_rules_basis/],
    [{ perMillilitres: 1_000 }, /loyalty_earn_rules_basis/],
    [{ basis: 'litre' as const, perPaise: null }, /loyalty_earn_rules_basis/],
    [{ basis: 'litre' as const, perPaise: null, perMillilitres: 0 }, /loyalty_earn_rules_basis/],
    [{ multiplierBps: 0 }, /loyalty_earn_rules_multiplier/],
    [{ multiplierBps: 1_000_001 }, /loyalty_earn_rules_multiplier/],
    [{ validFrom: '2026-10-02', validUntil: '2026-10-01' }, /loyalty_earn_rules_period/],
    [{ brandId: crypto.randomUUID() }, /loyalty_earn_rules_brand_fk/],
  ])('refuse inconsistent rules: %o', async (values, constraint) => {
    expect(await failureMessage(rule(values))).toMatch(constraint);
  });

  it('count value or litres, per brand or for all, with unique names, private to their business', async () => {
    const [byValue] = await rule({ name: 'Every ₹100' });
    const [byLitre] = await rule({
      name: 'Asian Paints double points per litre',
      basis: 'litre',
      perPaise: null,
      perMillilitres: 1_000,
      brandId: brand,
      multiplierBps: 20_000,
      validFrom: '2026-10-01',
      validUntil: '2026-12-31',
    });

    expect(byValue).toMatchObject({ multiplierBps: 10_000, isActive: true, brandId: null });
    expect(byLitre).toMatchObject({ basis: 'litre', perMillilitres: 1_000, brandId: brand });
    expect(await failureMessage(rule({ name: 'EVERY ₹100' }))).toMatch(
      /loyalty_earn_rules_organization_name_unique/,
    );
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(loyaltyEarnRules)),
    ).toEqual([]);
  });

  it('are audited', async () => {
    const [created] = await rule({ name: 'Audited rule' });
    const ruleId = String(created?.id);
    await connection.db
      .update(loyaltyEarnRules)
      .set({ points: 2, updatedAt: new Date() })
      .where(eq(loyaltyEarnRules.id, ruleId));
    await connection.db.delete(loyaltyEarnRules).where(eq(loyaltyEarnRules.id, ruleId));

    const entries = await connection.db
      .select({ action: auditLog.action, newValues: auditLog.newValues })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'loyalty_earn_rules' and ${auditLog.recordId} = ${ruleId}`)
      .orderBy(auditLog.id);
    expect(entries.map((entry) => entry.action)).toEqual(['insert', 'update', 'delete']);
    expect(entries[1]?.newValues).toEqual({ points: 2 });
  });
});
