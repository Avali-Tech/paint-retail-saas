import type { Transaction } from '@paint/db';
import { loyaltyPointsToReverse } from '@paint/shared';

/** What a credit note tells the loyalty programme. */
export interface LoyaltyReversal {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly invoiceTaxablePaise: number;
  readonly noteId: string;
  readonly noteNumber: string;
  readonly creditedTaxablePaise: number;
}

/**
 * The loyalty reversal hook of a credit note (spec §4.5), called in the note's
 * transaction. Returns the points taken back.
 *
 * Invoices earn no points yet: until round 4a, loyalty points come only from
 * purchases entered by hand (`loyalty_ledger.manual_purchase_paise`), which name
 * no invoice, so there is nothing to reverse and this returns 0. Round 4a adds
 * `loyalty_ledger.tax_document_id` and posts `pointsForPurchase` when an invoice
 * is issued (§3.5, §4.7). This hook then reads the points those entries earned
 * for `invoiceId` (locking the account), and posts one `adjust` entry of
 * −loyaltyPointsToReverse(earned, invoice taxable, credited taxable) referencing
 * the note number, never taking the balance below zero.
 */
export function reverseLoyaltyForNote(_tx: Transaction, note: LoyaltyReversal): Promise<number> {
  const earnedPoints = 0;
  return Promise.resolve(
    loyaltyPointsToReverse(earnedPoints, note.invoiceTaxablePaise, note.creditedTaxablePaise),
  );
}
