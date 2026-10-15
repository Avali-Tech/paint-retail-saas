import { schema, type Transaction } from '@paint/db';
import type { Credit, DatedAmount, MemberAccess, Receivable } from '@paint/shared';
import { sql, type SQL } from 'drizzle-orm';
import { containsPattern, phoneSearchDigits } from '../parties/party-access.js';

/**
 * The rows the ageing engine needs (packages/shared/src/receivables), read straight
 * from the 2.0 books (spec §1.3: ageing is a query, no new ledger):
 *
 * - owed: issued (or since cancelled) invoices, bills of supply and debit notes, and
 *   party-ledger openings and charges (positive adjustments, as `openTargets` has them);
 * - paid ahead: money received, and credit notes;
 * - allocations between them, each dated when it took effect: the later of its two
 *   ends' ledger dates, and for an undo, also the day it was undone (a bounced
 *   cheque's bounce date). An allocation is never dated before either end, which is
 *   what keeps Σ outstanding − Σ unapplied equal to the ledger's balance on any day.
 *
 * Only bills and credits with something left on the as-of day come back.
 */

const {
  allocations,
  creditProfiles,
  customerProfiles,
  parties,
  partyLedger,
  payments,
  taxDocuments,
} = schema;

export interface AgeingScope {
  readonly asOf: string;
  /** One party only (a statement, a drill-down). */
  readonly partyId?: string;
  /** Only bills and credits of this store. */
  readonly storeId?: string;
  /** Only customers this member looks after; "none" for those nobody does. */
  readonly salespersonId?: string;
  /** Customer name or mobile. */
  readonly q?: string;
}

export interface AgeingInput {
  readonly receivables: Receivable[];
  readonly credits: Credit[];
}

/**
 * The parties the member may see (`canSeeParty`): business-wide parties, and those
 * whose home store is one of the member's. Narrowed by the scope's filters.
 */
function partyScope(auth: MemberAccess, scope: AgeingScope): SQL {
  const conditions: SQL[] = [sql`true`];
  if (!auth.allStores) {
    const stores = `{${[...auth.storeIds].join(',')}}`;
    conditions.push(sql`(p.home_store_id is null or p.home_store_id = any(${stores}::uuid[]))`);
  }
  if (scope.partyId !== undefined) conditions.push(sql`p.id = ${scope.partyId}`);
  if (scope.salespersonId === 'none') conditions.push(sql`cp.assigned_member_id is null`);
  else if (scope.salespersonId !== undefined) {
    conditions.push(sql`cp.assigned_member_id = ${scope.salespersonId}`);
  }
  if (scope.q !== undefined) {
    // As the customer list searches: a number looks up mobiles, anything else names.
    const digits = phoneSearchDigits(scope.q);
    conditions.push(
      digits === null
        ? sql`p.display_name ilike ${containsPattern(scope.q)}`
        : sql`p.phone ilike ${containsPattern(digits)}`,
    );
  }
  return sql`select p.id from ${parties} p left join ${customerProfiles} cp on cp.party_id = p.id
    where ${sql.join(conditions, sql` and `)}`;
}

