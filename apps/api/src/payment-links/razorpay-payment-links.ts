import { randomBytes } from 'node:crypto';
import {
  GatewayError,
  type CreatedPayment,
  type PaymentRequest,
} from '../payments-gateway/payment-gateway.js';
import { signatureMatches } from '../payments-gateway/signatures.js';
import type {
  GatewayRefund,
  GatewayRefundRequest,
  PaymentLinkEvent,
  PaymentLinkProvider,
} from './payment-link-provider.js';

type Fetch = typeof globalThis.fetch;

/** A business's own Razorpay keys ([PO-40]), opened from the vault for one request. */
export interface RazorpayCredentials {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
}

export interface RazorpayOptions {
  /** https://api.razorpay.com/v1 (a fake server in tests). */
  readonly apiUrl: string;
  readonly fetch?: Fetch;
  /** Waits between retries (tests pass one that does not wait). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

/** Razorpay refuses a link expiring sooner than 15 minutes ahead; a minute's margin. */
export const RAZORPAY_MIN_EXPIRY_MS = 16 * 60_000;
/** Waits before the second and third try of a request that failed on the way. */
const RETRY_DELAYS_MS = [250, 1_000] as const;
const TIMEOUT_MS = 10_000;

interface RazorpayLink {
  readonly id: string;
  readonly short_url: string;
  readonly reference_id?: string;
  /** Unix seconds; 0 or missing for a link that never expires. */
  readonly expire_by?: number;
}

interface RazorpayRefund {
  readonly id: string;
  readonly status: string;
  readonly receipt?: string | null;
}

interface RazorpayWebhook {
  readonly event: string;
  readonly created_at: number;
  readonly payload?: {
    readonly payment_link?: { readonly entity: { readonly id: string } };
    readonly payment?: {
      readonly entity: {
        readonly id: string;
        readonly amount: number;
        readonly created_at: number;
      };
    };
    readonly refund?: {
      readonly entity: {
        readonly id: string;
        readonly payment_id: string;
        readonly amount: number;
      };
    };
  };
}

const LINK_ENDINGS: Readonly<Record<string, 'expired' | 'cancelled'>> = {
  'payment_link.expired': 'expired',
  'payment_link.cancelled': 'cancelled',
};
const REFUND_NEWS: Readonly<Record<string, 'refund_processed' | 'refund_failed'>> = {
  'refund.processed': 'refund_processed',
  'refund.failed': 'refund_failed',
};
const PAID = new Set(['payment_link.paid', 'payment_link.partially_paid']);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Razorpay's 10-14 character contact: digits with an optional +, else none. */
function contactOf(mobile: string | null): string | undefined {
  const digits = mobile?.replace(/[^\d+]/g, '') ?? '';
  return digits.length >= 8 && digits.length <= 14 ? digits : undefined;
}

/**
 * UPI payment links through a business's own Razorpay account ([PO-40]): the Payment
 * Links API (https://razorpay.com/docs/api/payments/payment-links/) to make and cancel
 * links, the Refunds API to pay money back ([PO-44]), and its HMAC-SHA256 webhooks
 * (`X-Razorpay-Signature` over the raw body, the business's webhook secret). Plain
 * fetch with Basic auth, as the subscriptions adapter; nothing here logs or returns a
 * key, and errors carry Razorpay's error code only.
 *
 * Live keys make UPI Payment Links (`upi_link`); Razorpay has no UPI links in test
 * mode, so test keys make a standard link that offers UPI only. Requests that fail on
 * the way (timeouts, 5xx, 429) are tried up to three times, safely: a link carries a
 * random `reference_id` found again if a lost answer had made it, and a refund's
 * receipt makes Razorpay refuse a second refund, which is then looked up.
 */
export class RazorpayPaymentLinkProvider implements PaymentLinkProvider {
  readonly name = 'razorpay' as const;
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly credentials: RazorpayCredentials,
    private readonly options: RazorpayOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? wait;
    this.now = options.now ?? (() => new Date());
  }

  /** Live keys take real money and make UPI links; test keys do neither. */
  get live(): boolean {
    return this.credentials.keyId.startsWith('rzp_live_');
  }

  async createPayment(request: PaymentRequest): Promise<CreatedPayment> {
    // Ours plus a random part: found again after a lost answer, never another link's.
    const referenceId = `${request.reference}-${randomBytes(6).toString('hex')}`;
    const earliest = this.now().getTime() + RAZORPAY_MIN_EXPIRY_MS;
    const expiresAt = Math.max(request.expiresAt?.getTime() ?? earliest, earliest);
    const contact = contactOf(request.customer?.mobile ?? null);
    const body = {
      amount: request.amountPaise,
      currency: 'INR',
      accept_partial: false,
      reference_id: referenceId,
      description: request.description.slice(0, 2048),
      expire_by: Math.ceil(expiresAt / 1000),
      ...(request.customer === null
        ? {}
        : {
            customer: {
              name: request.customer.name.slice(0, 100),
              ...(contact === undefined ? {} : { contact }),
            },
          }),
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { reference: request.reference },
      ...(this.live
        ? { upi_link: true }
        : {
            options: {
              checkout: { method: { upi: '1', card: '0', netbanking: '0', wallet: '0' } },
            },
          }),
    };
    let link: RazorpayLink;
    try {
      link = await this.call<RazorpayLink>('POST', '/payment_links', body);
    } catch (error) {
      // A first try that made the link but lost the answer: the retry finds it taken.
      if (!(error instanceof GatewayError) || error.code !== 'BAD_REQUEST_ERROR') throw error;
      const found = await this.call<{ payment_links?: RazorpayLink[] }>(
        'GET',
        `/payment_links?reference_id=${encodeURIComponent(referenceId)}`,
      );
      const made = found.payment_links?.find((candidate) => candidate.reference_id === referenceId);
      if (made === undefined) throw error;
      link = made;
    }
    // Recorded as Razorpay keeps it, so our expiry and the gateway's agree ([PO-60]).
    const expireBy =
      link.expire_by !== undefined && link.expire_by > 0 ? link.expire_by : body.expire_by;
    return {
      gatewayReference: link.id,
      url: link.short_url,
      expiresAt: new Date(expireBy * 1000),
    };
  }

