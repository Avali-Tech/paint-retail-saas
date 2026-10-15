import { schema, type Transaction } from '@paint/db';
import {
  DEFAULT_CREDIT_RULES,
  checkCredit,
  type CreditApprovalSummary,
  type CreditPosition,
  type CreditRules,
  type ExposureBreakdown,
  type MemberAccess,
  type PartyCreditSummary,
  type SiteAccountView,
} from '@paint/shared';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

const {
  creditApprovals,
  creditProfiles,
  creditRequests,
  creditRules,
  parties,
  projects,
  salesSettings,
  siteCreditAccounts,
} = schema;

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
  /** The parts of a ledger exposure; null before go-live. */
  readonly breakdown: ExposureBreakdown | null;
  /** A release with approval waives the overdue block until a date (MVP 3 spec §4.4). */
  readonly overdueWaived: boolean;
}

/** The MVP 1 figures of a credit profile, and the overdue waiver. */
export interface ManualFigures {
  readonly manualExposurePaise: number;
  readonly overdueDays: number;
  readonly openingOverdueSince: string | null;
  readonly overdueWaivedUntil?: string | null;
}

/** India's date today, from the database clock. */
export const indiaToday = sql`(now() at time zone 'Asia/Kolkata')::date`;

/**
 * What is still owed on each open document of a party (MVP 2 spec §4.6):
 * issued invoices, bills of supply and debit notes, less what is allocated
 * to them. `projectId` narrows it to a site (MVP 3 spec §3.3).
 */
export function openDocumentsOf(partyId: string | SQL, projectId: string | null = null): SQL {
  return sql`
    select d.id, d.number, d.kind, d.issued_on, d.due_on, d.total_paise,
      d.total_paise - coalesce((select sum(a.amount_paise) from allocations a where a.document_id = d.id), 0) as outstanding
    from tax_documents d
    where d.party_id = ${partyId} and d.status = 'issued'
      and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
      and (${projectId}::uuid is null or d.project_id = ${projectId}::uuid)`;
}

/** The unbilled value of a party's open postpaid orders, but `excludeOrderId`'s, optionally on one site. */
function openOrdersOf(partyId: string, excludeOrderId: string | null, projectId: string | null) {
  return sql`coalesce((
    select sum(round(l.total_paise * (l.quantity - l.quantity_invoiced - l.quantity_cancelled) / l.quantity))
    from sales_order_lines l
    join sales_orders o on o.id = l.order_id
    where o.bill_to_party_id = ${partyId} and o.payment_terms = 'postpaid'
      and o.status in ('confirmed', 'partly_fulfilled')
      and o.id is distinct from ${excludeOrderId}::uuid
      and (${projectId}::uuid is null or o.project_id = ${projectId}::uuid)
  ), 0)`;
}

/**
 * What a party owes for the credit rules (MVP 2 spec §4.7, MVP 3 spec §4.1).
 * Before go-live: the figures entered by hand. After: its ledger balance plus
 * the unbilled value of its open postpaid orders (but `excludeOrderId`, the one
 * being checked), and overdue days from the oldest open document past its due
 * date, or the opening balance's "overdue since" while it is unpaid. Dates are
 * the database's, India time.
 */
export async function exposureOf(
  tx: Transaction,
  partyId: string,
  manual: ManualFigures,
  excludeOrderId: string | null = null,
): Promise<Exposure> {
  const waivedUntil = manual.overdueWaivedUntil ?? null;
  if ((await billingLiveOn(tx)) === null) {
    return {
      source: 'manual',
      exposurePaise: manual.manualExposurePaise,
      overdueDays: manual.overdueDays,
      breakdown: null,
      overdueWaived: waivedUntil !== null && (await notBefore(tx, waivedUntil)),
    };
  }
  const result = await tx.execute<{
    balance: string;
    advance: string;
    open_orders: string;
    overdue_days: number;
    waived: boolean;
  }>(sql`
    select
      coalesce((select b.balance_paise from party_balances b where b.party_id = ${partyId}), 0) as balance,
      coalesce((select b.advance_paise from party_balances b where b.party_id = ${partyId}), 0) as advance,
      ${openOrdersOf(partyId, excludeOrderId, null)} as open_orders,
      coalesce(greatest(0, ${indiaToday} - (
        select min(owed.due) from (
          select o.due_on as due from (${openDocumentsOf(partyId)}) o where o.outstanding > 0
          union all
          select ${manual.openingOverdueSince}::date
          where exists (
            select 1 from party_ledger pl
            where pl.party_id = ${partyId} and pl.entry_type = 'opening'
              and pl.amount_paise > coalesce((select sum(a.amount_paise) from allocations a where a.party_ledger_id = pl.id), 0)
          )
        ) owed
      )), 0)::int as overdue_days,
      coalesce(${waivedUntil}::date >= ${indiaToday}, false) as waived
  `);
  const [row] = result.rows as [
    {
      balance: string;
      advance: string;
      open_orders: string;
      overdue_days: number;
      waived: boolean;
    },
  ];
  const breakdown = {
    balancePaise: Number(row.balance),
    openOrdersPaise: Number(row.open_orders),
    advancePaise: Number(row.advance),
  };
  return {
    source: 'ledger',
    exposurePaise: breakdown.balancePaise + breakdown.openOrdersPaise,
    overdueDays: row.overdue_days,
    breakdown,
    overdueWaived: row.waived,
  };
}

/** Whether `day` is today or later in India. */
async function notBefore(tx: Transaction, day: string): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(sql`select ${day}::date >= ${indiaToday} as ok`);
  return (result.rows[0] as { ok: boolean }).ok;
}

