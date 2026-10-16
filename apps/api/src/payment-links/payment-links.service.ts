import 'reflect-metadata';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  canAccessStore,
  formatINR,
  type LinkPlanProblem,
  type LogCheckoutView,
  type LogWebhook,
  type PaymentLinkCreated,
  type PaymentLinkPage,
  type PaymentLinkSettings,
  type PaymentLinkView,
  type QueueResult,
  type TemplateKey,
} from '@paint/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { idempotent } from '../billing/idempotency.js';
import { DATABASE } from '../database/database.module.js';
import {
  MESSAGING_SETTINGS,
  visibleParty,
  type MessagingSettings,
} from '../messaging/messaging.service.js';
import { previewMessage, queueMessage } from '../messaging/outbox.js';
import { Notifier } from '../notifications/notifier.js';
import { receiveGatewayWebhook, type WebhookOutcome } from '../payments-gateway/gateway-events.js';
import { paymentStore, walkInPartyId } from '../payments/posting.js';
import { whatsappLink } from '../statements/statement-links.service.js';
import { fieldError } from '../tax/tax-lookups.js';
import { runDueLinkRefunds } from './link-refunds.js';
import { applyLinkEvent, createLink, linkSummaries, linkView, planLink } from './links.js';
import {
  PAYMENT_LINK_GATEWAYS,
  PaymentLinkGateways,
  WEBHOOK_PATH,
  linkRulesOf,
} from './payment-link-gateways.js';
import {
  LOG_SIGNATURE_HEADER,
  LogPaymentLinkProvider,
  type PaymentLinkProvider,
} from './payment-link-provider.js';
import type {
  CreatePaymentLinkInput,
  ListPaymentLinksQuery,
  LogPayInput,
  UpdateLinkSettingsInput,
} from './payment-links.schemas.js';

const {
  organizations,
  parties,
  paymentGatewayEvents,
  paymentLinkDocuments,
  paymentLinks,
  salesSettings,
  taxDocuments,
} = schema;

const PROBLEMS: Readonly<Record<Exclude<LinkPlanProblem, 'over_limit'>, string>> = {
  not_open: 'Nothing is left to pay on this bill',
  nothing_due: 'This customer owes nothing of this kind',
  covered_by_advance: "The customer's advance covers what is owed: allocate it instead",
  over_due: 'This is more than the customer owes: ask for less, or take it as an advance',
  amount_required: 'Enter the amount of the advance',
};

/** Why a link cannot be made: the business's cap names its amount ([PO-42]). */
function problemMessage(problem: LinkPlanProblem, capPaise: number): string {
  return problem === 'over_limit'
    ? `A link asks for at most ${formatINR(capPaise)}: ask for part of it, or change the limit in Settings`
    : PROBLEMS[problem];
}

/** The message a link goes out in: the invoice's, a reminder's, or a payment request. */
const TEMPLATE_OF: Readonly<Record<CreatePaymentLinkInput['purpose'], TemplateKey>> = {
  invoice: 'invoice_issued',
  overdue: 'payment_reminder_overdue',
  outstanding: 'payment_request',
  advance: 'payment_request',
};

/**
 * UPI payment links (roadmap P2-M32, payment-link half; spec §6.2 PL rules): members ask
 * a customer for money by link; the gateway's signed webhook records and allocates
 * what is paid, with no one entering it.
 */
