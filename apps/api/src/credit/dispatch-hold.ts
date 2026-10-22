import { ConflictException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { formatINR } from '@paint/shared';
import { and, eq, sql } from 'drizzle-orm';

const { allocations, creditProfiles, projects, siteCreditAccounts } = schema;

/** The invoice fields the hold check reads. */
export interface DispatchedInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly partyId: string | null;
  readonly projectId: string | null;
  readonly totalPaise: number;
}

/**
 * Goods on an unpaid bill do not leave while the contractor, or the site the
 * bill is for, is on hold or closed. Credit was checked when the bill was
 * issued; this catches a hold placed since, such as the nightly overdue hold.
 * Only the bill's own site counts, so a contractor held on one site still
 * takes delivery on another. A bill paid in full always goes.
 */
export async function assertNotHeldForDispatch(
  tx: Transaction,
  invoice: DispatchedInvoice,
): Promise<void> {
  // Every issued bill has a party: walk-in sales go to the walk-in party (spec §4.6).
  const partyId = String(invoice.partyId);
  const [paid] = await tx
    .select({ paise: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
    .from(allocations)
    .where(eq(allocations.documentId, invoice.id));
  const owedPaise = invoice.totalPaise - Number(paid?.paise);
  if (owedPaise <= 0) return;
  const owed = `${formatINR(owedPaise)} is still owed on ${String(invoice.number)}`;
  const [profile] = await tx
    .select({ status: creditProfiles.status, reason: creditProfiles.holdReason })
    .from(creditProfiles)
    .where(eq(creditProfiles.partyId, partyId));
  if (profile?.status === 'on_hold') {
    throw new ConflictException(
      `${owed} and the customer's credit is on hold (${String(profile.reason)}). ` +
        'Take the payment or release the hold before dispatching.',
    );
  }
  if (invoice.projectId === null) return;
  const [site] = await tx
    .select({
      status: siteCreditAccounts.status,
      reason: siteCreditAccounts.holdReason,
      name: projects.name,
    })
    .from(siteCreditAccounts)
    .innerJoin(projects, eq(projects.id, siteCreditAccounts.projectId))
    .where(
      and(
        eq(siteCreditAccounts.partyId, partyId),
        eq(siteCreditAccounts.projectId, invoice.projectId),
      ),
    );
  if (site?.status === 'on_hold') {
    throw new ConflictException(
      `${owed} and the site ${site.name} is on hold (${String(site.reason)}). ` +
        'Take the payment or release the site before dispatching.',
    );
  }
  if (site?.status === 'closed') {
    throw new ConflictException(
      `${owed} and the site ${site.name} is closed. Take the payment before dispatching.`,
    );
  }
}
