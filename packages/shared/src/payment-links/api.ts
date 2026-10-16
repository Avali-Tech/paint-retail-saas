import type { QueueResult } from '../messaging/api.js';
import type { Permission } from '../permissions.js';
import type {
  PaymentLinkOrigin,
  PaymentLinkPurpose,
  PaymentLinkStatus,
  StaffLinkPurpose,
} from './rules.js';

/** Asking a customer for money by link, and cancelling a link: as recording a payment. */
export const PAYMENT_LINK_MANAGE_PERMISSION = 'payments:manage' as const satisfies Permission;
/** Seeing links: as seeing the invoices and statements they come from. */
export const PAYMENT_LINK_READ_PERMISSION = 'sales:read' as const satisfies Permission;

/** GET /payment-links/settings: whether links can be made, and how long they live. */
export interface PaymentLinkSettings {
  /** The provider ("log", or a gateway later), or null when links are off. */
  readonly provider: string | null;
  readonly expiryDays: number;
}

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
