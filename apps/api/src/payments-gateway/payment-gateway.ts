import type { PaymentGatewayName } from '@paint/shared';

/**
 * The provider-neutral payment-gateway port (architecture: every external
 * integration sits behind an adapter). SaaS subscriptions (P2-M08) use it now;
 * P2-M32's UPI payment links implement `PaymentCreator` next. Nothing here knows
 * a gateway's own formats: adapters translate to and from these shapes.
 */

/** A webhook event whose signature checked out, translated from the gateway's format. */
export interface VerifiedGatewayEvent {
  /** Unique per gateway: the same event delivered twice is applied once. */
  readonly id: string;
  /** The gateway's own name for the event, kept with it. */
  readonly gatewayType: string;
}

/** Anything that receives a gateway's webhooks: it believes nothing until the signature matches. */
export interface WebhookVerifier<E extends VerifiedGatewayEvent> {
  readonly name: PaymentGatewayName;
  /** The event in a webhook, or null when its signature does not match the raw body. */
  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, unknown>>): E | null;
}

/** A one-off payment to ask a customer for (P2-M32 builds the first adapter). */
export interface PaymentRequest {
  /** Ours, kept in the gateway's notes so its webhooks lead back to it. */
  readonly reference: string;
  readonly amountPaise: number;
  readonly description: string;
  readonly expiresAt: Date | null;
  readonly customer: { readonly name: string; readonly mobile: string | null } | null;
}

export interface CreatedPayment {
  /** The gateway's id for it; its webhooks name it. */
  readonly gatewayReference: string;
  /** Where the customer pays. */
  readonly url: string;
}

/** A gateway that can ask for a one-off payment. */
export interface PaymentCreator {
  createPayment(request: PaymentRequest): Promise<CreatedPayment>;
}

/**
 * Thrown when the gateway refuses or cannot be reached; never carries keys. `code` is
 * the gateway's error code (or `unreachable`, `unauthorized`), safe to store and show;
 * `retryable` says whether trying the same request again later may work.
 */
export class GatewayError extends Error {
  override readonly name = 'GatewayError';
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly code?: string; readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.code = options.code ?? 'gateway_error';
    this.retryable = options.retryable ?? false;
  }
}
