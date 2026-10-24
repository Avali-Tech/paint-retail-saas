import { ConflictException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { fieldError } from '../tax/tax-lookups.js';

const { mistintedCans, taxDocumentLines } = schema;

interface MistintLineRequest {
  readonly storeId: string;
  readonly lines: readonly {
    readonly variantId: string;
    readonly quantity: number;
    readonly mistintCanId?: string | undefined;
  }[];
}

/**
 * A line selling a mistinted can sells that can: still waiting to be sold, at
 * the bill's store, its base and its whole quantity, once on the bill.
 */
export async function assertMistintLines(tx: Transaction, input: MistintLineRequest) {
  const asked = input.lines.flatMap((line, index) =>
    line.mistintCanId === undefined ? [] : [{ line, index, canId: line.mistintCanId }],
  );
  if (asked.length === 0) return;
  const cans = await tx
    .select()
    .from(mistintedCans)
    .where(
      inArray(
        mistintedCans.id,
        asked.map((entry) => entry.canId),
      ),
    );
  const seen = new Set<string>();
  for (const { line, index, canId } of asked) {
    const at = `lines.${String(index)}.mistintCanId`;
    const can = cans.find((candidate) => candidate.id === canId);
    if (can?.status !== 'available') {
      throw fieldError(at, 'This mistinted can is no longer for sale');
    }
    if (can.storeId !== input.storeId)
      throw fieldError(at, 'This mistinted can is at another store');
    if (can.variantId !== line.variantId || can.quantity !== line.quantity || seen.has(canId)) {
      throw fieldError(at, 'Sell the mistinted can as it is: its product, its whole quantity');
    }
    seen.add(canId);
  }
}

/**
 * At issue: each mistinted can the bill sells comes back into stock to leave
 * as a sale (so sales count it), and is marked sold for its value before GST.
 * Refused if another bill sold it first. Returns the stock coming back in.
 */
export async function sellMistintedCans(tx: Transaction, auth: AuthContext, documentId: string) {
  const lines = await tx
    .select({
      canId: sql<string>`${taxDocumentLines.mistintCanId}`,
      taxablePaise: taxDocumentLines.taxablePaise,
    })
    .from(taxDocumentLines)
    .where(
      and(
        eq(taxDocumentLines.documentId, documentId),
        sql`${taxDocumentLines.mistintCanId} is not null`,
      ),
    );
  if (lines.length === 0) return [];
  const cans = await tx
    .select()
    .from(mistintedCans)
    .where(
      inArray(
        mistintedCans.id,
        lines.map((line) => line.canId),
      ),
    )
    .for('update');
  if (cans.some((can) => can.status !== 'available')) {
    throw new ConflictException('A mistinted can on this bill was sold or written off meanwhile');
  }
  for (const line of lines) {
    await tx
      .update(mistintedCans)
      .set({
        status: 'sold',
        soldTaxablePaise: line.taxablePaise,
        resolvedAt: sql`now()`,
        resolvedByMemberId: auth.memberId,
        updatedAt: sql`now()`,
      })
      .where(eq(mistintedCans.id, line.canId));
  }
  return cans.map((can) => ({
    organizationId: can.organizationId,
    storeId: can.storeId,
    variantId: can.variantId,
    movementType: 'mistint' as const,
    quantity: can.quantity,
    referenceType: 'mistinted_can',
    referenceId: can.id,
    note: `Sold as mistinted ${can.shadeCode}`,
    createdByMemberId: auth.memberId,
  }));
}

/**
 * When the bill is cancelled: the cans it sold go back on the mistinted list
 * (and out of sellable stock again). Returns the stock going back out.
 */
export async function unsellMistintedCans(tx: Transaction, auth: AuthContext, documentId: string) {
  const sold = await tx
    .select({ can: mistintedCans })
    .from(taxDocumentLines)
    .innerJoin(mistintedCans, eq(mistintedCans.id, taxDocumentLines.mistintCanId))
    .where(eq(taxDocumentLines.documentId, documentId));
  for (const { can } of sold) {
    await tx
      .update(mistintedCans)
      .set({
        status: 'available',
        soldTaxablePaise: null,
        resolvedAt: null,
        resolvedByMemberId: null,
        updatedAt: sql`now()`,
      })
      .where(eq(mistintedCans.id, can.id));
  }
  return sold.map(({ can }) => ({
    organizationId: can.organizationId,
    storeId: can.storeId,
    variantId: can.variantId,
    movementType: 'mistint' as const,
    quantity: -can.quantity,
    referenceType: 'mistinted_can',
    referenceId: can.id,
    note: `Back on the mistinted list (bill cancelled): ${can.shadeCode}`,
    createdByMemberId: auth.memberId,
  }));
}
