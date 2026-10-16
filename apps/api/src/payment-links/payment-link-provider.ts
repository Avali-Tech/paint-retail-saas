import { randomBytes } from 'node:crypto';
import type { LinkEventKind } from '@paint/shared';
import type { PaymentLinkProviderName } from '../config.js';
import type {
  CreatedPayment,
  PaymentCreator,
  PaymentRequest,
  VerifiedGatewayEvent,
  WebhookVerifier,
} from '../payments-gateway/payment-gateway.js';
import { hmacHex, signatureMatches } from '../payments-gateway/signatures.js';

/** One payment a gateway reported: its own id, the amount and when it was paid. */
export interface GatewayLinkPayment {
  readonly id: string;
  readonly amountPaise: number;
  readonly paidAt: Date;
}

/**
 * A webhook event about a payment link, translated from the gateway's format (P2-M32,
 * spec §6.2): a payment, the link's expiry or cancellation, or news this product does
 * not act on (`ignored`).
 */
export type PaymentLinkEvent = VerifiedGatewayEvent & {
  /** The gateway's id of the link (`payment_links.gateway_reference`). */
  readonly gatewayLinkId: string;
} & (
    | { readonly kind: 'paid'; readonly payment: GatewayLinkPayment }
    | { readonly kind: Exclude<LinkEventKind, 'paid'> | 'ignored'; readonly payment: null }
  );

/**
 * A payment-link gateway: makes a link for an amount, cancels it, and reports what
 * happened to it by signed webhooks. `log` is the one adapter until [PO-2] names a
 * gateway; a Razorpay or Cashfree adapter implements the same interface (its payment
 * links API and webhook signature), chosen by PAYMENT_LINK_PROVIDER.
 */
export interface PaymentLinkProvider extends PaymentCreator, WebhookVerifier<PaymentLinkEvent> {
  /** Stops a link at the gateway, so it can no longer be paid. */
  cancelPayment(gatewayReference: string): Promise<void>;
}

export const LOG_SIGNATURE_HEADER = 'x-log-gateway-signature';
const LOG_REFERENCE = /^plink_log_[A-Za-z0-9_-]{22}$/;

/** The body the log provider signs: our own shape, signed as Razorpay signs its own. */
interface LogEventBody {
  readonly id: string;
  readonly type: 'payment.captured' | 'link.expired' | 'link.cancelled' | (string & {});
  readonly linkId: string;
  readonly payment: {
    readonly id: string;
    readonly amountPaise: number;
    readonly paidAt: string;
  } | null;
}

const ENDINGS: Readonly<Record<string, Exclude<LinkEventKind, 'paid'>>> = {
  'link.expired': 'expired',
  'link.cancelled': 'cancelled',
};

const random = (bytes: number) => randomBytes(bytes).toString('base64url');

/** Whether a body the log provider signed has the shape it signs. */
function isLogEvent(value: unknown): value is LogEventBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  const payment = body.payment as Record<string, unknown> | null | undefined;
  return (
    typeof body.id === 'string' &&
    typeof body.type === 'string' &&
    typeof body.linkId === 'string' &&
    (payment === null ||
      (typeof payment === 'object' &&
        typeof payment.id === 'string' &&
        Number.isSafeInteger(payment.amountPaise) &&
        Number(payment.amountPaise) > 0 &&
        typeof payment.paidAt === 'string' &&
        !Number.isNaN(Date.parse(payment.paidAt))))
  );
}

/**
 * Development, tests and demos only: links that take no money. Each link is a page of
 * the web app (`/pay/<reference>`) where "paying" makes this provider sign a webhook,
 * which goes through every check a real gateway's does. It signs with a secret made
 * fresh for each process, so nothing outside can forge one.
 */
export class LogPaymentLinkProvider implements PaymentLinkProvider {
  readonly name = 'log' as const;
  private readonly secret = randomBytes(32).toString('hex');
  /** Links made and cancelled, for tests to look at. */
  readonly created: PaymentRequest[] = [];
  readonly cancelled: string[] = [];

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

  /** A webhook as the log gateway sends it: the raw body and its signature. */
  webhook(event: {
    readonly type: LogEventBody['type'];
    readonly linkId: string;
    readonly payment?: {
      readonly amountPaise: number;
      readonly paidAt?: Date;
      readonly id?: string;
    };
    readonly id?: string;
  }): { readonly body: Buffer; readonly signature: string } {
    const body: LogEventBody = {
      id: event.id ?? `evt_log_${random(16)}`,
      type: event.type,
      linkId: event.linkId,
      payment:
        event.payment === undefined
          ? null
          : {
              id: event.payment.id ?? `pay_log_${random(16)}`,
              amountPaise: event.payment.amountPaise,
              paidAt: (event.payment.paidAt ?? new Date()).toISOString(),
            },
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
    const base = { id: body.id, gatewayType: body.type, gatewayLinkId: body.linkId };
    if (body.type === 'payment.captured' && body.payment !== null) {
      return {
        ...base,
        kind: 'paid',
        payment: {
          id: body.payment.id,
          amountPaise: body.payment.amountPaise,
          paidAt: new Date(body.payment.paidAt),
        },
      };
    }
    // A payment event with no payment in it, or news we do not act on, is ignored.
    return { ...base, kind: ENDINGS[body.type] ?? 'ignored', payment: null };
  }
}

/** The configured provider; null when payment links are off. */
export function paymentLinkProviderFor(
  name: PaymentLinkProviderName,
  appUrl: string,
): PaymentLinkProvider | null {
  return name === 'log' ? new LogPaymentLinkProvider(appUrl) : null;
}
