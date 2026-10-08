import { schema, type Transaction } from '@paint/db';
import { eq, sql } from 'drizzle-orm';

const { dispatchLines, dispatches } = schema;

/** Units of each line of an invoice dispatched so far (0 for a line not dispatched). */
export async function dispatchedByLine(
  tx: Transaction,
  invoiceId: string,
): Promise<(invoiceLineId: string) => number> {
  const rows = await tx
    .select({
      invoiceLineId: dispatchLines.invoiceLineId,
      quantity: sql<number>`sum(${dispatchLines.quantity})`.mapWith(Number),
    })
    .from(dispatchLines)
    .innerJoin(dispatches, eq(dispatches.id, dispatchLines.dispatchId))
    .where(eq(dispatches.invoiceId, invoiceId))
    .groupBy(dispatchLines.invoiceLineId);
  const byLine = new Map(rows.map((row) => [row.invoiceLineId, row.quantity]));
  return (invoiceLineId) => byLine.get(invoiceLineId) ?? 0;
}
