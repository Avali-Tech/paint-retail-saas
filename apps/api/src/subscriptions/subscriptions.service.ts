import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { schema, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  financialYear,
  formatTaxDocumentNumber,
  PAID_PLAN_KEYS,
  planBlockers,
  PLANS,
  subscriptionCharge,
  subscriptionState,
  type BillingInterval,
  type CheckoutView,
  type PaidPlanKey,
  type PlanBlocker,
  type PlanChangeResult,
  type PlanChangeView,
  type PlanKey,
  type PlanUsage,
  type SubscriptionInvoiceView,
  type SubscriptionRecord,
  type SubscriptionState,
  type SubscriptionStatusView,
  type SubscriptionView,
} from '@paint/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { renderInvoicePdf } from '../print/render-invoice-pdf.js';
import { PAYMENT_GATEWAY, type GatewayEvent, type PaymentGateway } from './payment-gateway.js';
import {
  computeSubscriptionInvoice,
  platformSupplier,
  subscriptionBuyer,
  subscriptionInvoiceView,
} from './subscription-invoice.js';
import { SUBSCRIPTION_SETTINGS, type SubscriptionSettings } from './subscriptions.tokens.js';

const {
  organizationMembers,
  organizations,
  paymentGatewayEvents,
  subscriptionCheckouts,
  subscriptionInvoiceSequences,
  subscriptionInvoices,
  subscriptionPlanChanges,
  subscriptions,
  users,
} = schema;

type Db = DatabaseConnection['db'] | Transaction;
type SubscriptionRow = typeof subscriptions.$inferSelect;
type CheckoutRow = typeof subscriptionCheckouts.$inferSelect;
type InvoiceRow = typeof subscriptionInvoices.$inferSelect;

/** The database clock in milliseconds: every comparison with time uses it, never Node's. */
const dbNowMs = sql<number>`(extract(epoch from now()) * 1000)::float8`.mapWith(Number);

const iso = (date: Date | null) => (date ? date.toISOString() : null);

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

const READ_ONLY_MESSAGES: Readonly<Record<string, string>> = {
  past_due:
    'Your subscription payment is overdue, so the business is read-only. The owner can pay under Billing.',
  expired:
    'Your free trial has ended, so the business is read-only. The owner can choose a plan under Billing.',
  cancelled:
    'Your subscription has ended, so the business is read-only. The owner can choose a plan under Billing.',
};

