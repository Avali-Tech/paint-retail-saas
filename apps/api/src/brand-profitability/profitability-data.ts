import { schema, type Transaction } from '@paint/db';
import type { DatedAmount } from '@paint/shared';
import { sql, type SQL } from 'drizzle-orm';
import { datedAllocations } from '../receivables/ageing-data.js';
import type {
  CostedMove,
  CreditBill,
  DocumentPoints,
  MarginInputs,
  PeriodLine,
  Restock,
  SaleKind,
  StoredEarnRule,
} from './margin-rows.js';

/**
 * What brand profitability reads from the books for a period (spec §6.3), in six
 * queries whatever the size of the period (docs/performance.md): the period's sale
 * lines, the units its credit notes put back, the costed receipts that set the
 * average cost of what it sold, every bill owed during it with its dated
 * allocations and lines, the points its documents earned or took back, and the
 * painter earn rules. Business-wide: scheme money is spread over every store's
 * slices, so the caller narrows to the member's stores afterwards.
 */

const {
  loyaltyAccounts,
  loyaltyEarnRules,
  loyaltyLedger,
  partyLedger,
  productVariants,
  products,
  stockLedger,
  taxDocumentLines,
  taxDocuments,
} = schema;

export interface Period {
  readonly from: string;
  readonly to: string;
}

/** Sale documents issued in the period: `d` is the document. */
const inPeriod = (
  period: Period,
) => sql`d.kind in ('invoice', 'bill_of_supply', 'debit_note', 'credit_note')
  and d.status in ('issued', 'cancelled')
  and d.issued_on between ${period.from}::date and ${period.to}::date`;

/** Microseconds since 1970, exactly (timestamps are stored to the microsecond). */
const micros = (column: SQL) => sql`(extract(epoch from ${column}) * 1000000)::bigint::text`;

async function periodLines(tx: Transaction, period: Period): Promise<PeriodLine[]> {
  const result = await tx.execute<{
    document_id: string;
    kind: SaleKind;
    cancelled: boolean;
    store_id: string;
    issued_on: string;
    issued_at: string;
    line_id: string;
    variant_id: string;
    product_id: string;
    brand_id: string;
    taxable_paise: string;
    total_paise: string;
    quantity: string;
    pack_size: string;
    unit: string;
    source_issued_on: string | null;
  }>(sql`
    select d.id as document_id, d.kind::text as kind, d.status = 'cancelled' as cancelled,
      d.store_id, d.issued_on::text as issued_on,
      ${micros(sql`coalesce(d.issued_at, d.issued_on::timestamptz)`)} as issued_at,
      l.id as line_id, l.variant_id, v.product_id, p.brand_id, l.taxable_paise, l.total_paise,
      l.quantity::text as quantity, v.pack_size::text as pack_size, v.unit::text as unit,
      sd.issued_on::text as source_issued_on
    from ${taxDocuments} d
    join ${taxDocumentLines} l on l.document_id = d.id
    join ${productVariants} v on v.id = l.variant_id
    join ${products} p on p.id = v.product_id
    left join ${taxDocumentLines} sl on sl.id = l.source_line_id
    left join ${taxDocuments} sd on sd.id = sl.document_id
    where ${inPeriod(period)}
    order by d.id, l.line_no
  `);
  return result.rows.map((row) => ({
    documentId: row.document_id,
    kind: row.kind,
    cancelled: row.cancelled,
    storeId: row.store_id,
    issuedOn: row.issued_on,
    issuedAt: BigInt(row.issued_at),
    lineId: row.line_id,
    variantId: row.variant_id,
    productId: row.product_id,
    brandId: row.brand_id,
    taxablePaise: Number(row.taxable_paise),
    totalPaise: Number(row.total_paise),
    quantity: Number(row.quantity),
    packSize: Number(row.pack_size),
    unit: row.unit,
    sourceIssuedOn: row.source_issued_on,
  }));
}

