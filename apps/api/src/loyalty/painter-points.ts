import { schema, type Transaction } from '@paint/db';
import {
  earnInvoice,
  lineMillilitres,
  pointsToTakeBack,
  reversalTarget,
  ruleInForce,
  toEarnRule,
  weighLines,
  type CreditedLine,
  type EarnLine,
  type WeightedLine,
} from '@paint/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { addDays } from '../contracts/contract-dates.js';
import { billingLiveOn } from '../credit/credit-lookups.js';
import { loyaltySettingsOf } from './loyalty-lookups.js';
import type { PointsEarnedNotice } from './points-notice.js';

const {
  loyaltyAccounts,
  loyaltyEarnRules,
  loyaltyLedger,
  parties,
  partyRoles,
  productVariants,
  products,
  taxDocumentLines,
  taxDocumentLinks,
  taxDocuments,
} = schema;

/**
 * Painter points from invoices (P2-M36, spec §6.5). An issued invoice earns the
 * influencer tagged on it (a painter or contractor with an active loyalty
 * account) points by the earn rules: one `influencer` entry naming the invoice,
 * at most one per invoice (a unique index backs the check). A credit note
 * (and so a sales return) takes back its weighted share as an `adjust` entry
 * naming the note, a same-day cancellation the rest as one naming the invoice;
 * each at most once per document and account, and never below a zero balance.
 * Called in the issuing or cancelling transaction.
 */

/** Roles that earn painter points ([PO-17]: architects do not). */
export const EARNING_ROLES = ['painter', 'contractor'] as const;

interface InvoiceRef {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly memberId: string;
}

