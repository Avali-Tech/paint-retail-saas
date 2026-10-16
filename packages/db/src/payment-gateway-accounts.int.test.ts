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

// MVP 3 round 4c (migrations 0081–0082): each business's own gateway account, the
// payment-link settings, and refunds through the gateway.

const {
  auditLog,
  organizationMembers,
  organizations,
  parties,
  paymentGatewayAccounts,
  paymentLinkRefunds,
  paymentLinks,
  paymentModes,
  payments,
  roles,
  salesSettings,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

interface Tenant {
  readonly org: string;
  readonly store: string;
  readonly member: string;
  readonly party: string;
  readonly otherParty: string;
  readonly linkMode: string;
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
  const otherParty = id(
    await db.insert(parties).values({ organizationId: org, displayName: 'Ramesh' }).returning(),
  );
  const linkMode = id(
    await db
      .insert(paymentModes)
      .values({ organizationId: org, kind: 'upi_link', name: 'UPI link' })
      .returning(),
  );
  return { org, store, member, party, otherParty, linkMode };
}

let refs = 0;
/** A 22-character webhook reference, unique per call. */
const ref = () => {
  refs += 1;
  return `ref${String(refs).padStart(19, '0')}`;
};

const connected = (t: Tenant) => ({
  keyIdHint: 'AbCd',
  keySecretHint: 'wxyz',
  webhookSecretHint: '1234',
  live: false,
  credentialsSealed: 'v1:kid:wrapped:sealed',
  connectedAt: new Date(),
  connectedByMemberId: t.member,
});

type AccountValues = Partial<typeof paymentGatewayAccounts.$inferInsert>;
const account = (t: Tenant, values: AccountValues = {}) =>
  withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(paymentGatewayAccounts)
        .values({ organizationId: t.org, gateway: 'razorpay', webhookRef: ref(), ...values })
        .returning(),
    ),
  );
const setAccount = (t: Tenant, accountId: string, values: AccountValues) =>
  withTenant(connection.db, t.org, (tx) =>
    tx.update(paymentGatewayAccounts).set(values).where(eq(paymentGatewayAccounts.id, accountId)),
  );

let links = 0;
const link = (t: Tenant) => {
  links += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(paymentLinks)
        .values({
          organizationId: t.org,
          number: `PL-${String(links).padStart(6, '0')}`,
          storeId: t.store,
          partyId: t.party,
          purpose: 'outstanding',
          origin: 'staff',
          amountPaise: 23_600,
          description: 'Balance due',
          provider: 'log',
          gatewayReference: `plink_log_${String(links)}`,
          url: `http://localhost:5173/pay/plink_log_${String(links)}`,
          expiresAt: sql`now() + interval '10 minutes'`,
          createdByMemberId: t.member,
        })
        .returning(),
    ),
  );
};

let numbers = 0;
const linkPayment = (t: Tenant, linkId: string, values: Partial<typeof payments.$inferInsert>) => {
  numbers += 1;
  return withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(payments)
        .values({
          organizationId: t.org,
          storeId: t.store,
          number: `RC-${String(numbers).padStart(6, '0')}`,
          direction: 'in',
          partyId: t.party,
          modeId: t.linkMode,
          modeKind: 'upi_link',
          amountPaise: 30_000,
          receivedOn: '2026-10-07',
          gatewayReference: `pay_log_${String(numbers)}`,
          paymentLinkId: linkId,
          ...values,
        })
        .returning(),
    ),
  );
};

type RefundValues = Partial<typeof paymentLinkRefunds.$inferInsert>;
const refund = (t: Tenant, linkId: string, paymentId: string, values: RefundValues = {}) =>
  withTenant(connection.db, t.org, async (tx) =>
    id(
      await tx
        .insert(paymentLinkRefunds)
        .values({
          organizationId: t.org,
          linkId,
          partyId: t.party,
          paymentId,
          gatewayPaymentId: 'pay_log_x',
          amountPaise: 6_400,
          reason: 'overpaid',
          provider: 'log',
          ...values,
        })
        .returning(),
    ),
  );
