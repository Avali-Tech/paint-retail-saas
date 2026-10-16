import { randomBytes } from 'node:crypto';
import type { LinkEventKind } from '@paint/shared';
import {
  GatewayError,
  type CreatedPayment,
  type PaymentCreator,
  type PaymentRequest,
  type VerifiedGatewayEvent,
  type WebhookVerifier,
} from '../payments-gateway/payment-gateway.js';
import { hmacHex, signatureMatches } from '../payments-gateway/signatures.js';

/** One payment a gateway reported: its own id, the amount and when it was paid. */
export interface GatewayLinkPayment {
  readonly id: string;
  readonly amountPaise: number;
  readonly paidAt: Date;
}

/** A refund a gateway reported on: its id, the payment it pays back, and how much. */
export interface GatewayRefundNews {
  readonly id: string;
  readonly paymentId: string;
  readonly amountPaise: number;
}

/**
 * A webhook event about a payment link or a refund, translated from the gateway's format
 * (P2-M32, spec §6.2): a payment, the link's expiry or cancellation, a refund processed
 * or failed, or news this product does not act on (`ignored`).
 */
export type PaymentLinkEvent = VerifiedGatewayEvent &
  (
    | {
        readonly kind: 'paid';
        /** The gateway's id of the link (`payment_links.gateway_reference`). */
        readonly gatewayLinkId: string;
        readonly payment: GatewayLinkPayment;
        readonly refund: null;
      }
    | {
        readonly kind: Exclude<LinkEventKind, 'paid'>;
        readonly gatewayLinkId: string;
        readonly payment: null;
        readonly refund: null;
      }
    | {
        readonly kind: 'refund_processed' | 'refund_failed';
        readonly gatewayLinkId: null;
        readonly payment: null;
        readonly refund: GatewayRefundNews;
      }
    | {
        readonly kind: 'ignored';
        readonly gatewayLinkId: string | null;
        readonly payment: null;
        readonly refund: null;
      }
  );

/** A refund to ask a gateway for ([PO-44]). */
export interface GatewayRefundRequest {
  /** The gateway's id of the payment paid back. */
  readonly gatewayPaymentId: string;
  readonly amountPaise: number;
  /** Ours (the refund row's id): asking twice with it never refunds twice. */
  readonly receipt: string;
  readonly notes: Readonly<Record<string, string>>;
}

/** A refund the gateway took. */
export interface GatewayRefund {
  readonly gatewayRefundId: string;
  /** The gateway's word for where it is: pending, processed (or failed). */
  readonly status: string;
}

/**
 * A payment-link gateway: makes a link for an amount, cancels it, refunds a payment, and
 * reports what happened by signed webhooks. Adapters: `log` (development and demos) and
 * Razorpay (`razorpay-payment-links.ts`), chosen by PAYMENT_LINK_PROVIDER; a Cashfree
 * adapter would implement the same interface.
 */
export interface PaymentLinkProvider extends PaymentCreator, WebhookVerifier<PaymentLinkEvent> {
  readonly name: 'log' | 'razorpay';
  /** Stops a link at the gateway, so it can no longer be paid. */
  cancelPayment(gatewayReference: string): Promise<void>;
  /** Pays money back to the customer; idempotent by the request's receipt. */
  refundPayment(request: GatewayRefundRequest): Promise<GatewayRefund>;
}

/** Where the log gateway's refunds go: taken, refused, or nowhere (tests set it). */
export type LogRefundBehaviour = 'process' | 'reject' | 'unreachable';

export const LOG_SIGNATURE_HEADER = 'x-log-gateway-signature';
const LOG_REFERENCE = /^plink_log_[A-Za-z0-9_-]{22}$/;

/** The body the log provider signs: our own shape, signed as Razorpay signs its own. */
interface LogEventBody {
  readonly id: string;
  readonly type:
    | 'payment.captured'
    | 'link.expired'
    | 'link.cancelled'
    | 'refund.processed'
    | 'refund.failed'
    | (string & {});
  readonly linkId: string | null;
  readonly payment: {
    readonly id: string;
    readonly amountPaise: number;
    readonly paidAt: string;
  } | null;
  readonly refund?: GatewayRefundNews | null;
}

const ENDINGS: Readonly<Record<string, Exclude<LinkEventKind, 'paid'>>> = {
  'link.expired': 'expired',
  'link.cancelled': 'cancelled',
};
const REFUND_NEWS: Readonly<Record<string, 'refund_processed' | 'refund_failed'>> = {
  'refund.processed': 'refund_processed',
  'refund.failed': 'refund_failed',
};

const random = (bytes: number) => randomBytes(bytes).toString('base64url');

const isAmount = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