/** The invoice's lines with the brand and litres the rules look at. */
async function earnLines(tx: Transaction, invoiceId: string): Promise<EarnLine[]> {
  const rows = await tx
    .select({
      key: taxDocumentLines.id,
      brandId: products.brandId,
      taxablePaise: taxDocumentLines.taxablePaise,
      quantity: taxDocumentLines.quantity,
      packSize: productVariants.packSize,
      unit: productVariants.unit,
    })
    .from(taxDocumentLines)
    .innerJoin(productVariants, eq(productVariants.id, taxDocumentLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(taxDocumentLines.documentId, invoiceId))
    .orderBy(taxDocumentLines.lineNo);
  return rows.map((row) => ({
    key: row.key,
    brandId: row.brandId,
    taxablePaise: row.taxablePaise,
    millilitres: lineMillilitres(row.quantity, row.packSize, row.unit),
  }));
}

/** The rules that apply to an invoice issued on `issuedOn`. */
async function rulesOn(tx: Transaction, issuedOn: string) {
  const rows = await tx.select().from(loyaltyEarnRules);
  return rows.filter((rule) => ruleInForce(rule, issuedOn)).map(toEarnRule);
}

async function balanceOf(tx: Transaction, accountId: string): Promise<number> {
  const [row] = (await tx
    .select({ points: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)`.mapWith(Number) })
    .from(loyaltyLedger)
    .where(eq(loyaltyLedger.accountId, accountId))) as [{ points: number }];
  return row.points;
}

/**
 * Points an issued invoice earns its influencer; the notice to queue, or null
 * when it earns none: no influencer, the influencer is the bill-to party (who
 * earns as the buyer), not a painter or contractor, no active account, before
 * go-live, already earned, or too small.
 */
export async function earnInfluencerPoints(
  tx: Transaction,
  invoice: InvoiceRef & {
    readonly invoiceNumber: string;
    readonly partyId: string;
    readonly influencerPartyId: string | null;
    /** India date of issue. */
    readonly issuedOn: string;
  },
): Promise<PointsEarnedNotice | null> {
  const influencer = invoice.influencerPartyId;
  if (influencer === null || influencer === invoice.partyId) return null;
  const liveOn = await billingLiveOn(tx);
  if (liveOn === null || invoice.issuedOn < liveOn) return null;
  const [painter] = await tx
    .select({ id: parties.id })
    .from(parties)
    .where(
      and(
        eq(parties.id, influencer),
        sql`exists (select 1 from ${partyRoles} r where r.party_id = ${parties.id} and r.role::text = any(${`{${EARNING_ROLES.join(',')}}`}::text[]))`,
      ),
    );
  if (!painter) return null;
  const [account] = await tx
    .select({ id: loyaltyAccounts.id })
    .from(loyaltyAccounts)
    .where(and(eq(loyaltyAccounts.partyId, influencer), eq(loyaltyAccounts.status, 'active')))
    .for('update');
  if (!account) return null;
  const [already] = await tx
    .select({ id: loyaltyLedger.id })
    .from(loyaltyLedger)
    .where(
      and(eq(loyaltyLedger.taxDocumentId, invoice.invoiceId), eq(loyaltyLedger.kind, 'influencer')),
    );
  if (already) return null;
  const earning = earnInvoice(
    await earnLines(tx, invoice.invoiceId),
    await rulesOn(tx, invoice.issuedOn),
  );
  if (earning.points === 0) return null;
  const programme = await loyaltySettingsOf(tx, invoice.organizationId);
  await tx.insert(loyaltyLedger).values({
    organizationId: invoice.organizationId,
    accountId: account.id,
    kind: 'influencer',
    points: earning.points,
    reference: invoice.invoiceNumber,
    taxDocumentId: invoice.invoiceId,
    expiresOn:
      programme.expiryDays === null ? null : addDays(invoice.issuedOn, programme.expiryDays),
    createdByMemberId: invoice.memberId,
  });
  return {
    organizationId: invoice.organizationId,
    partyId: painter.id,
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    points: earning.points,
    balance: await balanceOf(tx, account.id),
  };
}

/** The invoice's influencer entry, with its account locked; null when it earned none. */
async function influencerEntryOf(tx: Transaction, invoiceId: string) {
  const [entry] = await tx
    .select({ accountId: loyaltyLedger.accountId, points: loyaltyLedger.points })
    .from(loyaltyLedger)
    .where(and(eq(loyaltyLedger.taxDocumentId, invoiceId), eq(loyaltyLedger.kind, 'influencer')));
  if (!entry) return null;
  await tx
    .select({ id: loyaltyAccounts.id })
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.id, entry.accountId))
    .for('update');
  return entry;
}

/** Whether the account already has a take-back naming `documentId` (a retry). */
async function takenBackFor(tx: Transaction, accountId: string, documentId: string) {
  const [row] = await tx
    .select({ id: loyaltyLedger.id })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.accountId, accountId),
        eq(loyaltyLedger.taxDocumentId, documentId),
        eq(loyaltyLedger.kind, 'adjust'),
      ),
    );
  return row !== undefined;
}

/** Issued credit notes against the invoice: which note credited what on which line. */
async function creditedLines(tx: Transaction, invoiceId: string) {
  const notes = tx
    .select({ id: taxDocumentLinks.fromDocumentId })
    .from(taxDocumentLinks)
    .where(eq(taxDocumentLinks.toDocumentId, invoiceId));
  const rows = await tx
    .select({
      noteId: taxDocumentLines.documentId,
      key: taxDocumentLines.sourceLineId,
      creditedTaxablePaise: taxDocumentLines.taxablePaise,
    })
    .from(taxDocumentLines)
    .innerJoin(taxDocuments, eq(taxDocuments.id, taxDocumentLines.documentId))
    .where(
      and(
        inArray(taxDocumentLines.documentId, notes),
        eq(taxDocuments.kind, 'credit_note'),
        eq(taxDocuments.status, 'issued'),
        isNotNull(taxDocumentLines.sourceLineId),
      ),
    );
  return rows.map((row) => ({ ...row, key: String(row.key) }));
}

/** How the invoice's points spread over its lines, by the rules of its issue date. */
async function weightsOf(tx: Transaction, invoiceId: string): Promise<WeightedLine[]> {
  const [invoice] = (await tx
    .select({ issuedOn: taxDocuments.issuedOn })
    .from(taxDocuments)
    .where(eq(taxDocuments.id, invoiceId))) as [{ issuedOn: string }];
  const lines = await earnLines(tx, invoiceId);
  return weighLines(lines, earnInvoice(lines, await rulesOn(tx, invoice.issuedOn)));
}

async function takeBack(
  tx: Transaction,
  entry: {
    readonly organizationId: string;
    readonly accountId: string;
    readonly points: number;
    readonly documentId: string;
    readonly reference: string;
    readonly note: string;
    readonly memberId: string;
  },
): Promise<number> {
  if (entry.points === 0) return 0;
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

/**
 * The credit note hook (spec §4.5, §6.5): takes back the share of the
 * influencer's points the note credits, weighted by what each credited line
 * earned and counted cumulatively over the invoice's notes (reversalTarget),
 * never below a zero balance (pointsToTakeBack). Returns the points taken back.
 */
export async function reverseInfluencerPointsForNote(
  tx: Transaction,
  note: InvoiceRef & { readonly noteId: string; readonly noteNumber: string },
): Promise<number> {
  const earned = await influencerEntryOf(tx, note.invoiceId);
  if (earned === null || (await takenBackFor(tx, earned.accountId, note.noteId))) return 0;
  const weights = await weightsOf(tx, note.invoiceId);
  const credited = await creditedLines(tx, note.invoiceId);
  const before: CreditedLine[] = credited.filter((line) => line.noteId !== note.noteId);
  const step = pointsToTakeBack({
    targetBefore: reversalTarget(earned.points, weights, before),
    targetNow: reversalTarget(earned.points, weights, credited),
    balance: await balanceOf(tx, earned.accountId),
  });
  return takeBack(tx, {
    organizationId: note.organizationId,
    accountId: earned.accountId,
    points: step.points,
    documentId: note.noteId,
    reference: note.noteNumber,
    note: `Painter points, credit note ${note.noteNumber}`,
    memberId: note.memberId,
  });
}

/**
 * Takes back what a same-day cancelled invoice earned its influencer (it has
 * no notes: cancelling refuses an invoice with notes), never below a zero
 * balance. Returns the points taken back.
 */
export async function reverseInfluencerPointsForCancel(
  tx: Transaction,
  invoice: InvoiceRef & { readonly invoiceNumber: string },
): Promise<number> {
  const earned = await influencerEntryOf(tx, invoice.invoiceId);
  if (earned === null || (await takenBackFor(tx, earned.accountId, invoice.invoiceId))) return 0;
  const step = pointsToTakeBack({
    targetBefore: 0,
    targetNow: earned.points,
    balance: await balanceOf(tx, earned.accountId),
  });
  return takeBack(tx, {
    organizationId: invoice.organizationId,
    accountId: earned.accountId,
    points: step.points,
    documentId: invoice.invoiceId,
    reference: invoice.invoiceNumber,
    note: `Painter points, cancelled invoice ${invoice.invoiceNumber}`,
    memberId: invoice.memberId,
  });
}