  async cancelPayment(gatewayReference: string): Promise<void> {
    await this.call('POST', `/payment_links/${encodeURIComponent(gatewayReference)}/cancel`);
  }

  async refundPayment(request: GatewayRefundRequest): Promise<GatewayRefund> {
    const path = `/payments/${encodeURIComponent(request.gatewayPaymentId)}`;
    try {
      const refund = await this.call<RazorpayRefund>('POST', `${path}/refund`, {
        amount: request.amountPaise,
        speed: 'normal',
        receipt: request.receipt,
        notes: request.notes,
      });
      return { gatewayRefundId: refund.id, status: refund.status };
    } catch (error) {
      // Asked before with this receipt (an answer lost, or our books not written): look it up.
      if (!(error instanceof GatewayError) || error.code !== 'BAD_REQUEST_ERROR') throw error;
      const found = await this.call<{ items?: RazorpayRefund[] }>(
        'GET',
        `${path}/refunds?count=100`,
      );
      const taken = found.items?.find((refund) => refund.receipt === request.receipt);
      if (taken === undefined) throw error;
      return { gatewayRefundId: taken.id, status: taken.status };
    }
  }

  /** A harmless read that proves the keys work (the settings screen's test button). */
  async testConnection(): Promise<void> {
    await this.call('GET', '/payments?count=1');
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, unknown>>,
  ): PaymentLinkEvent | null {
    if (
      !signatureMatches(this.credentials.webhookSecret, rawBody, headers['x-razorpay-signature'])
    ) {
      return null;
    }
    let webhook: RazorpayWebhook;
    try {
      webhook = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhook;
    } catch {
      return null;
    }
    const link = webhook.payload?.payment_link?.entity ?? null;
    const payment = webhook.payload?.payment?.entity ?? null;
    const refund = webhook.payload?.refund?.entity ?? null;
    const eventId = headers['x-razorpay-event-id'];
    const base = {
      // Razorpay names each event in a header; older deliveries are told apart by content.
      id:
        typeof eventId === 'string' && eventId !== ''
          ? eventId
          : [webhook.event, link?.id ?? refund?.id, payment?.id ?? webhook.created_at].join(':'),
      gatewayType: webhook.event,
    };
    const refundKind = REFUND_NEWS[webhook.event];
    if (refundKind !== undefined && refund !== null) {
      return {
        ...base,
        kind: refundKind,
        gatewayLinkId: null,
        payment: null,
        refund: { id: refund.id, paymentId: refund.payment_id, amountPaise: refund.amount },
      };
    }
    if (link === null) {
      return { ...base, kind: 'ignored', gatewayLinkId: null, payment: null, refund: null };
    }
    if (PAID.has(webhook.event) && payment !== null) {
      return {
        ...base,
        kind: 'paid',
        gatewayLinkId: link.id,
        payment: {
          id: payment.id,
          amountPaise: payment.amount,
          paidAt: new Date(payment.created_at * 1000),
        },
        refund: null,
      };
    }
    const ending = LINK_ENDINGS[webhook.event];
    return ending === undefined
      ? { ...base, kind: 'ignored', gatewayLinkId: link.id, payment: null, refund: null }
      : { ...base, kind: ending, gatewayLinkId: link.id, payment: null, refund: null };
  }

  /** One request, tried again (at most three times) when it failed on the way. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once<T>(method, path, body);
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !(error as GatewayError).retryable) throw error;
        await this.sleep(delay);
      }
    }
  }

  private async once<T>(method: string, path: string, body?: unknown): Promise<T> {
    const credentials = Buffer.from(
      `${this.credentials.keyId}:${this.credentials.keySecret}`,
    ).toString('base64');
    const route = `${method} ${String(path.split('?')[0])}`;
    let response: Response;
    try {
      response = await this.fetch(`${this.options.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${credentials}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GatewayError(`Razorpay could not be reached (${route})`, {
        code: 'unreachable',
        retryable: true,
      });
    }
    if (response.ok) return (await response.json()) as T;
    const answer = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    const code =
      response.status === 401
        ? 'unauthorized'
        : (answer?.error?.code ?? `http_${String(response.status)}`);
    throw new GatewayError(`Razorpay answered ${String(response.status)} (${code}) to ${route}`, {
      code,
      retryable: response.status >= 500 || response.status === 429,
    });
  }
}
