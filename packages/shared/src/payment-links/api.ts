import type { QueueResult } from '../messaging/api.js';
import type { Permission } from '../permissions.js';
import type {
  LinkAmountBasis,
  LinkRefundReason,
  LinkRefundStatus,
  PaymentLinkOrigin,
  PaymentLinkPurpose,
  PaymentLinkStatus,
  StaffLinkPurpose,
} from './rules.js';

/** Asking a customer for money by link, and cancelling a link: as recording a payment. */
export const PAYMENT_LINK_MANAGE_PERMISSION = 'payments:manage' as const satisfies Permission;
/** Seeing links: as seeing the invoices and statements they come from. */
export const PAYMENT_LINK_READ_PERMISSION = 'sales:read' as const satisfies Permission;

/** Connecting the gateway account and the link settings: owners and admins only ([PO-40]). */
export const PAYMENT_LINK_SETTINGS_PERMISSION = 'organization:manage' as const satisfies Permission;

/** The gateways a business can connect its own account of. */
export type PaymentLinkProviderName = 'log' | 'razorpay';

/** GET /payment-links/settings: whether this business can make links, and its link rules. */
export interface PaymentLinkSettings {
  /** The platform's provider, or null when links are off for everyone. */
  readonly provider: PaymentLinkProviderName | null;
  /** Links can be made now: a provider, and with Razorpay the business's account connected. */
  readonly ready: boolean;
  /** Minutes a counter or manual link stays payable ([PO-41]). */
  readonly validityMinutes: number;
  /** Minutes a link sent in a message stays payable ([PO-61]). */
  readonly messageValidityMinutes: number;
  /** The shortest validity this business may set: 15 minutes with Razorpay ([PO-60]). */
  readonly minValidityMinutes: number;
  /** The most one link asks for ([PO-42]). */
  readonly capPaise: number;
  /** Net of the advance, or the bills' full outstanding ([PO-43]). */
  readonly amountBasis: LinkAmountBasis;
}

/** PUT /payment-links/settings. */
export interface UpdatePaymentLinkSettingsRequest {
  readonly validityMinutes: number;
  readonly messageValidityMinutes: number;
  readonly capPaise: number;
  readonly amountBasis: LinkAmountBasis;
}

/**
 * GET /payment-links/gateway-account: the business's own gateway account, never with a
 * secret: only the last four characters of each key, and whether it is connected.
 */
export interface GatewayAccountView {
  readonly gateway: 'razorpay';
  readonly connected: boolean;
  /** Live keys take real money; test keys do not (and cannot make UPI links). */
  readonly live: boolean | null;
  readonly keyIdHint: string | null;
  readonly keySecretHint: string | null;
  readonly webhookSecretHint: string | null;
  readonly connectedAt: string | null;
  readonly connectedBy: string | null;
  /** The last time the keys answered a test call. */
  readonly verifiedAt: string | null;
  /** What to paste in the gateway's webhook settings. */
  readonly webhookUrl: string;
  /**
   * Connecting raised the business's link validity to Razorpay's shortest (15 minutes,
   * [PO-60]): the minutes each had before, null for one that was long enough. Only in
   * the answer to connecting; null otherwise.
   */
  readonly validityRaised: {
    readonly counterFrom: number | null;
    readonly messageFrom: number | null;
    readonly to: number;
  } | null;
}

/** PUT /payment-links/gateway-account: the keys from the gateway's dashboard. */
export interface ConnectGatewayRequest {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
}

/** POST /payment-links/gateway-account/test. */
export interface GatewayTestResult {
  readonly ok: true;
  readonly verifiedAt: string;
}

/** Razorpay key ids: rzp_test_… or rzp_live_…. */
export const RAZORPAY_KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;