/** Whether a body the log provider signed has the shape it signs. */
function isLogEvent(value: unknown): value is LogEventBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  const payment = body.payment as Record<string, unknown> | null | undefined;
  const refund = body.refund as Record<string, unknown> | null | undefined;
  return (
    typeof body.id === 'string' &&
    typeof body.type === 'string' &&
    (typeof body.linkId === 'string' || body.linkId === null) &&
    (payment === null ||
      (typeof payment === 'object' &&
        typeof payment.id === 'string' &&
        isAmount(payment.amountPaise) &&
        typeof payment.paidAt === 'string' &&
        !Number.isNaN(Date.parse(payment.paidAt)))) &&
    (refund === undefined ||
      refund === null ||
      (typeof refund === 'object' &&
        typeof refund.id === 'string' &&
        typeof refund.paymentId === 'string' &&
        isAmount(refund.amountPaise)))
  );
}

/**
 * Development, tests and demos only: links that take no money. Each link is a page of
 * the web app (`/pay/<reference>`) where "paying" makes this provider sign a webhook,
 * which goes through every check a real gateway's does. It signs with a secret made
 * fresh for each process, so nothing outside can forge one. Refunds are taken at once
 * (once per receipt), unless a test says otherwise.
 */
export class LogPaymentLinkProvider implements PaymentLinkProvider {
  readonly name = 'log' as const;
  private readonly secret = randomBytes(32).toString('hex');
  /** Links made and cancelled, and refunds taken by receipt, for tests to look at. */
  readonly created: PaymentRequest[] = [];
  readonly cancelled: string[] = [];
  readonly refunds = new Map<string, GatewayRefundRequest & GatewayRefund>();
  refundBehaviour: LogRefundBehaviour = 'process';

  constructor(private readonly appUrl: string) {}

  /** Whether `reference` could be one of this provider's links. */
  static isReference(reference: string): boolean {
    return LOG_REFERENCE.test(reference);
  }

  createPayment(request: PaymentRequest): Promise<CreatedPayment> {
    this.created.push(request);
    const gatewayReference = `plink_log_${random(16)}`;
    return Promise.resolve({ gatewayReference, url: `${this.appUrl}/pay/${gatewayReference}` });
  }

  cancelPayment(gatewayReference: string): Promise<void> {
    this.cancelled.push(gatewayReference);
    return Promise.resolve();
  }

  refundPayment(request: GatewayRefundRequest): Promise<GatewayRefund> {
    if (this.refundBehaviour === 'unreachable') {
      return Promise.reject(
        new GatewayError('The log gateway could not be reached', {
          code: 'unreachable',
          retryable: true,
        }),
      );
    }
    if (this.refundBehaviour === 'reject') {
      return Promise.reject(
        new GatewayError('The log gateway refused the refund', { code: 'BAD_REQUEST_ERROR' }),
      );
    }
    const taken = this.refunds.get(request.receipt) ?? {
      ...request,
      gatewayRefundId: `rfnd_log_${random(16)}`,
      status: 'processed',
    };
    this.refunds.set(request.receipt, taken);
    return Promise.resolve({ gatewayRefundId: taken.gatewayRefundId, status: taken.status });
  }

  /** A webhook as the log gateway sends it: the raw body and its signature. */
  webhook(event: {
    readonly type: LogEventBody['type'];
    readonly linkId?: string;
    readonly payment?: {
      readonly amountPaise: number;
      readonly paidAt?: Date;
      readonly id?: string;
    };
    readonly refund?: GatewayRefundNews;
    readonly id?: string;
  }): { readonly body: Buffer; readonly signature: string } {
    const body: LogEventBody = {
      id: event.id ?? `evt_log_${random(16)}`,
      type: event.type,
      linkId: event.linkId ?? null,
      payment:
        event.payment === undefined
          ? null
          : {
              id: event.payment.id ?? `pay_log_${random(16)}`,
              amountPaise: event.payment.amountPaise,
              paidAt: (event.payment.paidAt ?? new Date()).toISOString(),
            },
      refund: event.refund ?? null,
    };
    const raw = Buffer.from(JSON.stringify(body));
    return { body: raw, signature: hmacHex(this.secret, raw) };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, unknown>>,
  ): PaymentLinkEvent | null {
    if (!signatureMatches(this.secret, rawBody, headers[LOG_SIGNATURE_HEADER])) return null;
    const body: unknown = JSON.parse(rawBody.toString('utf8'));
    // Only this process signs with this secret, so a signed body has this shape.
    if (!isLogEvent(body)) return null;
    const base = { id: body.id, gatewayType: body.type };
    const refundKind = REFUND_NEWS[body.type];
    if (refundKind !== undefined && body.refund) {
      return { ...base, kind: refundKind, gatewayLinkId: null, payment: null, refund: body.refund };
    }
    if (body.linkId === null) {
      return { ...base, kind: 'ignored', gatewayLinkId: null, payment: null, refund: null };
    }
    if (body.type === 'payment.captured' && body.payment !== null) {
      return {
        ...base,
        gatewayLinkId: body.linkId,
        kind: 'paid',
        payment: {
          id: body.payment.id,
          amountPaise: body.payment.amountPaise,
          paidAt: new Date(body.payment.paidAt),
        },
        refund: null,
      };
    }
    // A payment event with no payment in it, or news we do not act on, is ignored.
    return {
      ...base,
      gatewayLinkId: body.linkId,
      kind: ENDINGS[body.type] ?? 'ignored',
      payment: null,
      refund: null,
    };
  }
}