/** Per issued credit note of the period and variant: units returned less written off. */
async function restocks(tx: Transaction, period: Period): Promise<Restock[]> {
  const result = await tx.execute<{ document_id: string; variant_id: string; quantity: string }>(
    sql`
    select s.reference_id as document_id, s.variant_id, sum(s.quantity)::text as quantity
    from ${stockLedger} s
    join ${taxDocuments} d on d.id = s.reference_id
    where s.reference_type = 'tax_document' and s.movement_type in ('sale_return', 'damage')
      and d.kind = 'credit_note' and d.status = 'issued' and ${inPeriod(period)}
    group by s.reference_id, s.variant_id
  `,
  );
  return result.rows.map((row) => ({
    documentId: row.document_id,
    variantId: row.variant_id,
    quantity: Number(row.quantity),
  }));
}

/**
 * The costed receipts into every store and variant the period sold or took back,
 * up to its last document, each with the stock on hand just before it: enough to
 * replay the average cost (`averageCosts`) without reading every sale.
 */
async function costedMoves(tx: Transaction, period: Period): Promise<CostedMove[]> {
  const result = await tx.execute<{
    store_id: string;
    variant_id: string;
    at: string;
    quantity: string;
    unit_cost_paise: string;
    before: string;
  }>(sql`
    with docs as (
      select d.id, d.store_id, coalesce(d.issued_at, d.issued_on::timestamptz) as issued_at
      from ${taxDocuments} d
      where ${inPeriod(period)} and d.status = 'issued' and d.kind <> 'debit_note'
    ),
    pairs as (
      select distinct docs.store_id, l.variant_id
      from docs join ${taxDocumentLines} l on l.document_id = docs.id
    ),
    moves as (
      select s.store_id, s.variant_id, s.created_at, s.id, s.quantity, s.unit_cost_paise,
        coalesce(sum(s.quantity) over (
          partition by s.store_id, s.variant_id order by s.created_at, s.id
          rows between unbounded preceding and 1 preceding
        ), 0) as before
      from ${stockLedger} s
      join pairs on pairs.store_id = s.store_id and pairs.variant_id = s.variant_id
      where s.created_at <= (select max(issued_at) from docs)
    )
    select store_id, variant_id, ${micros(sql`created_at`)} as at, quantity::text as quantity,
      unit_cost_paise::text as unit_cost_paise, before::text as before
    from moves
    where quantity > 0 and unit_cost_paise is not null
    order by store_id, variant_id, created_at, id
  `);
  return result.rows.map((row) => ({
    storeId: row.store_id,
    variantId: row.variant_id,
    at: BigInt(row.at),
    quantity: Number(row.quantity),
    unitCostPaise: Number(row.unit_cost_paise),
    onHandBefore: Number(row.before),
  }));
}

/**
 * Every invoice, bill of supply and debit note owed on at some time in the period:
 * raised by its end, not settled (nor cancelled) before it began, with each
 * allocation dated as ageing dates it, and its lines' brands and totals.
 */
