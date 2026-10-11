import { schema, type Transaction } from '@paint/db';
import {
  DEFAULT_CREDIT_RULES,
  checkCredit,
  type CreditCheck,
  type CreditRules,
  type MemberAccess,
} from '@paint/shared';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

const { creditProfiles, creditRequests, creditRules, parties, salesSettings } = schema;

type ProfileRow = typeof creditProfiles.$inferSelect;

/** The business's credit rules; the defaults until someone sets them. */
export async function creditRulesOf(tx: Transaction, organizationId: string): Promise<CreditRules> {
  const [rules] = await tx
    .select({
      normalUpToPercent: creditRules.normalUpToPercent,
      managerUpToPercent: creditRules.managerUpToPercent,
      holdAfterOverdueDays: creditRules.holdAfterOverdueDays,
    })
    .from(creditRules)
    .where(eq(creditRules.organizationId, organizationId));
  return rules ?? DEFAULT_CREDIT_RULES;
}

/** The day billing went live (spec §4.7), or null while the MVP 1 figures are used. */
export async function billingLiveOn(tx: Transaction): Promise<string | null> {
  const [settings] = await tx.select({ liveOn: salesSettings.billingLiveOn }).from(salesSettings);
  return settings?.liveOn ?? null;
}

/** Where a party's exposure comes from: entered by hand, or the ledger after go-live. */
export type ExposureSource = 'manual' | 'ledger';

export interface Exposure {
  readonly source: ExposureSource;
  readonly exposurePaise: number;
  readonly overdueDays: number;
}

/** The MVP 1 figures of a credit profile. */
export interface ManualFigures {
  readonly manualExposurePaise: number;
  readonly overdueDays: number;
  readonly openingOverdueSince: string | null;
}

/**
 * What a party owes for the credit rules (spec §4.7). Before go-live: the
 * figures entered by hand. After: its ledger balance plus the unbilled value of
 * its open postpaid orders (but `excludeOrderId`, the one being checked), and
 * overdue days from the oldest unpaid document past its due date, or the
 * opening balance's "overdue since" while it is unpaid. Dates are the
 * database's, India time.
 */
export async function exposureOf(
  tx: Transaction,
  partyId: string,
  manual: ManualFigures,
  excludeOrderId: string | null = null,
): Promise<Exposure> {
  if ((await billingLiveOn(tx)) === null) {
    return {
      source: 'manual',
      exposurePaise: manual.manualExposurePaise,
      overdueDays: manual.overdueDays,
    };
  }
  const result = await tx.execute<{ exposure: string; overdue_days: number }>(sql`
    select
      coalesce((select b.balance_paise from party_balances b where b.party_id = ${partyId}), 0)
      + coalesce((
        select sum(round(l.total_paise * (l.quantity - l.quantity_invoiced - l.quantity_cancelled) / l.quantity))
        from sales_order_lines l
        join sales_orders o on o.id = l.order_id
        where o.bill_to_party_id = ${partyId} and o.payment_terms = 'postpaid'
          and o.status in ('confirmed', 'partly_fulfilled')
          and o.id is distinct from ${excludeOrderId}::uuid
      ), 0) as exposure,
      coalesce(greatest(0, (now() at time zone 'Asia/Kolkata')::date - (
        select min(owed.due) from (
          select d.due_on as due from tax_documents d
          where d.party_id = ${partyId} and d.status = 'issued'
            and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
            and d.total_paise > coalesce((select sum(a.amount_paise) from allocations a where a.document_id = d.id), 0)
          union all
          select ${manual.openingOverdueSince}::date
          where exists (
            select 1 from party_ledger pl
            where pl.party_id = ${partyId} and pl.entry_type = 'opening'
              and pl.amount_paise > coalesce((select sum(a.amount_paise) from allocations a where a.party_ledger_id = pl.id), 0)
          )
        ) owed
      )), 0)::int as overdue_days
  `);
  const [row] = result.rows as [{ exposure: string; overdue_days: number }];
  return { source: 'ledger', exposurePaise: Number(row.exposure), overdueDays: row.overdue_days };
}

/** Where a party stands, with its current check (no sale). */
export interface CreditSummary {
  readonly status: ProfileRow['status'];
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly risk: ProfileRow['risk'];
  /** Entered by hand until billing went live (spec §4.7); read-only after. */
  readonly manualExposurePaise: number;
  /** What the party owes: the manual figure before go-live, the ledger's after. */
  readonly exposurePaise: number;
  readonly exposureSource: ExposureSource;
  /** Days overdue: the manual figure before go-live, the oldest unpaid bill's after. */
  readonly overdueDays: number;
  readonly check: CreditCheck;
  readonly pendingRequest: {
    readonly id: string;
    readonly number: string;
    readonly limitPaise: number;
    readonly creditDays: number;
  } | null;
}

/** A party without a profile: no credit. */
const NO_CREDIT = {
  status: 'none',
  limitPaise: 0,
  creditDays: 0,
  risk: 'low',
  manualExposurePaise: 0,
  overdueDays: 0,
  openingOverdueSince: null,
} as const;

export async function creditSummaryOf(
  tx: Transaction,
  organizationId: string,
  partyId: string,
): Promise<CreditSummary> {
  const [row] = await tx.select().from(creditProfiles).where(eq(creditProfiles.partyId, partyId));
  const profile = row ?? NO_CREDIT;
  const [pending] = await tx
    .select({
      id: creditRequests.id,
      number: creditRequests.number,
      limitPaise: creditRequests.limitPaise,
      creditDays: creditRequests.creditDays,
    })
    .from(creditRequests)
    .where(and(eq(creditRequests.partyId, partyId), eq(creditRequests.status, 'pending')));
  const exposure = await exposureOf(tx, partyId, profile);
  return {
    status: profile.status,
    limitPaise: profile.limitPaise,
    creditDays: profile.creditDays,
    risk: profile.risk,
    manualExposurePaise: profile.manualExposurePaise,
    exposurePaise: exposure.exposurePaise,
    exposureSource: exposure.source,
    overdueDays: exposure.overdueDays,
    check: checkCredit(await creditRulesOf(tx, organizationId), {
      status: profile.status,
      limitPaise: profile.limitPaise,
      exposurePaise: exposure.exposurePaise,
      overdueDays: exposure.overdueDays,
    }),
    pendingRequest: pending ?? null,
  };
}

/** Business-wide parties, and those of the member's stores. */
export function visibleParties(access: MemberAccess): SQL | undefined {
  return access.allStores
    ? undefined
    : or(isNull(parties.homeStoreId), inArray(parties.homeStoreId, [...access.storeIds]));
}