/** The position checkCredit takes, from a profile (or none) and its exposure. */
export function positionOf(
  profile: { status: ProfileRow['status']; limitPaise: number },
  exposure: Exposure,
): CreditPosition {
  return {
    status: profile.status,
    limitPaise: profile.limitPaise,
    exposurePaise: exposure.exposurePaise,
    overdueDays: exposure.overdueDays,
    overdueWaived: exposure.overdueWaived,
  };
}

/** What a site owes (MVP 3 spec §3.3): its open documents and open postpaid orders. */
export interface SiteExposure {
  readonly outstandingPaise: number;
  readonly openOrdersPaise: number;
  readonly exposurePaise: number;
}

export async function siteExposureOf(
  tx: Transaction,
  partyId: string,
  projectId: string,
  excludeOrderId: string | null = null,
): Promise<SiteExposure> {
  const result = await tx.execute<{ outstanding: string; open_orders: string }>(sql`
    select
      coalesce((select sum(o.outstanding) from (${openDocumentsOf(partyId, projectId)}) o where o.outstanding > 0), 0) as outstanding,
      ${openOrdersOf(partyId, excludeOrderId, projectId)} as open_orders
  `);
  const [row] = result.rows as [{ outstanding: string; open_orders: string }];
  const outstandingPaise = Number(row.outstanding);
  const openOrdersPaise = Number(row.open_orders);
  return { outstandingPaise, openOrdersPaise, exposurePaise: outstandingPaise + openOrdersPaise };
}

/** Where a party stands, with its current check (no sale), as the 360 and credit screens show it. */
export type CreditSummary = PartyCreditSummary;

const siteHolders = alias(schema.organizationMembers, 'site_holder');
const siteHolderUsers = alias(schema.users, 'site_holder_user');

/** Site accounts with their figures: one party's, or one by id (MVP 3 spec §3.3). */
export async function siteAccountsOf(
  tx: Transaction,
  where: { partyId: string } | { id: string },
): Promise<SiteAccountView[]> {
  const rows = await tx
    .select({
      site: siteCreditAccounts,
      partyName: parties.displayName,
      project: { id: projects.id, number: projects.number, name: projects.name },
      holderName: siteHolderUsers.fullName,
    })
    .from(siteCreditAccounts)
    .innerJoin(parties, eq(parties.id, siteCreditAccounts.partyId))
    .innerJoin(projects, eq(projects.id, siteCreditAccounts.projectId))
    .leftJoin(siteHolders, eq(siteHolders.id, siteCreditAccounts.heldByMemberId))
    .leftJoin(siteHolderUsers, eq(siteHolderUsers.id, siteHolders.userId))
    .where(
      'id' in where
        ? eq(siteCreditAccounts.id, where.id)
        : eq(siteCreditAccounts.partyId, where.partyId),
    )
    .orderBy(asc(projects.name), asc(siteCreditAccounts.id));
  const views: SiteAccountView[] = [];
  for (const { site, partyName, project, holderName } of rows) {
    const exposure = await siteExposureOf(tx, site.partyId, site.projectId);
    const available = site.limitPaise - exposure.exposurePaise;
    views.push({
      id: site.id,
      party: { id: site.partyId, name: partyName },
      project,
      limitPaise: site.limitPaise,
      status: site.status,
      hold:
        site.holdReason === null
          ? null
          : {
              reason: site.holdReason,
              at: String(site.heldAt?.toISOString()),
              by: { memberId: String(site.heldByMemberId), name: String(holderName) },
            },
      notes: site.notes,
      outstandingPaise: exposure.outstandingPaise,
      openOrdersPaise: exposure.openOrdersPaise,
      exposurePaise: exposure.exposurePaise,
      availablePaise: available,
      utilizationPercent: Math.round((exposure.exposurePaise * 10_000) / site.limitPaise) / 100,
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    });
  }
  return views;
}

/** A party without a profile: no credit. */
export const NO_CREDIT = {
  status: 'none',
  limitPaise: 0,
  creditDays: 0,
  risk: 'low',
  manualExposurePaise: 0,
  overdueDays: 0,
  openingOverdueSince: null,
  holdKind: null,
  overdueWaivedUntil: null,
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
    exposure: exposure.breakdown,
    overdueDays: exposure.overdueDays,
    holdKind: profile.holdKind,
    overdueWaivedUntil: profile.overdueWaivedUntil,
    check: checkCredit(await creditRulesOf(tx, organizationId), positionOf(profile, exposure)),
    pendingRequest: pending ?? null,
    pendingRelease: await pendingReleaseOf(tx, partyId),
    sites: await siteAccountsOf(tx, { partyId }),
  };
}

/** A release of the party's hold waiting for approval. */
async function pendingReleaseOf(
  tx: Transaction,
  partyId: string,
): Promise<CreditApprovalSummary | null> {
  const result = await tx.execute<{
    id: string;
    number: string;
    created_at: string;
    member_id: string;
    name: string;
  }>(sql`
    select a.id, a.number, a.created_at, a.requested_by_member_id as member_id, u.full_name as name
    from ${creditApprovals} a
    join organization_members m on m.id = a.requested_by_member_id
    join users u on u.id = m.user_id
    where a.party_id = ${partyId} and a.kind = 'release' and a.status = 'pending'`);
  const [row] = result.rows;
  return row
    ? {
        id: row.id,
        number: row.number,
        status: 'pending',
        level: null,
        requestedBy: { memberId: row.member_id, name: row.name },
        createdAt: new Date(row.created_at).toISOString(),
      }
    : null;
}

/** Business-wide parties, and those of the member's stores. */
export function visibleParties(access: MemberAccess): SQL | undefined {
  return access.allStores
    ? undefined
    : or(isNull(parties.homeStoreId), inArray(parties.homeStoreId, [...access.storeIds]));
}
