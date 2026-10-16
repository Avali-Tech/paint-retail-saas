import { ConflictException } from '@nestjs/common';
import { schema, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  PLANS,
  planBlockers,
  type PaidPlanKey,
  type PlanBlocker,
  type PlanKey,
  type PlanUsage,
  type SubscriptionInvoiceView,
  type SubscriptionRecord,
} from '@paint/shared';
import { and, desc, eq, sql } from 'drizzle-orm';

const { subscriptionInvoices, subscriptionPayments } = schema;

export type Db = DatabaseConnection['db'] | Transaction;
export type SubscriptionRow = typeof schema.subscriptions.$inferSelect;
export type InvoiceRow = typeof subscriptionInvoices.$inferSelect;
type PaymentRow = typeof subscriptionPayments.$inferSelect;

/** The database clock in milliseconds: every comparison with time uses it, never Node's. */
export const dbNowMs = sql<number>`(extract(epoch from now()) * 1000)::float8`.mapWith(Number);

/** Today in India, from the database clock, as YYYY-MM-DD. */
export const indiaToday = sql<string>`((now() at time zone 'Asia/Kolkata')::date)::text`;

export const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** A subscription as the shared rules read it. */
export function subscriptionRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    status: row.status,
    gateway: row.gateway,
    trialEndsAt: iso(row.trialEndsAt),
    currentPeriodEnd: iso(row.currentPeriodEnd),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    pastDueSince: iso(row.pastDueSince),
  };
}

/** Why a plan cannot be chosen, in words (English, as the API's other refusals). */
export function planRefusal(plan: PlanKey, blockers: readonly PlanBlocker[]): string {
  const limits = blockers.map((blocker) => {
    const noun = blocker.what === 'stores' ? 'active store' : 'active team member';
    const allowed = `${String(blocker.limit)} ${noun}${blocker.limit === 1 ? '' : 's'}`;
    return `allows ${allowed} and you have ${String(blocker.used)}`;
  });
  return `The ${PLANS[plan].name} plan ${limits.join('; it ')}. Close stores or deactivate team members first.`;
}

/**
 * Active stores and team members, counted as requireRoomFor counts them; platform
 * scope. Nothing MVP 3 adds counts: sites are projects, painters and contractors
 * are parties, and support sessions are not members of the team.
 */
export async function planUsage(db: Db, organizationId: string): Promise<PlanUsage> {
  const result = await db.execute<{ stores: number; members: number }>(sql`
    select
      (select count(*)::int from stores s where s.organization_id = ${organizationId} and s.is_active) as stores,
      (select count(*)::int from organization_members m
        where m.organization_id = ${organizationId} and m.is_active and not m.is_support) as members`);
  const [row] = result.rows as [{ stores: number; members: number }];
  return { stores: row.stores, members: row.members };
}

/** Refuses a plan the business has outgrown (409 `plan_limits_exceeded`, with the blockers). */
export function requireRoomOn(plan: PaidPlanKey, usage: PlanUsage): void {
  const blockers = planBlockers(plan, usage);
  if (blockers.length > 0) {
    throw new ConflictException({
      statusCode: 409,
      code: 'plan_limits_exceeded',
      message: planRefusal(plan, blockers),
      blockers,
    });
  }
}

/** One of our invoices, with the payment that settled it (at the gateway, or recorded). */
export function invoiceView(row: InvoiceRow, payment: PaymentRow | null): SubscriptionInvoiceView {
  return {
    id: row.id,
    number: row.number,
    issuedOn: row.issuedOn,
    plan: row.plan as PaidPlanKey,
    interval: row.billingInterval,
    quantity: row.storeQuantity,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    taxablePaise: row.taxablePaise,
    taxPaise: row.cgstPaise + row.sgstPaise + row.igstPaise,
    totalPaise: row.totalPaise,
    dueOn: row.dueOn,
    payment:
      row.gatewayPaymentId !== null
        ? {
            mode: 'online',
            amountPaise: row.totalPaise,
            paidOn: row.issuedOn,
            reference: row.gatewayPaymentId,
          }
        : payment && {
            mode: payment.mode,
            amountPaise: payment.amountPaise,
            paidOn: payment.paidOn,
            reference: payment.reference,
          },
  };
}

/** Our invoices to a business, newest first, each with its payment; platform scope. */
export async function invoicesOf(db: Db, organizationId: string) {
  const rows = await db
    .select({ invoice: subscriptionInvoices, payment: subscriptionPayments })
    .from(subscriptionInvoices)
    .leftJoin(subscriptionPayments, eq(subscriptionPayments.invoiceId, subscriptionInvoices.id))
    .where(eq(subscriptionInvoices.organizationId, organizationId))
    .orderBy(desc(subscriptionInvoices.issuedOn), desc(subscriptionInvoices.serial));
  return rows.map(({ invoice, payment }) => invoiceView(invoice, payment));
}

/** The business's manual invoice still waiting for its payment, if any (there is at most one). */
export async function unpaidManualInvoice(
  db: Db,
  organizationId: string,
): Promise<InvoiceRow | null> {
  const [row] = await db
    .select({ invoice: subscriptionInvoices })
    .from(subscriptionInvoices)
    .leftJoin(subscriptionPayments, eq(subscriptionPayments.invoiceId, subscriptionInvoices.id))
    .where(
      and(
        eq(subscriptionInvoices.organizationId, organizationId),
        eq(subscriptionInvoices.gateway, 'manual'),
        sql`${subscriptionPayments.id} is null`,
      ),
    );
  return row?.invoice ?? null;
}