const setRefund = (t: Tenant, refundId: string, values: RefundValues) =>
  withTenant(connection.db, t.org, (tx) =>
    tx.update(paymentLinkRefunds).set(values).where(eq(paymentLinkRefunds.id, refundId)),
  );

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

describe('payment-link settings', () => {
  it('default to 10 minutes, ₹1,00,000 and net of the advance, within bounds, and are audited', async () => {
    await withTenant(connection.db, a.org, (tx) =>
      tx.insert(salesSettings).values({ organizationId: a.org }),
    );
    const [row] = await connection.db
      .select({
        minutes: salesSettings.paymentLinkValidityMinutes,
        cap: salesSettings.paymentLinkCapPaise,
        basis: salesSettings.paymentLinkAmountBasis,
      })
      .from(salesSettings)
      .where(eq(salesSettings.organizationId, a.org));
    expect(row).toEqual({ minutes: 10, cap: 10_000_000, basis: 'net' });
    const set = (values: Partial<typeof salesSettings.$inferInsert>) =>
      withTenant(connection.db, a.org, (tx) =>
        tx.update(salesSettings).set(values).where(eq(salesSettings.organizationId, a.org)),
      );
    for (const values of [
      { paymentLinkValidityMinutes: 4 },
      { paymentLinkValidityMinutes: 43_201 },
      { paymentLinkCapPaise: 99 },
      { paymentLinkCapPaise: 50_000_001 },
    ]) {
      expect(await failureMessage(set(values))).toMatch(/sales_settings_payment_links/);
    }
    await set({ paymentLinkValidityMinutes: 30, paymentLinkAmountBasis: 'full' });
    const [audit] = await connection.db
      .select({ newValues: auditLog.newValues })
      .from(auditLog)
      .where(
        sql`${auditLog.tableName} = 'sales_settings' and ${auditLog.action} = 'update'
          and ${auditLog.organizationId} = ${a.org}`,
      );
    expect(audit?.newValues).toEqual({
      payment_link_validity_minutes: 30,
      payment_link_amount_basis: 'full',
    });
  });
});

describe('payment gateway accounts', () => {
  it('are Razorpay accounts with a URL-safe webhook reference, unique everywhere', async () => {
    expect(await failureMessage(account(b, { gateway: 'log' }))).toMatch(
      /payment_gateway_accounts_gateway/,
    );
    expect(await failureMessage(account(b, { webhookRef: 'short' }))).toMatch(
      /payment_gateway_accounts_webhook_ref/,
    );
    const shared = ref();
    await account(b, { webhookRef: shared });
    expect(await failureMessage(account(a, { webhookRef: shared }))).toMatch(
      /payment_gateway_accounts_webhook_ref_unique/,
    );
    // One per business.
    expect(await failureMessage(account(b))).toMatch(
      /payment_gateway_accounts_organization_unique/,
    );
  });

  it('hold every credential field, or none; hints are four characters; sealed is versioned', async () => {
    const t = await tenant('Hint Paints');
    const values = connected(t);
    expect(await failureMessage(account(t, { ...values, live: null }))).toMatch(
      /payment_gateway_accounts_connected/,
    );
    expect(await failureMessage(account(t, { ...values, keyIdHint: 'ABCDE' }))).toMatch(
      /payment_gateway_accounts_hints/,
    );
    expect(await failureMessage(account(t, { ...values, credentialsSealed: 'plain' }))).toMatch(
      /payment_gateway_accounts_hints/,
    );
    expect(await failureMessage(account(t, { verifiedAt: new Date() }))).toMatch(
      /payment_gateway_accounts_connected/,
    );
    await expect(account(t, values)).resolves.toBeTruthy();
  });

  it('keep their business and webhook reference, are never deleted, and are audited without secrets', async () => {
    const kept = await account(a, connected(a));
    expect(await failureMessage(setAccount(a, kept, { webhookRef: ref() }))).toMatch(
      /keeps its business, gateway and webhook reference/,
    );
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(paymentGatewayAccounts).where(eq(paymentGatewayAccounts.id, kept)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db.delete(paymentGatewayAccounts).where(eq(paymentGatewayAccounts.id, kept)),
      ),
    ).toMatch(/never deleted/);
    // Disconnecting clears every credential field.
    await setAccount(a, kept, {
      keyIdHint: null,
      keySecretHint: null,
      webhookSecretHint: null,
      live: null,
      credentialsSealed: null,
      connectedAt: null,
      connectedByMemberId: null,
    });
    const audit = await connection.db
      .select({ oldValues: auditLog.oldValues, newValues: auditLog.newValues })
      .from(auditLog)
      .where(
        sql`${auditLog.tableName} = 'payment_gateway_accounts' and ${auditLog.recordId} = ${kept}`,
      )
      .orderBy(auditLog.id);
    expect(audit).toHaveLength(2);
    const text = JSON.stringify(audit);
    expect(text).toContain('AbCd');
    expect(text).not.toContain('wxyz');
    expect(text).not.toContain('1234');
    expect(text).not.toContain('v1:');
  });

  it("stay within their business: another business's account is invisible", async () => {
    const seen = await withTenant(connection.db, a.org, (tx) =>
      tx
        .select({ id: paymentGatewayAccounts.id })
        .from(paymentGatewayAccounts)
        .where(eq(paymentGatewayAccounts.organizationId, b.org)),
    );
    expect(seen).toEqual([]);
  });
});