@Injectable()
export class PaymentLinksService {
  private readonly logger = new Logger('PaymentLinks');

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PAYMENT_LINK_GATEWAYS) private readonly gateways: PaymentLinkGateways,
    @Inject(MESSAGING_SETTINGS) private readonly messaging: MessagingSettings,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  /** Whether this business can make links now, and its link rules (rule PL-13). */
  status(auth: AuthContext): Promise<PaymentLinkSettings> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.statusIn(tx, auth));
  }

  private async statusIn(tx: Transaction, auth: AuthContext): Promise<PaymentLinkSettings> {
    return {
      provider: this.gateways.provider,
      ready: (await this.gateways.forBusiness(tx, auth.organization.id)) !== null,
      ...(await linkRulesOf(tx)),
    };
  }

  /** Owners and admins set how long links live, their cap and their basis ([PO-41] – [PO-43]). */
  updateSettings(auth: AuthContext, input: UpdateLinkSettingsInput): Promise<PaymentLinkSettings> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const values = {
        paymentLinkValidityMinutes: input.validityMinutes,
        paymentLinkCapPaise: input.capPaise,
        paymentLinkAmountBasis: input.amountBasis,
      };
      await tx
        .insert(salesSettings)
        .values({ organizationId: auth.organization.id, ...values })
        .onConflictDoUpdate({
          target: salesSettings.organizationId,
          set: { ...values, updatedAt: sql`now()` },
        });
      return this.statusIn(tx, auth);
    });
  }

  /** The business's gateway now: 409 when its Razorpay account is not connected. */
  private async provider(tx: Transaction, auth: AuthContext): Promise<PaymentLinkProvider> {
    const provider = await this.gateways.forBusiness(tx, auth.organization.id);
    if (provider === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'gateway_not_connected',
        message: 'Connect your Razorpay account in Settings → Payment links first',
      });
    }
    return provider;
  }

  create(
    auth: AuthContext,
    input: CreatePaymentLinkInput,
    idempotencyKey?: string,
  ): Promise<PaymentLinkCreated> {
    if (this.gateways.provider === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'payment_links_off',
        message: 'Payment links are not set up',
      });
    }
    if (input.send === 'whatsapp' && this.messaging.whatsapp === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'whatsapp_off',
        message: 'WhatsApp messages are not set up: share the link instead',
      });
    }
    const request = { method: 'POST', path: '/payment-links', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () =>
        this.createIn(tx, auth, input, await this.provider(tx, auth)),
      ),
    );
  }

  private async createIn(
    tx: Transaction,
    auth: AuthContext,
    input: CreatePaymentLinkInput,
    provider: PaymentLinkProvider,
  ): Promise<PaymentLinkCreated> {
    const party = await visibleParty(tx, auth, input.partyId);
    if (party.id === (await walkInPartyId(tx))) {
      throw fieldError('partyId', 'Walk-in customers pay with their bill at the counter');
    }
    const invoice = input.invoiceId === undefined ? null : await this.invoiceOf(tx, auth, input);
    const storeId = invoice?.storeId ?? input.storeId ?? party.homeStoreId;
    if (storeId === null) {
      throw fieldError('storeId', 'Choose the store the payment is recorded at');
    }
    await paymentStore(tx, auth, storeId, 'storeId');
    const plan = await planLink(tx, {
      partyId: party.id,
      purpose: input.purpose,
      ...(invoice === null ? {} : { documentIds: [invoice.id] }),
      ...(input.amountPaise === undefined ? {} : { amountPaise: input.amountPaise }),
    });
    if (!plan.ok) {
      throw new ConflictException({
        statusCode: 409,
        code: `link_${plan.problem}`,
        message: problemMessage(plan.problem, (await linkRulesOf(tx)).capPaise),
      });
    }
    const id = await createLink(tx, provider, {
      organizationId: auth.organization.id,
      partyId: party.id,
      storeId,
      purpose: input.purpose,
      origin: 'staff',
      targets: plan.targets,
      amountPaise: plan.amountPaise,
      memberId: auth.memberId,
    });
    const [link] = (await linkView(tx, id)) as [PaymentLinkView];
    const message = {
      organizationId: auth.organization.id,
      partyId: party.id,
      templateKey: TEMPLATE_OF[input.purpose],
      variables: await this.variablesOf(
        tx,
        input.purpose,
        link,
        plan.targets,
        invoice?.number ?? null,
      ),
      payLinkUrl: link.url,
    };
    let queued: QueueResult | null = null;
    if (input.send === 'whatsapp') {
      queued = await queueMessage(tx, {
        ...message,
        channel: 'whatsapp',
        reference: { type: 'payment_link', id },
        dedupeKey: `payment_link:${id}`,
        memberId: auth.memberId,
      });
    }
    return {
      link,
      waMeUrl:
        party.phone === null ? null : whatsappLink(party.phone, await previewMessage(tx, message)),
      message: queued,
    };
  }

  /** The invoice of an invoice link: the party's, at a store the member works at. */
  private async invoiceOf(
    tx: Transaction,
    auth: AuthContext,
    input: CreatePaymentLinkInput,
  ): Promise<{ id: string; storeId: string; number: string | null }> {
    const [invoice] = await tx
      .select({
        id: taxDocuments.id,
        storeId: taxDocuments.storeId,
        partyId: taxDocuments.partyId,
        number: taxDocuments.number,
      })
      .from(taxDocuments)
      .where(eq(taxDocuments.id, String(input.invoiceId)));
    if (!invoice || !canAccessStore(auth, invoice.storeId)) {
      throw new NotFoundException('Invoice not found');
    }
    if (invoice.partyId !== input.partyId) {
      throw fieldError('invoiceId', 'This bill is not this customer’s');
    }
    return invoice;
  }

  /** The message's variables; an overdue link names how late its oldest bill is. */
  private async variablesOf(
    tx: Transaction,
    purpose: CreatePaymentLinkInput['purpose'],
    link: PaymentLinkView,
    targets: readonly { dueOn: string | null }[],
    invoiceNumber: string | null,
  ): Promise<Record<string, string>> {
    const amount = formatINR(link.amountPaise);
    if (purpose === 'invoice') return { number: String(invoiceNumber), amount };
    if (purpose !== 'overdue') return { amount };
    // An overdue link pays only bills with a due date, before today.
    const oldest = targets.map((target) => String(target.dueOn)).sort()[0];
    const [row] = (
      await tx.execute<{ days: number }>(
        sql`select ((now() at time zone 'Asia/Kolkata')::date - ${oldest}::date) as days`,
      )
    ).rows as [{ days: number }];
    return { amount, days: String(row.days) };
  }

  /** Links at stores the member works at, newest first. */
  list(auth: AuthContext, query: ListPaymentLinksQuery): Promise<PaymentLinkPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        auth.allStores ? undefined : inArray(paymentLinks.storeId, [...auth.storeIds]),
        query.partyId === undefined ? undefined : eq(paymentLinks.partyId, query.partyId),
        query.storeId === undefined ? undefined : eq(paymentLinks.storeId, query.storeId),
        query.invoiceId === undefined
          ? undefined
          : sql`exists (select 1 from ${paymentLinkDocuments} d
              where d.link_id = ${paymentLinks.id} and d.document_id = ${query.invoiceId})`,
        query.status === undefined
          ? undefined
          : sql`(case when ${paymentLinks.status} = 'created' and ${paymentLinks.expiresAt} <= now()
              then 'expired' else ${paymentLinks.status}::text end) = ${query.status}`,
      );
      return linkSummaries(tx, where, query);
    });
  }

  get(auth: AuthContext, id: string): Promise<PaymentLinkView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [view] = await linkView(tx, id);
      if (!view || !canAccessStore(auth, view.storeId)) {
        throw new NotFoundException('Payment link not found');
      }
      return view;
    });
  }

  /** Stops a link: the gateway is told, so it can no longer be paid (money already sent is still recorded). */
  cancel(auth: AuthContext, id: string): Promise<PaymentLinkView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [link] = await tx
        .select({
          storeId: paymentLinks.storeId,
          status: paymentLinks.status,
          provider: paymentLinks.provider,
          gatewayReference: paymentLinks.gatewayReference,
        })
        .from(paymentLinks)
        .where(eq(paymentLinks.id, id))
        .for('update');
      if (!link || !canAccessStore(auth, link.storeId)) {
        throw new NotFoundException('Payment link not found');
      }
      if (link.status !== 'created') {
        throw new ConflictException(`This link is already ${link.status}`);
      }
      const provider = await this.gateways.forBusiness(tx, auth.organization.id);
      if (provider?.name === link.provider) {
        await provider.cancelPayment(link.gatewayReference);
      }
      await tx
        .update(paymentLinks)
        .set({
          status: 'cancelled',
          cancelledAt: sql`now()`,
          cancelledByMemberId: auth.memberId,
          updatedAt: sql`now()`,
        })
        .where(eq(paymentLinks.id, id));
      const [view] = (await linkView(tx, id)) as [PaymentLinkView];
      return view;
    });
  }

  /**
   * A gateway's webhook (rule PL-6): nothing in it is believed until its signature
   * over the raw body checks out; each event is applied once, however often it comes.
   * Answers what happened, or null for a bad signature.
   */
  async receiveWebhook(
    providerName: string,
    businessRef: string | undefined,
    rawBody: Buffer,
    headers: Readonly<Record<string, unknown>>,
  ): Promise<WebhookOutcome | null> {
    const route = await this.gateways.forWebhook(this.connection.db, providerName, businessRef);
    if (route === null) throw new NotFoundException();
    const { provider, organizationId } = route;
    const received = await receiveGatewayWebhook(
      this.connection.db,
      provider,
      { rawBody, headers },
      {
        objectId: (event) => event.gatewayLinkId ?? event.refund?.id ?? null,
        apply: (tx, event, context) =>
          applyLinkEvent(tx, event, context, {
            provider,
            notifier: this.notifier,
            organizationId,
          }),
      },
    );
    if (received === null) {
      this.logger.warn(`Refused a ${provider.name} payment-link webhook with a bad signature`);
      return null;
    }
    this.logger.log(
      `Payment-link webhook ${received.event.gatewayType} (${received.event.id}): ${received.outcome}`,
    );
    if (received.outcome === 'applied') await this.refundNow(provider.name, received.event.id);
    return received.outcome;
  }

  /**
   * Tries at once the refunds an applied event left waiting (rule PL-15); the worker
   * tries again whatever this does not finish. Never fails the webhook: its event is
   * already stored and applied.
   */
  private async refundNow(gateway: 'log' | 'razorpay', eventId: string): Promise<void> {
    try {
      const [event] = (await this.connection.db
        .select({ organizationId: paymentGatewayEvents.organizationId })
        .from(paymentGatewayEvents)
        .where(
          and(eq(paymentGatewayEvents.gateway, gateway), eq(paymentGatewayEvents.eventId, eventId)),
        )) as [{ organizationId: string }];
      await runDueLinkRefunds(this.connection.db, this.gateways, this.notifier, {
        organizationId: event.organizationId,
      });
    } catch (error) {
      this.logger.error(`Refunds after webhook ${eventId} wait for the worker: ${String(error)}`);
    }
  }

  // The log provider's pretend checkout (development, tests and demos) ---------

  private logProvider(reference: string): LogPaymentLinkProvider {
    const provider = this.gateways.log;
    if (provider === null || !LogPaymentLinkProvider.isReference(reference)) {
      throw new NotFoundException('Not found');
    }
    return provider;
  }

  /** The link behind a log checkout page, looked up by its reference outside tenant scope. */
  private async logLink(reference: string) {
    const [link] = await this.connection.db
      .select({
        reference: paymentLinks.gatewayReference,
        business: organizations.name,
        partyName: parties.displayName,
        number: paymentLinks.number,
        description: paymentLinks.description,
        amountPaise: paymentLinks.amountPaise,
        paidPaise: paymentLinks.paidPaise,
        status: sql<LogCheckoutView['status']>`case
          when ${paymentLinks.status} = 'created' and ${paymentLinks.expiresAt} <= now() then 'expired'
          else ${paymentLinks.status}::text end`,
        expiresAt: paymentLinks.expiresAt,
      })
      .from(paymentLinks)
      .innerJoin(organizations, eq(organizations.id, paymentLinks.organizationId))
      .innerJoin(parties, eq(parties.id, paymentLinks.partyId))
      .where(and(eq(paymentLinks.provider, 'log'), eq(paymentLinks.gatewayReference, reference)));
    if (!link) throw new NotFoundException('Not found');
    return { ...link, expiresAt: link.expiresAt.toISOString() };
  }

  async logCheckout(reference: string): Promise<LogCheckoutView> {
    this.logProvider(reference);
    return this.logLink(reference);
  }

  /**
   * "Pays" a log link: the webhook the gateway would send, signed. The page posts it to
   * the webhook route, as a gateway would; posting it again changes nothing.
   */
  async logPay(reference: string, input: LogPayInput): Promise<LogWebhook> {
    const provider = this.logProvider(reference);
    const link = await this.logLink(reference);
    const left = link.amountPaise - link.paidPaise;
    const webhook = provider.webhook({
      type: 'payment.captured',
      linkId: reference,
      payment: { amountPaise: input.amountPaise ?? (left > 0 ? left : link.amountPaise) },
    });
    return {
      path: `${WEBHOOK_PATH}/log`,
      header: LOG_SIGNATURE_HEADER,
      signature: webhook.signature,
      body: webhook.body.toString('utf8'),
    };
  }
}
