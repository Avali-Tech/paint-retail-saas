import 'reflect-metadata';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { schema, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  RENEWAL_INVOICE_LEAD_DAYS,
  subscriptionState,
  type BillingInterval,
  type PaidPlanKey,
  type PlanKey,
  type PlanRequestView,
  type RecordSubscriptionPaymentRequest,
  type TenantBillingView,
} from '@paint/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { fieldError } from '../tax/tax-lookups.js';
import {
  dbNowMs,
  indiaToday,
  invoicesOf,
  planUsage,
  requireRoomOn,
  subscriptionRecord,
  unpaidManualInvoice,
  type Db,
  type InvoiceRow,
  type SubscriptionRow,
} from './subscription-lookups.js';
import { insertSubscriptionInvoice } from './subscription-invoice.js';
import { SUBSCRIPTION_SETTINGS, type SubscriptionSettings } from './subscriptions.tokens.js';

const {
  organizationMembers,
  organizations,
  subscriptionInvoices,
  subscriptionPayments,
  subscriptionPlanChanges,
  subscriptionPlanRequests,
  subscriptions,
  users,
} = schema;

type RequestRow = typeof subscriptionPlanRequests.$inferSelect;

/** Manual invoices raised per pass of the renewal job; the next pass takes the rest. */
const RENEWAL_BATCH = 200;

/** One period from `start` (an India date): its last day, as SQL. */
const periodEndFrom = (start: string | ReturnType<typeof sql>, interval: BillingInterval) =>
  sql<string>`((${start}::date + ${interval === 'annual' ? sql`interval '1 year'` : sql`interval '1 month'`})::date - 1)::text`;

/** The start of an India day as an instant. */
const startOfIndiaDay = (day: string | ReturnType<typeof sql>) =>
  sql`(${day}::date::timestamp at time zone 'Asia/Kolkata')`;

/**
 * Manual invoicing (SUBSCRIPTION_GATEWAY=manual, the default; docs/mvp-3/subscriptions.md):
 * the owner asks for a plan, a platform operator applies it, we raise our GST
 * invoices (the first when a request is applied, then each period ahead of time),
 * the business pays by bank transfer or UPI and an operator records the payment,
 * which pays for the invoice's period. A subscription's current_period_end is then
 * the end of the last period paid: past it the business is past due, then read-only
 * after the grace days, exactly as when a gateway's renewal fails. Platform scope.
 */