describe('payments for a link may be refunds through the gateway', () => {
  it('money out by the UPI link mode, with the refund id, no member and no register', async () => {
    const paid = await link(a);
    await expect(
      linkPayment(a, paid, {
        direction: 'out',
        number: 'RF-000001',
        gatewayReference: 'rfnd_log_1',
      }),
    ).resolves.toBeTruthy();
    expect(
      await failureMessage(
        linkPayment(a, paid, { direction: 'out', number: 'RF-000002', gatewayReference: null }),
      ),
    ).toMatch(/payments_link/);
  });
});

describe('payment link refunds', () => {
  const paidLink = async (t: Tenant) => {
    const linkId = await link(t);
    const paymentId = await linkPayment(t, linkId, {});
    return { linkId, paymentId };
  };
  const refundOut = (t: Tenant, linkId: string) =>
    linkPayment(t, linkId, {
      direction: 'out',
      number: `RF-${String(900_000 + numbers)}`,
      gatewayReference: `rfnd_log_${String(numbers)}`,
    });

  it.each([
    [{ amountPaise: 0 }, /payment_link_refunds_amount_positive/],
    [{ attempts: -1 }, /payment_link_refunds_attempts/],
    [{ status: 'refunded' as const }, /payment_link_refunds_status/],
    [{ status: 'returned' as const }, /payment_link_refunds_status/],
    [{ gatewayPaymentId: '' }, /payment_link_refunds_text_lengths/],
    [{ lastError: 'x'.repeat(201) }, /payment_link_refunds_text_lengths/],
  ])('refuse inconsistent refunds: %o', async (values, constraint) => {
    const { linkId, paymentId } = await paidLink(a);
    expect(await failureMessage(refund(a, linkId, paymentId, values))).toMatch(constraint);
  });

  it("refund the link's own party's payment", async () => {
    const { linkId, paymentId } = await paidLink(a);
    expect(await failureMessage(refund(a, linkId, paymentId, { partyId: a.otherParty }))).toMatch(
      /payment_link_refunds_(link|payment)_fk/,
    );
  });

  it('move forward only, keep what they refund, and close for good', async () => {
    const { linkId, paymentId } = await paidLink(a);
    const pending = await refund(a, linkId, paymentId);
    await setRefund(a, pending, { attempts: 1, lastError: 'gateway_unreachable' });
    expect(await failureMessage(setRefund(a, pending, { amountPaise: 1 }))).toMatch(
      /keeps what it refunds/,
    );
    expect(await failureMessage(setRefund(a, pending, { attempts: 0 }))).toMatch(/written once/);
    expect(
      await failureMessage(
        setRefund(a, pending, { status: 'returned', returnedPaymentId: paymentId }),
      ),
    ).toMatch(/payment_link_refunds_status|cannot become/);
    const out = await refundOut(a, linkId);
    await setRefund(a, pending, {
      status: 'refunded',
      gatewayRefundId: 'rfnd_log_a',
      gatewayStatus: 'processed',
      refundPaymentId: out,
      refundedAt: new Date(),
    });
    expect(await failureMessage(setRefund(a, pending, { gatewayRefundId: 'rfnd_log_b' }))).toMatch(
      /written once/,
    );
    expect(
      await failureMessage(
        setRefund(a, pending, { status: 'pending', refundPaymentId: null, refundedAt: null }),
      ),
    ).toMatch(/cannot become pending|payment_link_refunds_status/);
    const back = await linkPayment(a, linkId, { gatewayReference: 'rfnd_log_a/returned' });
    await setRefund(a, pending, { status: 'returned', returnedPaymentId: back });
    expect(await failureMessage(setRefund(a, pending, { gatewayStatus: 'failed' }))).toMatch(
      /returned gateway refund is closed/,
    );

    const dropped = await refund(a, linkId, paymentId);
    await setRefund(a, dropped, { status: 'dropped' });
    expect(await failureMessage(setRefund(a, dropped, { attempts: 5 }))).toMatch(/is closed/);
    const failed = await refund(a, linkId, paymentId);
    await setRefund(a, failed, { status: 'failed', attempts: 6, flaggedAt: new Date() });
    expect(await failureMessage(setRefund(a, failed, { status: 'pending' }))).toMatch(
      /cannot become pending/,
    );
  });

  it("keep the gateway's refund id unique per provider", async () => {
    const { linkId, paymentId } = await paidLink(a);
    const first = await refund(a, linkId, paymentId);
    const second = await refund(a, linkId, paymentId);
    await setRefund(a, first, { gatewayRefundId: 'rfnd_same' });
    expect(await failureMessage(setRefund(a, second, { gatewayRefundId: 'rfnd_same' }))).toMatch(
      /payment_link_refunds_gateway_unique/,
    );
  });

  it('are never deleted by a tenant, stay in their business, and are audited', async () => {
    const { linkId, paymentId } = await paidLink(a);
    const kept = await refund(a, linkId, paymentId, { retryOfId: null });
    const retry = await refund(a, linkId, paymentId, { retryOfId: kept });
    expect(retry).toBeTruthy();
    expect(
      await failureMessage(
        withTenant(connection.db, a.org, (tx) =>
          tx.delete(paymentLinkRefunds).where(eq(paymentLinkRefunds.id, kept)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await failureMessage(
        connection.db.delete(paymentLinkRefunds).where(eq(paymentLinkRefunds.id, kept)),
      ),
    ).toMatch(/never deleted/);
    const seen = await withTenant(connection.db, b.org, (tx) =>
      tx.select({ id: paymentLinkRefunds.id }).from(paymentLinkRefunds),
    );
    expect(seen).toEqual([]);
    await setRefund(a, kept, { status: 'dropped' });
    const audit = await connection.db
      .select({ action: auditLog.action, newValues: auditLog.newValues })
      .from(auditLog)
      .where(sql`${auditLog.tableName} = 'payment_link_refunds' and ${auditLog.recordId} = ${kept}`)
      .orderBy(auditLog.id);
    expect(audit.map((row) => row.action)).toEqual(['insert', 'update']);
    expect(audit[1]?.newValues).toEqual({ status: 'dropped' });
  });
});