/** POST /payment-links. */
export interface CreatePaymentLinkRequest {
  readonly partyId: string;
  readonly purpose: StaffLinkPurpose;
  /** `invoice`: the invoice, bill of supply or debit note. */
  readonly invoiceId?: string;
  /** A custom amount: at most what is owed, unless the purpose is `advance`. */
  readonly amountPaise?: number;
  /** Where the payment is recorded, for a party-level link (default: the party's home store). */
  readonly storeId?: string;
  /** Also queue the WhatsApp message carrying the link (needs the party's consent). */
  readonly send?: 'whatsapp';
}

/** A document a link pays, with what was owed on it when the link was made. */
export interface PaymentLinkDocumentView {
  readonly documentId: string | null;
  readonly partyLedgerId: string | null;
  /** The invoice number, or null for an opening balance or charge. */
  readonly number: string | null;
  readonly outstandingPaise: number;
}

/** A payment the gateway reported for a link. */
export interface PaymentLinkPaymentView {
  readonly id: string;
  readonly number: string;
  readonly amountPaise: number;
  readonly receivedOn: string;
  /** What it left unallocated (an advance). */
  readonly advancePaise: number;
}

/** A refund through the gateway of money a link took that nothing was owed for ([PO-44]). */
export interface PaymentLinkRefundView {
  readonly id: string;
  readonly amountPaise: number;
  readonly reason: LinkRefundReason;
  readonly status: LinkRefundStatus;
  /** The refund payment (RF-…) once booked. */
  readonly refundPaymentId: string | null;
  readonly refundPaymentNumber: string | null;
  readonly gatewayRefundId: string | null;
  readonly gatewayStatus: string | null;
  readonly attempts: number;
  /** Why the last try failed (the gateway's error code). */
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly refundedAt: string | null;
}

export interface PaymentLinkSummary {
  readonly id: string;
  readonly number: string;
  readonly storeId: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly purpose: PaymentLinkPurpose;
  readonly origin: PaymentLinkOrigin;
  readonly amountPaise: number;
  readonly paidPaise: number;
  /** As shown: an open link past its expiry reads `expired`. */
  readonly status: PaymentLinkStatus;
  readonly url: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  /** Refunded through the gateway, and still to refund (pending or failed for now). */
  readonly refundedPaise: number;
  readonly refundPendingPaise: number;
  /** A refund failed: the money is kept as an advance until it is refunded or used. */
  readonly refundFailed: boolean;
}

export interface PaymentLinkView extends PaymentLinkSummary {
  readonly description: string;
  readonly provider: string;
  readonly paidAt: string | null;
  readonly cancelledAt: string | null;
  /** Null when the reminder run made it. */
  readonly createdBy: string | null;
  readonly documents: readonly PaymentLinkDocumentView[];
  readonly payments: readonly PaymentLinkPaymentView[];
  readonly refunds: readonly PaymentLinkRefundView[];
}

/** GET /payment-links. */
export interface PaymentLinkPage {
  readonly items: readonly PaymentLinkSummary[];
  readonly total: number;
}

/** POST /payment-links: the link, a wa.me message carrying it, and the queued message. */
export interface PaymentLinkCreated {
  readonly link: PaymentLinkView;
  /** https://wa.me/… with the message, or null when the party has no mobile. */
  readonly waMeUrl: string | null;
  /** With `send: 'whatsapp'`: queued, or why not. */
  readonly message: QueueResult | null;
}

/** The `log` provider's pretend checkout page (development and demos only). */
export interface LogCheckoutView {
  readonly reference: string;
  readonly business: string;
  readonly partyName: string;
  readonly number: string;
  readonly description: string;
  readonly amountPaise: number;
  readonly paidPaise: number;
  readonly status: PaymentLinkStatus;
  readonly expiresAt: string;
}

/** POST /public/payment-links/log/:reference/pay: the signed webhook the "gateway" sends. */
export interface LogPaymentRequest {
  /** What the customer pays; the link's amount less what was paid when left out. */
  readonly amountPaise?: number;
}

export interface LogWebhook {
  /** POST it here with the header to record the payment; posting it again changes nothing. */
  readonly path: string;
  readonly header: string;
  readonly signature: string;
  /** The raw JSON body that was signed. */
  readonly body: string;
}