/** What every party in scope owes and has paid ahead, as of `scope.asOf`. */
export async function loadAgeing(
  tx: Transaction,
  auth: MemberAccess,
  scope: AgeingScope,
): Promise<AgeingInput> {
  const asOf = sql`${scope.asOf}::date`;
  const store = (column: SQL) =>
    scope.storeId === undefined ? sql`true` : sql`${column} = ${scope.storeId}`;
  /** Allocations taking effect by the as-of day, summed; `x` is the dated allocation. */
  const allocated = sql`coalesce(sum(x.amount_paise) filter (where x.eff_on <= ${asOf}), 0)`;
  const dated = sql`coalesce(json_agg(json_build_object('on', x.eff_on, 'amountPaise', x.amount_paise)
    order by x.eff_on, x.id) filter (where x.id is not null), '[]'::json)`;
  const cancelledOn = (id: SQL) => sql`(select l.entry_on from ${partyLedger} l
    where l.reference_type = 'tax_document' and l.reference_id = ${id} and l.entry_type = 'cancellation')`;

  const result = await tx.execute<{
    side: 'owed' | 'paid';
    id: string;
    kind: string;
    party_id: string;
    store_id: string | null;
    number: string | null;
    raised_on: string;
    due_on: string | null;
    total: string;
    ended_on: string | null;
    allocations: DatedAmount[];
  }>(sql`
    with scope as (${partyScope(auth, scope)}),
    x as (
      select a.id, a.document_id, a.party_ledger_id, a.payment_id, a.credit_note_id, a.amount_paise,
        greatest(
          coalesce(sp.received_on, sc.issued_on),
          coalesce(td.issued_on, tl.entry_on, tr.received_on),
          case
            when a.reverses_allocation_id is null then null
            when a.reversal_reason = 'cheque_bounce' then sp.cheque_bounced_on
            else (a.created_at at time zone 'Asia/Kolkata')::date
          end
        ) as eff_on
      from ${allocations} a
      left join ${payments} sp on sp.id = a.payment_id
      left join ${taxDocuments} sc on sc.id = a.credit_note_id
      left join ${taxDocuments} td on td.id = a.document_id
      left join ${partyLedger} tl on tl.id = a.party_ledger_id
      left join ${payments} tr on tr.id = a.refund_payment_id
      where a.party_id in (select id from scope)
    ),
    owed as (
      select 'owed' as side, d.id, d.kind::text as kind, d.party_id, d.store_id, d.number,
        d.issued_on as raised_on, d.due_on, d.total_paise as total,
        ${cancelledOn(sql`d.id`)} as ended_on, ${dated} as allocations,
        d.total_paise - ${allocated} as left_paise
      from ${taxDocuments} d
      left join x on x.document_id = d.id
      where d.kind in ('invoice', 'bill_of_supply', 'debit_note') and d.status in ('issued', 'cancelled')
        and d.total_paise > 0 and d.issued_on <= ${asOf}
        and d.party_id in (select id from scope) and ${store(sql`d.store_id`)}
      group by d.id
      union all
      select 'owed', l.id, case l.entry_type when 'opening' then 'opening' else 'charge' end,
        l.party_id, l.store_id,
        (select bp.number from ${payments} bp where l.reference_type = 'payment' and bp.id = l.reference_id),
        l.entry_on,
        case when l.entry_type = 'opening' then coalesce((
          select c.opening_overdue_since from ${creditProfiles} c where c.party_id = l.party_id
        ), l.entry_on) else l.entry_on end,
        l.amount_paise, null::date, ${dated}, l.amount_paise - ${allocated}
      from ${partyLedger} l
      left join x on x.party_ledger_id = l.id
      where l.entry_type in ('opening', 'adjustment') and l.amount_paise > 0 and l.entry_on <= ${asOf}
        and l.party_id in (select id from scope) and ${store(sql`l.store_id`)}
      group by l.id
    ),
    paid as (
      select 'paid' as side, p.id, 'payment' as kind, p.party_id, p.store_id, p.number,
        p.received_on as raised_on, null::date as due_on, p.amount_paise as total,
        p.cheque_bounced_on as ended_on, ${dated} as allocations,
        (case when p.cheque_bounced_on <= ${asOf} then 0 else p.amount_paise end) - ${allocated} as left_paise
      from ${payments} p
      left join x on x.payment_id = p.id
      where p.direction = 'in' and p.received_on <= ${asOf}
        and p.party_id in (select id from scope) and ${store(sql`p.store_id`)}
      group by p.id
      union all
      select 'paid', d.id, 'credit_note', d.party_id, d.store_id, d.number, d.issued_on, null::date,
        d.total_paise, ${cancelledOn(sql`d.id`)}, ${dated},
        (case when ${cancelledOn(sql`d.id`)} <= ${asOf} then 0 else d.total_paise end) - ${allocated}
      from ${taxDocuments} d
      left join x on x.credit_note_id = d.id
      where d.kind = 'credit_note' and d.status in ('issued', 'cancelled') and d.total_paise > 0
        and d.issued_on <= ${asOf}
        and d.party_id in (select id from scope) and ${store(sql`d.store_id`)}
      group by d.id
    )
    select side, id, kind, party_id, store_id, number, raised_on::text, due_on::text, total,
      ended_on::text, allocations
    from (select * from owed union all select * from paid) t
    where left_paise <> 0
  `);

  const receivables: Receivable[] = [];
  const credits: Credit[] = [];
  for (const row of result.rows) {
    const common = {
      id: row.id,
      partyId: row.party_id,
      storeId: row.store_id,
      number: row.number,
      allocations: row.allocations,
    };
    if (row.side === 'owed') {
      receivables.push({
        ...common,
        kind: row.kind as Receivable['kind'],
        raisedOn: row.raised_on,
        dueOn: row.due_on,
        totalPaise: Number(row.total),
        cancelledOn: row.ended_on,
      });
    } else {
      credits.push({
        ...common,
        kind: row.kind as Credit['kind'],
        receivedOn: row.raised_on,
        amountPaise: Number(row.total),
        voidedOn: row.ended_on,
      });
    }
  }
  return { receivables, credits };
}