/**
 * SaaS subscriptions (roadmap P2-M08): the owner's billing, the gateway's webhooks
 * and our GST invoices. Every write here is platform scope: tenants may only read
 * these tables, so a business changes its plan only through these checks.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger('Subscriptions');

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(SUBSCRIPTION_SETTINGS) private readonly settings: SubscriptionSettings,
  ) {}

  /** Only the business's owner, signed in as themself, manages its subscription. */
  static requireOwner(auth: AuthContext): void {
    if (auth.role.key !== 'owner' || auth.supportGrantId !== undefined) {
      throw new ForbiddenException('Only the owner of the business can manage its subscription');
    }
  }

  /** The stored subscription, the plan and the database clock; platform scope. */
  private async current(db: Db, organizationId: string) {
    // Every business has one (set up with it, migration 0070 for older ones).
    const [row] = (await db
      .select({ subscription: subscriptions, plan: organizations.plan, now: dbNowMs })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(eq(subscriptions.organizationId, organizationId))) as [
      { subscription: SubscriptionRow; plan: PlanKey; now: number },
    ];
    const state = subscriptionState(
      subscriptionRecord(row.subscription),
      new Date(row.now),
      this.settings.graceDays,
    );
    return { ...row, state };
  }

  /** Whether the business may write: used on every change a member makes. */
  async accessState(organizationId: string): Promise<SubscriptionState> {
    return (await this.current(this.connection.db, organizationId)).state;
  }

  /** The message a read-only business gets when it tries to change something. */
  static readOnlyMessage(state: SubscriptionState): string {
    return String(READ_ONLY_MESSAGES[state.status]);
  }

  /** For every member: enough to warn about the trial or a payment, or hold back changes. */
  async status(auth: AuthContext): Promise<SubscriptionStatusView> {
    const { subscription, plan, state } = await this.current(
      this.connection.db,
      auth.organization.id,
    );
    return statusView(subscription, plan, state);
  }

  /** The owner's Billing page. */
  async view(auth: AuthContext): Promise<SubscriptionView> {
    SubscriptionsService.requireOwner(auth);
    return this.viewOf(this.connection.db, auth.organization.id);
  }

  private async viewOf(db: Db, organizationId: string): Promise<SubscriptionView> {
    const { subscription, plan, state } = await this.current(db, organizationId);
    const usage = await planUsage(db, organizationId);
    const history = await db
      .select({
        change: subscriptionPlanChanges,
        memberName: users.fullName,
      })
      .from(subscriptionPlanChanges)
      .leftJoin(
        organizationMembers,
        eq(organizationMembers.id, subscriptionPlanChanges.changedByMemberId),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(subscriptionPlanChanges.organizationId, organizationId))
      .orderBy(desc(subscriptionPlanChanges.createdAt), desc(subscriptionPlanChanges.id))
      .limit(50);
    const { maxStores, maxMembers, name } = PLANS[plan];
    return {
      ...statusView(subscription, plan, state),
      planName: name,
      limits: { maxStores, maxMembers },
      usage,
      interval: subscription.billingInterval,
      quantity: subscription.storeQuantity,
      currentPeriodStart: iso(subscription.currentPeriodStart),
      pastDueSince: iso(subscription.pastDueSince),
      gateway: subscription.gateway,
      offers: PAID_PLAN_KEYS.map((key) => ({
        plan: key,
        name: PLANS[key].name,
        maxStores: PLANS[key].maxStores,
        maxMembers: PLANS[key].maxMembers,
        charges: {
          monthly: subscriptionCharge(key, 'monthly', usage.stores),
          annual: subscriptionCharge(key, 'annual', usage.stores),
        },
        blockers: planBlockers(key, usage),
      })),
      history: history.map(({ change, memberName }): PlanChangeView => ({
        id: change.id,
        fromPlan: change.fromPlan,
        toPlan: change.toPlan,
        interval: change.billingInterval,
        source: change.source,
        changedBy: memberName,
        at: change.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Moves the business to a paid plan. A running paid subscription changes in place:
   * the limits at once, the price from the next period (no proration). Anything
   * else (a trial, a plan set by hand, a lapsed or cancelled subscription) pays
   * first: the plan changes when the gateway reports the payment. Refused while
   * the business uses more than the plan allows.
   */
  async change(
    auth: AuthContext,
    input: { plan: PaidPlanKey; interval: BillingInterval },
  ): Promise<PlanChangeResult> {
    SubscriptionsService.requireOwner(auth);
    const organizationId = auth.organization.id;
    const { db } = this.connection;
    const { subscription, plan, state } = await this.current(db, organizationId);
    const usage = await planUsage(db, organizationId);
    const blockers = planBlockers(input.plan, usage);
    if (blockers.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'plan_limits_exceeded',
        message: planRefusal(input.plan, blockers),
        blockers,
      });
    }
    const gatewayId = subscription.gatewaySubscriptionId;
    if (gatewayId === null || state.status !== 'active' || subscription.cancelAtPeriodEnd) {
      return { kind: 'checkout', checkout: await this.startCheckout(auth, input, usage) };
    }
    if (plan === input.plan && subscription.billingInterval === input.interval) {
      throw new ConflictException('The business is already on this plan');
    }
    const quantity = Math.max(1, usage.stores);
    await this.gateway.changePlan(gatewayId, { ...input, quantity });
    await db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({ plan: input.plan, updatedAt: sql`now()` })
        .where(eq(organizations.id, organizationId));
      await tx
        .update(subscriptions)
        .set({ billingInterval: input.interval, storeQuantity: quantity, updatedAt: sql`now()` })
        .where(eq(subscriptions.organizationId, organizationId));
      await tx.insert(subscriptionPlanChanges).values({
        organizationId,
        fromPlan: plan,
        toPlan: input.plan,
        billingInterval: input.interval,
        source: 'owner',
        changedByMemberId: auth.memberId,
      });
    });
    this.logger.log(
      `Plan changed in place for business ${organizationId}: ${plan} → ${input.plan}`,
    );
    return { kind: 'changed', subscription: await this.viewOf(db, organizationId) };
  }

  private async startCheckout(
    auth: AuthContext,
    input: { plan: PaidPlanKey; interval: BillingInterval },
    usage: PlanUsage,
  ): Promise<CheckoutView> {
    const charge = subscriptionCharge(input.plan, input.interval, usage.stores);
    const checkoutId = randomUUID();
    const created = await this.gateway.createSubscription({
      checkoutId,
      organizationId: auth.organization.id,
      plan: input.plan,
      interval: input.interval,
      quantity: charge.quantity,
      totalPaise: charge.totalPaise,
    });
    const [row] = (await this.connection.db
      .insert(subscriptionCheckouts)
      .values({
        id: checkoutId,
        organizationId: auth.organization.id,
        plan: input.plan,
        billingInterval: input.interval,
        storeQuantity: charge.quantity,
        totalPaise: charge.totalPaise,
        gateway: this.gateway.name,
        gatewaySubscriptionId: created.gatewaySubscriptionId,
        checkoutUrl: created.checkoutUrl,
        createdByMemberId: auth.memberId,
      })
      .returning()) as [CheckoutRow];
    return checkoutView(row);
  }

  async checkout(auth: AuthContext, checkoutId: string): Promise<CheckoutView> {
    SubscriptionsService.requireOwner(auth);
    return checkoutView(await this.findCheckout(auth.organization.id, checkoutId));
  }

  private async findCheckout(organizationId: string, checkoutId: string): Promise<CheckoutRow> {
    const [row] = await this.connection.db
      .select()
      .from(subscriptionCheckouts)
      .where(
        and(
          eq(subscriptionCheckouts.id, checkoutId),
          eq(subscriptionCheckouts.organizationId, organizationId),
        ),
      );
    if (!row) throw new NotFoundException('Checkout not found');
    return row;
  }

  /**
   * The fake gateway's "Pay" button: it sends the signed webhook a real gateway
   * would, and that goes through the same checks. Only with the fake gateway.
   */
  async fakePay(auth: AuthContext, checkoutId: string, fake: FakePayer): Promise<CheckoutView> {
    SubscriptionsService.requireOwner(auth);
    const row = await this.findCheckout(auth.organization.id, checkoutId);
    if (row.status === 'paid') throw new ConflictException('This checkout is already paid');
    const webhook = fake.webhook('charged', row.gatewaySubscriptionId, {
      amountPaise: row.totalPaise,
    });
    await this.receiveWebhook(webhook.body, webhook.headers);
    return checkoutView(await this.findCheckout(auth.organization.id, checkoutId));
  }

  /** Stops renewal: the paid period runs to its end, then the business is read-only. */
  async cancel(auth: AuthContext): Promise<SubscriptionView> {
    SubscriptionsService.requireOwner(auth);
    const organizationId = auth.organization.id;
    const { db } = this.connection;
    const { subscription, state } = await this.current(db, organizationId);
    if (subscription.gatewaySubscriptionId === null || state.status !== 'active') {
      throw new ConflictException('Only a paid subscription that is running can be cancelled');
    }
    if (subscription.cancelAtPeriodEnd) {
      throw new ConflictException('The subscription already ends with this period');
    }
    await this.gateway.cancelAtPeriodEnd(subscription.gatewaySubscriptionId);
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: sql`now()` })
      .where(eq(subscriptions.organizationId, organizationId));
    this.logger.log(`Subscription of business ${organizationId} ends with its period`);
    return this.viewOf(db, organizationId);
  }

  /**
   * A webhook from the gateway. Its signature is checked against the raw body
   * before anything in it is believed; each event is applied once, however often
   * it is delivered. Answers what happened, or null for a bad signature.
   */
  async receiveWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, unknown>>,
  ): Promise<'applied' | 'duplicate' | 'ignored' | null> {
    const event = this.gateway.verifyWebhook(rawBody, headers);
    if (event === null) {
      this.logger.warn(`Refused a ${this.gateway.name} webhook with a bad signature`);
      return null;
    }
    const outcome = await this.connection.db.transaction((tx) => this.apply(tx, event));
    this.logger.log(
      `Webhook ${event.gatewayType} (${event.id}) from ${this.gateway.name}: ${outcome}`,
    );
    return outcome;
  }

  private async apply(
    tx: Transaction,
    event: GatewayEvent,
  ): Promise<'applied' | 'duplicate' | 'ignored'> {
    const gateway = this.gateway.name;
    const recorded = await tx
      .insert(paymentGatewayEvents)
      .values({
        gateway,
        eventId: event.id,
        type: event.gatewayType,
        gatewaySubscriptionId: event.gatewaySubscriptionId,
      })
      .onConflictDoNothing()
      .returning({ eventId: paymentGatewayEvents.eventId });
    if (recorded.length === 0) return 'duplicate';
    if (event.type === 'ignored' || event.gatewaySubscriptionId === null) return 'ignored';

    const subscriptionId = event.gatewaySubscriptionId;
    const [checkout] = await tx
      .select()
      .from(subscriptionCheckouts)
      .where(
        and(
          eq(subscriptionCheckouts.gateway, gateway),
          eq(subscriptionCheckouts.gatewaySubscriptionId, subscriptionId),
        ),
      )
      .for('update');
    const [owned] = await tx
      .select({ organizationId: subscriptions.organizationId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.gateway, gateway),
          eq(subscriptions.gatewaySubscriptionId, subscriptionId),
        ),
      );
    const organizationId = checkout?.organizationId ?? owned?.organizationId;
    if (organizationId === undefined) return 'ignored';
    await tx
      .update(paymentGatewayEvents)
      .set({ organizationId })
      .where(
        and(eq(paymentGatewayEvents.gateway, gateway), eq(paymentGatewayEvents.eventId, event.id)),
      );
    // A checkout's first payment makes its plan the business's, once.
    const starting =
      checkout?.status === 'open' && (event.type === 'activated' || event.type === 'charged')
        ? checkout
        : null;
    // A new checkout's events count; an older gateway subscription the business left does not.
    if (starting === null && owned === undefined) return 'ignored';

    if (event.type === 'payment_failed') {
      await tx
        .update(subscriptions)
        .set({
          status: 'past_due',
          pastDueSince: sql`coalesce(${subscriptions.pastDueSince}, now())`,
          updatedAt: sql`now()`,
        })
        .where(eq(subscriptions.organizationId, organizationId));
      return 'applied';
    }
    if (event.type === 'cancelled') {
      await tx
        .update(subscriptions)
        .set({
          status: 'cancelled',
          cancelledAt: sql`now()`,
          cancelAtPeriodEnd: false,
          pastDueSince: null,
          updatedAt: sql`now()`,
        })
        .where(eq(subscriptions.organizationId, organizationId));
      return 'applied';
    }
    if (starting !== null) await this.startPlan(tx, starting);
    const [subscription] = (await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId))) as [SubscriptionRow];
    // Every paid subscription has an interval (subscriptions_paid_billing).
    const interval = String(subscription.billingInterval) as BillingInterval;
    const length = interval === 'annual' ? sql`interval '1 year'` : sql`interval '1 month'`;
    const periodStart = event.periodStart ?? sql`now()`;
    const periodEnd = event.periodEnd ?? sql`now() + ${length}`;
    await tx
      .update(subscriptions)
      .set({
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        pastDueSince: null,
        updatedAt: sql`now()`,
      })
      .where(eq(subscriptions.organizationId, organizationId));
    if (event.type === 'charged' && event.paymentId !== null) {
      await this.issueInvoice(tx, organizationId, event);
    }
    return 'applied';
  }

  /** The checkout is paid: the business moves to its plan on the gateway's subscription. */
  private async startPlan(tx: Transaction, checkout: CheckoutRow): Promise<void> {
    const { organizationId } = checkout;
    const [business] = (await tx
      .select({ plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('update')) as [{ plan: PlanKey }];
    await tx
      .update(subscriptionCheckouts)
      .set({ status: 'paid', paidAt: sql`now()` })
      .where(eq(subscriptionCheckouts.id, checkout.id));
    await tx
      .update(organizations)
      .set({ plan: checkout.plan, updatedAt: sql`now()` })
      .where(eq(organizations.id, organizationId));
    await tx
      .update(subscriptions)
      .set({
        status: 'active',
        gateway: checkout.gateway,
        gatewaySubscriptionId: checkout.gatewaySubscriptionId,
        billingInterval: checkout.billingInterval,
        storeQuantity: checkout.storeQuantity,
        // Placeholders: the caller sets the paid period right after.
        currentPeriodStart: sql`now()`,
        currentPeriodEnd: sql`now() + interval '1 day'`,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        pastDueSince: null,
        updatedAt: sql`now()`,
      })
      .where(eq(subscriptions.organizationId, organizationId));
    await tx.insert(subscriptionPlanChanges).values({
      organizationId,
      fromPlan: business.plan,
      toPlan: checkout.plan,
      billingInterval: checkout.billingInterval,
      source: 'owner',
      changedByMemberId: checkout.createdByMemberId,
    });
    this.logger.log(`Business ${organizationId} paid for the ${checkout.plan} plan`);
  }

  /** Our GST invoice for one payment, numbered in the platform's series; once per payment. */
  private async issueInvoice(
    tx: Transaction,
    organizationId: string,
    event: GatewayEvent,
  ): Promise<void> {
    const [row] = (await tx
      .select({
        plan: organizations.plan,
        interval: subscriptions.billingInterval,
        quantity: subscriptions.storeQuantity,
        issuedOn: sql<string>`((now() at time zone 'Asia/Kolkata')::date)::text`,
        periodStart: sql<string>`((${subscriptions.currentPeriodStart} at time zone 'Asia/Kolkata')::date)::text`,
        periodEnd: sql<string>`(((${subscriptions.currentPeriodEnd} - interval '1 second') at time zone 'Asia/Kolkata')::date)::text`,
      })
      .from(subscriptions)
      .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(eq(subscriptions.organizationId, organizationId))) as [
      {
        plan: PaidPlanKey;
        interval: BillingInterval;
        quantity: number;
        issuedOn: string;
        periodStart: string;
        periodEnd: string;
      },
    ];
    const paymentId = String(event.paymentId);
    const [already] = await tx
      .select({ id: subscriptionInvoices.id })
      .from(subscriptionInvoices)
      .where(
        and(
          eq(subscriptionInvoices.gateway, this.gateway.name),
          eq(subscriptionInvoices.gatewayPaymentId, paymentId),
        ),
      );
    if (already) return;
    const { platform } = this.settings;
    const fy = financialYear(row.issuedOn);
    const [sequence] = (await tx
      .insert(subscriptionInvoiceSequences)
      .values({ financialYear: fy, lastValue: 1 })
      .onConflictDoUpdate({
        target: subscriptionInvoiceSequences.financialYear,
        set: { lastValue: sql`${subscriptionInvoiceSequences.lastValue} + 1` },
      })
      .returning({ value: subscriptionInvoiceSequences.lastValue })) as [{ value: number }];
    // Rule 46(b): at most 16 characters (PRS/26-27/000001).
    const digits = 16 - 7 - platform.invoicePrefix.length;
    const input = {
      number: formatTaxDocumentNumber(platform.invoicePrefix, fy, sequence.value, digits),
      issuedOn: row.issuedOn,
      plan: row.plan,
      interval: row.interval,
      quantity: row.quantity,
      unitPricePaise: PLANS[row.plan].prices[row.interval],
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      sacCode: platform.sacCode,
      supplier: platformSupplier(platform),
      buyer: await subscriptionBuyer(tx, organizationId),
      paymentReference: paymentId,
    };
    const invoice = computeSubscriptionInvoice(input);
    const { totals } = invoice;
    if (event.amountPaise !== null && event.amountPaise !== totals.payablePaise) {
      this.logger.warn(
        `Payment ${paymentId} for business ${organizationId} was ${String(event.amountPaise)} paise; the invoice is ${String(totals.payablePaise)}. Check the gateway's plan prices.`,
      );
    }
    await tx.insert(subscriptionInvoices).values({
      organizationId,
      number: input.number,
      financialYear: fy,
      serial: sequence.value,
      issuedOn: input.issuedOn,
      plan: input.plan,
      billingInterval: input.interval,
      storeQuantity: input.quantity,
      unitPricePaise: input.unitPricePaise,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sacCode: input.sacCode,
      rateBps: 1800,
      placeOfSupply: invoice.placeOfSupply,
      taxablePaise: totals.taxablePaise,
      cgstPaise: totals.cgstPaise,
      sgstPaise: totals.sgstPaise,
      igstPaise: totals.igstPaise,
      totalPaise: totals.payablePaise,
      supplier: input.supplier,
      buyer: input.buyer,
      gateway: this.gateway.name,
      gatewayPaymentId: paymentId,
    });
  }

  /** Our invoices to the business, newest first. */
  async invoices(auth: AuthContext): Promise<SubscriptionInvoiceView[]> {
    SubscriptionsService.requireOwner(auth);
    const rows = await this.connection.db
      .select()
      .from(subscriptionInvoices)
      .where(eq(subscriptionInvoices.organizationId, auth.organization.id))
      .orderBy(desc(subscriptionInvoices.issuedOn), desc(subscriptionInvoices.serial));
    return rows.map(invoiceView);
  }

  /** One invoice as an A4 PDF, drawn by the same renderer as the business's own invoices. */
  async invoicePdf(auth: AuthContext, invoiceId: string): Promise<{ number: string; pdf: Buffer }> {
    SubscriptionsService.requireOwner(auth);
    const [row] = await this.connection.db
      .select()
      .from(subscriptionInvoices)
      .where(
        and(
          eq(subscriptionInvoices.id, invoiceId),
          eq(subscriptionInvoices.organizationId, auth.organization.id),
        ),
      );
    if (!row) throw new NotFoundException('Invoice not found');
    const view = subscriptionInvoiceView({
      number: row.number,
      issuedOn: row.issuedOn,
      plan: row.plan as PaidPlanKey,
      interval: row.billingInterval,
      quantity: row.storeQuantity,
      unitPricePaise: row.unitPricePaise,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      sacCode: row.sacCode,
      supplier: row.supplier,
      buyer: row.buyer,
      paymentReference: row.gatewayPaymentId,
    });
    return { number: row.number, pdf: await renderInvoicePdf(view) };
  }

  /**
   * The platform gives a trial business more days, also after its trial ended.
   * Refused once the business pays or its plan was set by hand.
   */
  async extendTrial(organizationId: string, days: number): Promise<void> {
    const { db } = this.connection;
    const { subscription } = await this.current(db, organizationId);
    if (subscription.status !== 'trialing' && subscription.status !== 'expired') {
      throw new ConflictException('Only a business on its free trial can have the trial extended');
    }
    await db
      .update(subscriptions)
      .set({
        status: 'trialing',
        trialEndsAt: sql`greatest(coalesce(${subscriptions.trialEndsAt}, now()), now()) + make_interval(days => ${days})`,
        updatedAt: sql`now()`,
      })
      .where(eq(subscriptions.organizationId, organizationId));
    this.logger.log(`Trial of business ${organizationId} extended by ${String(days)} days`);
  }

  /**
   * The platform set the plan by hand (console): recorded in the history. A paid
   * plan set while the business was not paying online is active, invoiced outside
   * the product; the trial set again starts a fresh trial. Runs in the update's
   * transaction.
   */
  async recordOperatorChange(
    tx: Transaction,
    change: { organizationId: string; from: PlanKey; to: PlanKey; operatorUserId: string },
  ): Promise<void> {
    const { organizationId } = change;
    await tx.insert(subscriptionPlanChanges).values({
      organizationId,
      fromPlan: change.from,
      toPlan: change.to,
      source: 'operator',
      changedByUserId: change.operatorUserId,
    });
    if (change.to === 'trial') {
      await tx
        .update(subscriptions)
        .set({
          status: 'trialing',
          trialEndsAt: sql`now() + make_interval(days => ${this.settings.trialDays})`,
          ...NO_GATEWAY,
        })
        .where(eq(subscriptions.organizationId, organizationId));
      return;
    }
    await tx
      .update(subscriptions)
      .set({ status: 'active', trialEndsAt: null, ...NO_GATEWAY })
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          sql`(${subscriptions.gateway} is null or ${subscriptions.status} <> 'active')`,
        ),
      );
  }
}

