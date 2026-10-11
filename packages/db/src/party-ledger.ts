import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.js';
import {
  allocations,
  partyBalances,
  partyLedger,
  payments,
  taxDocuments,
  type partyLedgerEntryType,
} from './schema.js';

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

/**
 * Adds `deltaPaise` to the party's money received but not yet allocated
 * (`party_balances.advance_paise`, spec §4.6), in the caller's transaction.
 * Call it after the ledger entry that created the balance row; the row's
 * check refuses an advance below zero.
 */
export async function adjustPartyAdvance(
  tx: Transaction,
  partyId: string,
  deltaPaise: number,
): Promise<void> {
  await tx
    .update(partyBalances)
    .set({
      advancePaise: sql`${partyBalances.advancePaise} + ${deltaPaise}`,
      updatedAt: sql`now()`,
    })
    .where(sql`${partyBalances.partyId} = ${partyId}`);
}

export interface AllocationMismatch {
  readonly organizationId: string;
  readonly partyId: string;
  readonly balancePaise: number;
  readonly advancePaise: number;
  /** What the party still owes on its documents, opening balance and charges. */
  readonly outstandingPaise: number;
  /** Money received (and credit notes) not allocated, from the rows themselves. */
  readonly unallocatedPaise: number;
}

/**
 * Parties whose allocations disagree with their balance (spec §4.6): the
 * cached advance must equal the unallocated payments and credit notes, and
 * what is outstanding less that advance must equal the balance. Should always
 * be empty; outside tenant scope it checks every organisation.
 */
export async function findAllocationMismatches(
  db: Database | Transaction,
): Promise<AllocationMismatch[]> {
  const result = await db.execute<{
    organization_id: string;
    party_id: string;
    balance_paise: string;
    advance_paise: string;
    outstanding: string;
    unallocated: string;
  }>(sql`
    with owed as (
      select d.party_id, d.total_paise - coalesce((
        select sum(a.amount_paise) from ${allocations} a where a.document_id = d.id
      ), 0) as amount
      from ${taxDocuments} d
      where d.status = 'issued' and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
      union all
      select l.party_id, l.amount_paise - coalesce((
        select sum(a.amount_paise) from ${allocations} a where a.party_ledger_id = l.id
      ), 0) as amount
      from ${partyLedger} l
      where l.entry_type in ('opening', 'adjustment') and l.amount_paise > 0
    ),
    credit as (
      select p.party_id, p.amount_paise - coalesce((
        select sum(a.amount_paise) from ${allocations} a where a.payment_id = p.id
      ), 0) as amount
      from ${payments} p
      where p.direction = 'in' and p.cheque_status is distinct from 'bounced'
      union all
      select d.party_id, d.total_paise - coalesce((
        select sum(a.amount_paise) from ${allocations} a where a.credit_note_id = d.id
      ), 0) as amount
      from ${taxDocuments} d
      where d.status = 'issued' and d.kind = 'credit_note'
    ),
    totals as (
      select b.organization_id, b.party_id, b.balance_paise, b.advance_paise,
        coalesce((select sum(o.amount) from owed o where o.party_id = b.party_id), 0) as outstanding,
        coalesce((select sum(c.amount) from credit c where c.party_id = b.party_id), 0) as unallocated
      from ${partyBalances} b
    )
    select t.organization_id, t.party_id, t.balance_paise, t.advance_paise, t.outstanding, t.unallocated
    from totals t
    where t.advance_paise <> t.unallocated or t.outstanding - t.unallocated <> t.balance_paise
    order by 1, 2
  `);
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    partyId: row.party_id,
    balancePaise: Number(row.balance_paise),
    advancePaise: Number(row.advance_paise),
    outstandingPaise: Number(row.outstanding),
    unallocatedPaise: Number(row.unallocated),
  }));
}
