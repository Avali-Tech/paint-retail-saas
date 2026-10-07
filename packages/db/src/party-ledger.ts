import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.js';
import { partyBalances, partyLedger, type partyLedgerEntryType } from './schema.js';

export type PartyLedgerEntryType = (typeof partyLedgerEntryType.enumValues)[number];

export interface PartyLedgerEntry {
  readonly organizationId: string;
  readonly partyId: string;
  readonly storeId?: string;
  /** India business date, YYYY-MM-DD. */
  readonly entryOn: string;
  readonly entryType: PartyLedgerEntryType;
  /** Positive = the party owes more; its sign must match the type. */
  readonly amountPaise: number;
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly note?: string;
  readonly createdByMemberId?: string;
}

/**
 * The only way a party's balance changes: appends each entry to the party
 * ledger and adds it to party_balances in the same transaction, as
 * postStockMovements does for stock. Balances are touched in party order, so
 * concurrent posts cannot deadlock.
 */
export async function postPartyLedger(
  tx: Transaction,
  entries: readonly PartyLedgerEntry[],
): Promise<void> {
  const ordered = [...entries].sort((a, b) => a.partyId.localeCompare(b.partyId));
  for (const entry of ordered) {
    await tx.insert(partyLedger).values(entry);
    await tx
      .insert(partyBalances)
      .values({
        organizationId: entry.organizationId,
        partyId: entry.partyId,
        balancePaise: entry.amountPaise,
      })
      .onConflictDoUpdate({
        target: partyBalances.partyId,
        set: {
          balancePaise: sql`${partyBalances.balancePaise} + ${entry.amountPaise}`,
          updatedAt: sql`now()`,
        },
      });
  }
}

export interface PartyBalanceMismatch {
  readonly organizationId: string;
  readonly partyId: string;
  readonly balancePaise: number;
  readonly ledgerTotalPaise: number;
}

/**
 * Parties whose cached balance differs from the sum of their ledger entries.
 * Should always be empty (spec §4.6); outside tenant scope it checks every
 * organisation.
 */
export async function findPartyBalanceMismatches(
  db: Database | Transaction,
): Promise<PartyBalanceMismatch[]> {
  const result = await db.execute<{
    organization_id: string;
    party_id: string;
    balance_paise: string;
    ledger_total: string;
  }>(sql`
    select
      coalesce(b.organization_id, l.organization_id) as organization_id,
      coalesce(b.party_id, l.party_id) as party_id,
      coalesce(b.balance_paise, 0) as balance_paise,
      coalesce(l.total, 0) as ledger_total
    from ${partyBalances} b
    full outer join (
      select pl.organization_id, pl.party_id, sum(pl.amount_paise) as total
      from ${partyLedger} pl
      group by pl.organization_id, pl.party_id
    ) l on l.party_id = b.party_id
    where coalesce(b.balance_paise, 0) <> coalesce(l.total, 0)
    order by 1, 2
  `);
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    partyId: row.party_id,
    balancePaise: Number(row.balance_paise),
    ledgerTotalPaise: Number(row.ledger_total),
  }));
}