/** A subscription no longer collected by the gateway. */
const NO_GATEWAY = {
  gateway: null,
  gatewaySubscriptionId: null,
  billingInterval: null,
  storeQuantity: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  cancelledAt: null,
  updatedAt: sql`now()`,
};

/** Fake-gateway webhooks, for the fake checkout's "Pay" button. */
export interface FakePayer {
  webhook(
    type: 'charged',
    subscriptionId: string,
    payment: { amountPaise: number },
  ): { body: Buffer; headers: Record<string, string> };
}

/** Active stores and team members, counted as requireRoomFor counts them; platform scope. */
export async function planUsage(db: Db, organizationId: string): Promise<PlanUsage> {
  const result = await db.execute<{ stores: number; members: number }>(sql`
    select
      (select count(*)::int from stores s where s.organization_id = ${organizationId} and s.is_active) as stores,
      (select count(*)::int from organization_members m
        where m.organization_id = ${organizationId} and m.is_active and not m.is_support) as members`);
  const [row] = result.rows as [{ stores: number; members: number }];
  return { stores: row.stores, members: row.members };
}

function statusView(
  subscription: SubscriptionRow,
  plan: PlanKey,
  state: SubscriptionState,
): SubscriptionStatusView {
  return {
    plan,
    status: state.status,
    readOnly: state.readOnly,
    trialEndsAt: iso(subscription.trialEndsAt),
    trialDaysLeft: state.trialDaysLeft,
    currentPeriodEnd: iso(subscription.currentPeriodEnd),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    graceEndsAt: state.graceEndsAt,
  };
}

function checkoutView(row: CheckoutRow): CheckoutView {
  return {
    id: row.id,
    plan: row.plan as PaidPlanKey,
    interval: row.billingInterval,
    quantity: row.storeQuantity,
    totalPaise: row.totalPaise,
    gateway: row.gateway,
    checkoutUrl: row.checkoutUrl,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function invoiceView(row: InvoiceRow): SubscriptionInvoiceView {
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
  };
}
