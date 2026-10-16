import type { QueueResult } from '../messaging/api.js';
import type { MessageLanguage } from '../messaging/templates.js';

// Stored statement links (MVP 3 round 2a, spec §6.4): a token in a URL anyone may
// open until it expires or is revoked, so a WhatsApp provider can fetch the PDF.

/** How long a shared statement link lives ([PO-4]). */
export const STATEMENT_LINK_DAYS = 7;

/** A token is 32 random bytes, base64url: 43 characters. */
export const STATEMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type StatementLinkStatus = 'active' | 'expired' | 'revoked';

export interface StatementLinkView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly language: MessageLanguage;
  readonly status: StatementLinkStatus;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly openedCount: number;
  readonly lastOpenedAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** POST /parties/:id/statement/links. */
export interface ShareStatementBody {
  readonly from: string;
  readonly to: string;
  readonly lang: MessageLanguage;
  /** Also queue the `statement_ready` WhatsApp message (needs a provider and consent). */
  readonly send?: 'whatsapp';
}

export interface StatementShareResult {
  readonly link: StatementLinkView;
  /** The link itself: shown once, never stored (only its hash is). */
  readonly url: string;
  /** wa.me with the message and the link, when the party has a mobile. */
  readonly waMeUrl: string | null;
  /** Whether the WhatsApp message was queued, when asked to send. */
  readonly message: QueueResult | null;
  /**
   * A UPI payment link for what the party owes (round 4a), carried by the message and
   * the wa.me text; null without a payment-link provider or with nothing owed.
   */
  readonly paymentLink: {
    readonly number: string;
    readonly url: string;
    /** What it asks for: the balance, or with the full basis the bills' outstanding ([PO-43]). */
    readonly amountPaise: number;
  } | null;
}