async function bills(tx: Transaction, period: Period): Promise<CreditBill[]> {
  const from = sql`${period.from}::date`;
  const result = await tx.execute<{
    id: string;
    store_id: string;
    raised_on: string;
    total_paise: string;
    cancelled_on: string | null;
    allocations: DatedAmount[];
    lines: { productId: string; brandId: string; totalPaise: number }[];
  }>(sql`
    with docs as (
      select d.id, d.store_id, d.issued_on, d.total_paise,
        (select pl.entry_on from ${partyLedger} pl where pl.reference_type = 'tax_document'
          and pl.reference_id = d.id and pl.entry_type = 'cancellation') as cancelled_on
      from ${taxDocuments} d
      where d.kind in ('invoice', 'bill_of_supply', 'debit_note') and d.status in ('issued', 'cancelled')
        and d.total_paise > 0 and d.issued_on <= ${period.to}::date
    ),
    x as (${datedAllocations(sql`a.document_id in (select id from docs)`)}),
    owed as (
      select docs.id, docs.store_id, docs.issued_on, docs.total_paise, docs.cancelled_on,
        coalesce(json_agg(json_build_object('on', x.eff_on, 'amountPaise', x.amount_paise)
          order by x.eff_on, x.id) filter (where x.id is not null), '[]'::json) as allocations
      from docs left join x on x.document_id = docs.id
      where docs.cancelled_on is null or docs.cancelled_on > ${from}
      group by docs.id, docs.store_id, docs.issued_on, docs.total_paise, docs.cancelled_on
      having docs.total_paise > coalesce(sum(x.amount_paise) filter (where x.eff_on <= ${from}), 0)
        or coalesce(bool_or(x.eff_on > ${from}), false)
    )
    select owed.id, owed.store_id, owed.issued_on::text as raised_on, owed.total_paise,
      owed.cancelled_on::text as cancelled_on, owed.allocations,
      coalesce((select json_agg(json_build_object('productId', v.product_id, 'brandId', p.brand_id,
          'totalPaise', l.total_paise) order by l.line_no)
        from ${taxDocumentLines} l
        join ${productVariants} v on v.id = l.variant_id
        join ${products} p on p.id = v.product_id
        where l.document_id = owed.id), '[]'::json) as lines
    from owed
  `);
  return result.rows.map((row) => ({
    id: row.id,
    storeId: row.store_id,
    raisedOn: row.raised_on,
    totalPaise: Number(row.total_paise),
    cancelledOn: row.cancelled_on,
    // JSON numbers: paise stay well inside 2^53.
    allocations: row.allocations,
    lines: row.lines,
  }));
}

/**
 * Points the period's documents earned or took back, net per document and holder:
 * entries on the document's own party's account are the bill-to's, others its
 * influencer's (spec §6.5: both name the same documents).
 */
async function documentPoints(tx: Transaction, period: Period): Promise<DocumentPoints[]> {
  const result = await tx.execute<{
    document_id: string;
    holder: 'customer' | 'painter';
    points: string;
  }>(sql`
    select e.tax_document_id as document_id,
      case when a.party_id = d.party_id then 'customer' else 'painter' end as holder,
      sum(e.points)::text as points
    from ${loyaltyLedger} e
    join ${loyaltyAccounts} a on a.id = e.account_id
    join ${taxDocuments} d on d.id = e.tax_document_id
    where e.kind::text in ('purchase', 'influencer', 'adjust') and ${inPeriod(period)}
    group by 1, 2
    order by 1, 2
  `);
  return result.rows.map((row) => ({
    documentId: row.document_id,
    holder: row.holder,
    points: Number(row.points),
  }));
}

async function earnRules(tx: Transaction): Promise<StoredEarnRule[]> {
  return tx
    .select({
      id: loyaltyEarnRules.id,
      basis: loyaltyEarnRules.basis,
      points: loyaltyEarnRules.points,
      perPaise: loyaltyEarnRules.perPaise,
      perMillilitres: loyaltyEarnRules.perMillilitres,
      brandId: loyaltyEarnRules.brandId,
      multiplierBps: loyaltyEarnRules.multiplierBps,
      isActive: loyaltyEarnRules.isActive,
      validFrom: loyaltyEarnRules.validFrom,
      validUntil: loyaltyEarnRules.validUntil,
    })
    .from(loyaltyEarnRules);
}

/** Everything `marginRows` needs for the period. */
export async function loadMarginInputs(tx: Transaction, period: Period): Promise<MarginInputs> {
  return {
    lines: await periodLines(tx, period),
    restocks: await restocks(tx, period),
    costedMoves: await costedMoves(tx, period),
    bills: await bills(tx, period),
    points: await documentPoints(tx, period),
    rules: await earnRules(tx),
  };
}