@Injectable()
export class ManualBillingService {
  private readonly logger = new Logger('ManualBilling');

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SUBSCRIPTION_SETTINGS) private readonly settings: SubscriptionSettings,
  ) {}

  /** The owner's open request, if any. */
  async openRequest(db: Db, organizationId: string): Promise<PlanRequestView | null> {
    const [row] = await this.requests(db, organizationId, true);
    return row ?? null;
  }

  private async requests(db: Db, organizationId: string, openOnly: boolean) {
    const rows = await db
      .select({ request: subscriptionPlanRequests, requestedBy: users.fullName })
      .from(subscriptionPlanRequests)
      .innerJoin(
        organizationMembers,
        eq(organizationMembers.id, subscriptionPlanRequests.requestedByMemberId),
      )
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(subscriptionPlanRequests.organizationId, organizationId),
          openOnly ? eq(subscriptionPlanRequests.status, 'open') : undefined,
        ),
      )
      .orderBy(desc(subscriptionPlanRequests.createdAt))
      .limit(openOnly ? 1 : 20);
    return rows.map(({ request, requestedBy }) => requestView(request, requestedBy));
  }

  /**
   * The owner asks for a plan (the business's usage was checked by the caller); a
   * newer request replaces an open one. Refused for the plan the business already
   * pays for by hand.
   */
  async request(
    organizationId: string,
    memberId: string,
    input: { plan: PaidPlanKey; interval: BillingInterval },
  ): Promise<PlanRequestView> {
    return this.connection.db.transaction(async (tx) => {
      const { subscription, plan, running } = await this.lock(tx, organizationId);
      if (running && plan === input.plan && subscription.billingInterval === input.interval) {
        throw new ConflictException('The business is already on this plan');
      }
      await tx
        .update(subscriptionPlanRequests)
        .set({ status: 'cancelled', decidedAt: sql`now()` })
        .where(
          and(
            eq(subscriptionPlanRequests.organizationId, organizationId),
            eq(subscriptionPlanRequests.status, 'open'),
          ),
        );
      await tx.insert(subscriptionPlanRequests).values({
        organizationId,
        plan: input.plan,
        billingInterval: input.interval,
        requestedByMemberId: memberId,
      });
      this.logger.log(
        `Business ${organizationId} asked for the ${input.plan} plan, ${input.interval}`,
      );
      const [open] = (await this.requests(tx, organizationId, true)) as [PlanRequestView];
      return open;
    });
  }

  /** The subscription, its plan and where it stands, locked for this transaction. */
  private async lock(tx: Transaction, organizationId: string) {
    const [row] = (await tx
      .select({ subscription: subscriptions, plan: organizations.plan, now: dbNowMs })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(eq(subscriptions.organizationId, organizationId))
      .for('update', { of: subscriptions })) as [
      { subscription: SubscriptionRow; plan: PlanKey; now: number },
    ];
    const state = subscriptionState(
      subscriptionRecord(row.subscription),
      new Date(row.now),
      this.settings.graceDays,
    );
    const { subscription } = row;
    return {
      ...row,
      state,
      /** Invoiced by us and paid up to now, not ending. */
      running:
        subscription.gateway === 'manual' &&
        state.status === 'active' &&
        !subscription.cancelAtPeriodEnd,
    };
  }

  /** What the operator needs to bill a business by hand. */
  async billing(organizationId: string): Promise<TenantBillingView> {
    const { db } = this.connection;
    const requests = await this.requests(db, organizationId, false);
    return {
      collection: this.settings.gateway.name,
      planRequest: requests.find((request) => request.status === 'open') ?? null,
      requests,
      invoices: await invoicesOf(db, organizationId),
    };
  }

  /**
   * An operator applies the owner's request. A business we already invoice changes
   * in place: the new limits at once, the new price from its next invoice (no
   * proration). Any other (trial, ended, set by hand) gets its first invoice now,
   * for one period from today, payable today; the plan starts when its payment is
   * recorded. Refused while an invoice is unpaid, for a business paying online, or
   * when the business has outgrown the plan since asking.
   */
  async applyRequest(
    organizationId: string,
    requestId: string,
    operatorUserId: string,
  ): Promise<void> {
    await this.connection.db.transaction(async (tx) => {
      const { subscription, plan, state, running } = await this.lock(tx, organizationId);
      const request = await this.openRequestRow(tx, organizationId, requestId);
      const requested = request.plan as PaidPlanKey;
      requireRoomOn(requested, await planUsage(tx, organizationId));
      const unpaid = await unpaidManualInvoice(tx, organizationId);
      if (unpaid !== null) {
        throw new ConflictException(
          `Invoice ${unpaid.number} is not paid yet. Record its payment before changing the plan.`,
        );
      }
      const online = subscription.gateway !== null && subscription.gateway !== 'manual';
      if (online && state.status === 'active') {
        throw new ConflictException(
          'This business pays online; its owner changes the plan under Billing.',
        );
      }
      if (running) {
        await tx
          .update(organizations)
          .set({ plan: requested, updatedAt: sql`now()` })
          .where(eq(organizations.id, organizationId));
        await tx
          .update(subscriptions)
          .set({ billingInterval: request.billingInterval, updatedAt: sql`now()` })
          .where(eq(subscriptions.organizationId, organizationId));
        await tx.insert(subscriptionPlanChanges).values({
          organizationId,
          fromPlan: plan,
          toPlan: requested,
          billingInterval: request.billingInterval,
          source: 'operator',
          changedByUserId: operatorUserId,
        });
      } else {
        const usage = await planUsage(tx, organizationId);
        const [period] = (
          await tx.execute<{ start: string; end: string }>(
            sql`select ${indiaToday} as start, ${periodEndFrom(indiaToday, request.billingInterval)} as "end"`,
          )
        ).rows as [{ start: string; end: string }];
        await insertSubscriptionInvoice(tx, this.settings, {
          organizationId,
          plan: requested,
          interval: request.billingInterval,
          quantity: Math.max(1, usage.stores),
          periodStart: period.start,
          periodEnd: period.end,
          dueOn: period.start,
          gateway: 'manual',
          gatewayPaymentId: null,
        });
      }
      await this.decide(tx, request.id, 'applied', operatorUserId);
    });
    this.logger.log(`Plan request ${requestId} of business ${organizationId} applied`);
  }

  /** An operator turns the owner's request down (the owner can ask again). */
  async declineRequest(
    organizationId: string,
    requestId: string,
    operatorUserId: string,
  ): Promise<void> {
    await this.connection.db.transaction(async (tx) => {
      const request = await this.openRequestRow(tx, organizationId, requestId);
      await this.decide(tx, request.id, 'cancelled', operatorUserId);
    });
  }

  private async openRequestRow(
    tx: Transaction,
    organizationId: string,
    requestId: string,
  ): Promise<RequestRow> {
    const [request] = await tx
      .select()
      .from(subscriptionPlanRequests)
      .where(
        and(
          eq(subscriptionPlanRequests.id, requestId),
          eq(subscriptionPlanRequests.organizationId, organizationId),
        ),
      )
      .for('update');
    if (!request) throw new NotFoundException('Plan request not found');
    if (request.status !== 'open') {
      throw new ConflictException('This plan request has already been decided');
    }
    return request;
  }

  private async decide(
    tx: Transaction,
    requestId: string,
    status: 'applied' | 'cancelled',
    operatorUserId: string,
  ): Promise<void> {
    await tx
      .update(subscriptionPlanRequests)
      .set({ status, decidedByUserId: operatorUserId, decidedAt: sql`now()` })
      .where(eq(subscriptionPlanRequests.id, requestId));
  }

  /**
   * An operator records the money that arrived for a manual invoice (at most the
   * invoice total: less when the business deducted TDS). It settles the invoice and
   * pays for its period: the subscription is active, on the invoice's plan, to the
   * end of that period, whatever it was before (trial, ended, past due).
   */
  async recordPayment(
    organizationId: string,
    invoiceId: string,
    input: RecordSubscriptionPaymentRequest,
    operatorUserId: string,
  ): Promise<void> {
    await this.connection.db.transaction(async (tx) => {
      const { subscription, plan } = await this.lock(tx, organizationId);
      const [found] = await tx
        .select({ invoice: subscriptionInvoices, paymentId: subscriptionPayments.id })
        .from(subscriptionInvoices)
        .leftJoin(subscriptionPayments, eq(subscriptionPayments.invoiceId, subscriptionInvoices.id))
        .where(
          and(
            eq(subscriptionInvoices.id, invoiceId),
            eq(subscriptionInvoices.organizationId, organizationId),
          ),
        );
      if (!found) throw new NotFoundException('Invoice not found');
      const { invoice } = found;
      if (invoice.gateway !== 'manual' || found.paymentId !== null) {
        throw new ConflictException(`Invoice ${invoice.number} is already paid`);
      }
      if (input.amountPaise > invoice.totalPaise) {
        throw fieldError('amountPaise', 'A payment cannot be more than the invoice total');
      }
      const [dates] = (
        await tx.execute<{ future: boolean }>(
          sql`select ${input.paidOn}::date > ${indiaToday}::date as future`,
        )
      ).rows as [{ future: boolean }];
      if (dates.future) throw fieldError('paidOn', 'A payment cannot be dated in the future');

      await tx.insert(subscriptionPayments).values({
        organizationId,
        invoiceId,
        amountPaise: input.amountPaise,
        paidOn: input.paidOn,
        mode: input.mode,
        reference: input.reference,
        recordedByUserId: operatorUserId,
      });
      await this.payForPeriod(tx, invoice, { subscription, plan, operatorUserId });
    });
    this.logger.log(`Payment recorded for invoice ${invoiceId} of business ${organizationId}`);
  }

  private async payForPeriod(
    tx: Transaction,
    invoice: InvoiceRow,
    current: { subscription: SubscriptionRow; plan: PlanKey; operatorUserId: string },
  ): Promise<void> {
    const { organizationId } = invoice;
    const { subscription } = current;
    if (
      subscription.gateway !== 'manual' ||
      current.plan !== invoice.plan ||
      subscription.billingInterval !== invoice.billingInterval
    ) {
      await tx
        .update(organizations)
        .set({ plan: invoice.plan, updatedAt: sql`now()` })
        .where(eq(organizations.id, organizationId));
      await tx.insert(subscriptionPlanChanges).values({
        organizationId,
        fromPlan: current.plan,
        toPlan: invoice.plan,
        billingInterval: invoice.billingInterval,
        source: 'operator',
        changedByUserId: current.operatorUserId,
      });
    }
    await tx
      .update(subscriptions)
      .set({
        status: 'active',
        gateway: 'manual',
        gatewaySubscriptionId: null,
        billingInterval: invoice.billingInterval,
        storeQuantity: invoice.storeQuantity,
        currentPeriodStart: startOfIndiaDay(invoice.periodStart),
        currentPeriodEnd: startOfIndiaDay(sql`(${invoice.periodEnd}::date + 1)::text`),
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        pastDueSince: null,
        updatedAt: sql`now()`,
      })
      .where(eq(subscriptions.organizationId, organizationId));
  }

  /**
   * The renewal job (the background worker runs it): for every business we invoice
   * that is running and not ending, raises the next period's invoice when the paid
   * period ends within RENEWAL_INVOICE_LEAD_DAYS, payable on the day that period
   * starts. Once per period (a unique index backs it), never while an earlier invoice
   * is unpaid, never for a suspended business; on the current plan and interval, for
   * the stores active today. Several servers share the work (SKIP LOCKED).
   */
  raiseRenewals(): Promise<number> {
    return this.connection.db.transaction(async (tx) => {
      const due = await tx
        .select({
          organizationId: subscriptions.organizationId,
          plan: organizations.plan,
          interval: subscriptions.billingInterval,
          start: sql<string>`((${subscriptions.currentPeriodEnd} at time zone 'Asia/Kolkata')::date)::text`,
        })
        .from(subscriptions)
        .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
        .where(
          and(
            eq(subscriptions.gateway, 'manual'),
            eq(subscriptions.status, 'active'),
            eq(subscriptions.cancelAtPeriodEnd, false),
            sql`${organizations.suspendedAt} is null`,
            sql`${organizations.plan} <> 'trial'`,
            sql`${subscriptions.currentPeriodEnd} <= now() + make_interval(days => ${RENEWAL_INVOICE_LEAD_DAYS})`,
            sql`not exists (
              select 1 from subscription_invoices i
              where i.organization_id = ${subscriptions.organizationId} and i.gateway = 'manual'
                and not exists (select 1 from subscription_payments p where p.invoice_id = i.id))`,
          ),
        )
        .orderBy(subscriptions.currentPeriodEnd)
        .limit(RENEWAL_BATCH)
        .for('update', { of: subscriptions, skipLocked: true });
      for (const renewal of due) {
        // Every manual subscription has an interval (subscriptions_paid_billing).
        const interval = String(renewal.interval) as BillingInterval;
        const usage = await planUsage(tx, renewal.organizationId);
        const [period] = (
          await tx.execute<{ end: string }>(
            sql`select ${periodEndFrom(renewal.start, interval)} as "end"`,
          )
        ).rows as [{ end: string }];
        await insertSubscriptionInvoice(tx, this.settings, {
          organizationId: renewal.organizationId,
          plan: renewal.plan as PaidPlanKey,
          interval,
          quantity: Math.max(1, usage.stores),
          periodStart: renewal.start,
          periodEnd: period.end,
          dueOn: renewal.start,
          gateway: 'manual',
          gatewayPaymentId: null,
        });
      }
      if (due.length > 0) {
        this.logger.log(`Raised ${String(due.length)} renewal invoice(s)`);
      }
      return due.length;
    });
  }
}

function requestView(row: RequestRow, requestedBy: string): PlanRequestView {
  return {
    id: row.id,
    plan: row.plan as PaidPlanKey,
    interval: row.billingInterval,
    status: row.status,
    requestedBy,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
  };
}
