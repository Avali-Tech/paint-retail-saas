import { sql } from 'drizzle-orm';
import type { Transaction } from './client.js';
import { documentSequences } from './schema.js';

/**
 * The next number in an organisation's document series (1, 2, 3, …). Must run
 * inside the transaction that creates the document: concurrent callers queue on
 * the row lock, and a rolled-back document gives its number back, so numbers
 * never skip.
 */
export async function nextDocumentNumber(
  tx: Transaction,
  organizationId: string,
  series: string,
): Promise<number> {
  const [row] = (await tx
    .insert(documentSequences)
    .values({ organizationId, series, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.organizationId, documentSequences.series],
      set: { lastValue: sql`${documentSequences.lastValue} + 1` },
    })
    .returning({ value: documentSequences.lastValue })) as [{ value: number }];
  return row.value;
}
