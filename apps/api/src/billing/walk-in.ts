import { schema, type Transaction } from '@paint/db';
import { eq, sql } from 'drizzle-orm';

const { parties, salesSettings } = schema;

/** The party walk-in sales are billed to, created with the first one (spec §4.6). */
export async function walkInParty(tx: Transaction, organizationId: string): Promise<string> {
  await tx.insert(salesSettings).values({ organizationId }).onConflictDoNothing();
  const [settings] = (await tx
    .select({ walkInPartyId: salesSettings.walkInPartyId })
    .from(salesSettings)
    .for('update')) as [{ walkInPartyId: string | null }];
  if (settings.walkInPartyId !== null) return settings.walkInPartyId;
  const [party] = (await tx
    .insert(parties)
    .values({ organizationId, displayName: 'Walk-in customer', kind: 'person' })
    .returning({ id: parties.id })) as [{ id: string }];
  await tx
    .update(salesSettings)
    .set({ walkInPartyId: party.id, updatedAt: sql`now()` })
    .where(eq(salesSettings.organizationId, organizationId));
  return party.id;
}
