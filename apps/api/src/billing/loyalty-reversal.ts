import { schema, type Transaction } from '@paint/db';
import { loyaltyPointsToReverse, pointsForPurchase } from '@paint/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { addDays } from '../contracts/contract-dates.js';
import { billingLiveOn } from '../credit/credit-lookups.js';
import { loyaltySettingsOf } from '../loyalty/loyalty-lookups.js';

const { loyaltyAccounts, loyaltyLedger, taxDocumentLinks } = schema;

/**
 * Loyalty points from invoices (spec §4.7, round 4a). Once billing is live,
 * an issued invoice earns its bill-to party `pointsForPurchase(taxable value)`
 * (one `purchase` entry naming the invoice, [PO-6]: taxable value); a credit
 * note takes back its share and a cancelled invoice all of it, as `adjust`
 * entries, never taking the balance below zero. Before go-live points still
 * come from purchases entered by hand, which name no invoice.
 */

/** An issued invoice, as far as loyalty is concerned. */
export interface InvoiceLoyalty {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly partyId: string;
  readonly taxablePaise: number;
  /** India date of issue. */
  readonly issuedOn: string;
  readonly memberId: string;
}

/** Points an invoice earns its party, posted in the issuing transaction. Returns them. */
export async function earnLoyaltyForInvoice(
  tx: Transaction,
  invoice: InvoiceLoyalty,
): Promise<number> {
  const liveOn = await billingLiveOn(tx);
  if (liveOn === null || invoice.issuedOn < liveOn) return 0;
  const [account] = await tx
    .select({ id: loyaltyAccounts.id })
    .from(loyaltyAccounts)
    .where(and(eq(loyaltyAccounts.partyId, invoice.partyId), eq(loyaltyAccounts.status, 'active')))
    .for('update');
  if (!account) return 0;
  const programme = await loyaltySettingsOf(tx, invoice.organizationId);
  const points = pointsForPurchase(invoice.taxablePaise, programme);
  if (points === 0) return 0;
  await tx.insert(loyaltyLedger).values({
    organizationId: invoice.organizationId,
    accountId: account.id,
    kind: 'purchase',
    points,
    reference: invoice.invoiceNumber,
    taxDocumentId: invoice.invoiceId,
    expiresOn:
      programme.expiryDays === null ? null : addDays(invoice.issuedOn, programme.expiryDays),
    createdByMemberId: invoice.memberId,
  });
  return points;
}

/** The points an invoice earned, with its account locked and that account's balance. */
async function earnedFor(tx: Transaction, invoiceId: string) {
  const [earned] = await tx
    .select({ accountId: loyaltyLedger.accountId, points: loyaltyLedger.points })
    .from(loyaltyLedger)
    .where(and(eq(loyaltyLedger.taxDocumentId, invoiceId), eq(loyaltyLedger.kind, 'purchase')));
  if (!earned) return null;
  await tx
    .select({ id: loyaltyAccounts.id })
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.id, earned.accountId))
    .for('update');
  const [balance] = (await tx
    .select({ points: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)`.mapWith(Number) })
    .from(loyaltyLedger)
    .where(eq(loyaltyLedger.accountId, earned.accountId))) as [{ points: number }];
  return { ...earned, balance: balance.points };
}

interface TakeBack {
  readonly organizationId: string;
  readonly accountId: string;
  readonly points: number;
  readonly documentId: string;
  readonly reference: string;
  readonly note: string;
  readonly memberId: string;
}

async function takeBack(tx: Transaction, entry: TakeBack): Promise<number> {
  if (entry.points <= 0) return 0;
  await tx.insert(loyaltyLedger).values({
    organizationId: entry.organizationId,
    accountId: entry.accountId,
    kind: 'adjust',
    points: -entry.points,
    reference: entry.reference,
    note: entry.note,
    taxDocumentId: entry.documentId,
    createdByMemberId: entry.memberId,
  });
  return entry.points;
}

/** What a credit note tells the loyalty programme. */
export interface LoyaltyReversal {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly invoiceTaxablePaise: number;
  readonly noteId: string;
  readonly noteNumber: string;
  readonly creditedTaxablePaise: number;
  readonly memberId: string;
}

/**
 * The loyalty reversal hook of a credit note (spec §4.5), called in the note's
 * transaction: takes back the share of the invoice's points the note credits
 * (loyaltyPointsToReverse), never more than the invoice earned across its
 * notes, nor more than the party has left. Returns the points taken back.
 */
export async function reverseLoyaltyForNote(
  tx: Transaction,
  note: LoyaltyReversal,
): Promise<number> {
  const earned = await earnedFor(tx, note.invoiceId);
  if (earned === null) return 0;
  const [before] = (await tx
    .select({ points: sql<number>`coalesce(-sum(${loyaltyLedger.points}), 0)`.mapWith(Number) })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.kind, 'adjust'),
        inArray(
          loyaltyLedger.taxDocumentId,
          tx
            .select({ id: taxDocumentLinks.fromDocumentId })
            .from(taxDocumentLinks)
            .where(eq(taxDocumentLinks.toDocumentId, note.invoiceId)),
        ),
      ),
    )) as [{ points: number }];
  const share = loyaltyPointsToReverse(
    earned.points,
    note.invoiceTaxablePaise,
    note.creditedTaxablePaise,
  );
  return takeBack(tx, {
    organizationId: note.organizationId,
    accountId: earned.accountId,
    points: Math.min(share, earned.points - before.points, earned.balance),
    documentId: note.noteId,
    reference: note.noteNumber,
    note: `Credit note ${note.noteNumber}`,
    memberId: note.memberId,
  });
}

/** Takes back what a same-day cancelled invoice earned (it has no notes). Returns the points. */
export async function reverseLoyaltyForCancel(
  tx: Transaction,
  invoice: {
    readonly organizationId: string;
    readonly invoiceId: string;
    readonly invoiceNumber: string;
    readonly memberId: string;
  },
): Promise<number> {
  const earned = await earnedFor(tx, invoice.invoiceId);
  if (earned === null) return 0;
  return takeBack(tx, {
    organizationId: invoice.organizationId,
    accountId: earned.accountId,
    points: Math.min(earned.points, earned.balance),
    documentId: invoice.invoiceId,
    reference: invoice.invoiceNumber,
    note: `Cancelled invoice ${invoice.invoiceNumber}`,
    memberId: invoice.memberId,
  });
}
