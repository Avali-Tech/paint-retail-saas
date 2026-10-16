import { schema, type Transaction } from '@paint/db';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { INFLUENCER_ROLES } from '../billing/sale-parties.js';
import { storeScope } from '../leads/crm-lookups.js';
import { dateFilter, reportFilters, storeFilter } from './report-filters.js';
import type { ReportKind } from './report-kinds.js';
import { rupees, text } from './report-values.js';

// Sales by influencer and by site (spec §6.4): issued invoices, bills of supply and
// debit notes, minus credit notes (which carry the invoice's influencer and site).

const { parties, partyRoles, projects, taxDocuments } = schema;

const influencers = alias(parties, 'influencer');
const customers = alias(parties, 'site_customer');

interface SalesFilters {
  storeId?: string;
  from?: string;
  to?: string;
}

const SALE_KINDS = ['invoice', 'bill_of_supply', 'debit_note', 'credit_note'] as const;

/** +1 for a sale, −1 for a credit note. */
const sign = sql`(case when ${taxDocuments.kind} = 'credit_note' then -1 else 1 end)`;

const totals = {
  invoices: sql<number>`(count(*) filter (where ${taxDocuments.kind} <> 'credit_note'))::int`,
  creditNotes: sql<number>`(count(*) filter (where ${taxDocuments.kind} = 'credit_note'))::int`,
  lastBilled: sql<string>`max(${taxDocuments.issuedOn})::text`,
  taxable: sql<string>`sum(${sign} * ${taxDocuments.taxablePaise})`,
  total: sql<string>`sum(${sign} * ${taxDocuments.totalPaise})`,
};

const totalColumns = [
  { key: 'invoices', header: 'Bills' },
  { key: 'creditNotes', header: 'Credit notes' },
  { key: 'lastBilled', header: 'Last billed' },
  { key: 'taxable', header: 'Taxable value (₹)' },
  { key: 'total', header: 'Net sales (₹)' },
] as const;

const totalCells = (r: Record<string, unknown>) => ({
  invoices: Number(r.invoices),
  creditNotes: Number(r.creditNotes),
  lastBilled: text(r.lastBilled),
  taxable: rupees(r.taxable),
  total: rupees(r.total),
});

/** Issued sale documents of the member's stores, by issue date (an India-time day). */
function issuedSales(auth: AuthContext, filters: SalesFilters): SQL | undefined {
  return and(
    eq(taxDocuments.status, 'issued'),
    inArray(taxDocuments.kind, [...SALE_KINDS]),
    storeScope(auth, taxDocuments.storeId, filters.storeId),
    filters.from ? gte(taxDocuments.issuedOn, filters.from) : undefined,
    filters.to ? lte(taxDocuments.issuedOn, filters.to) : undefined,
  );
}

const salesFilters = reportFilters({ storeId: storeFilter, from: dateFilter, to: dateFilter });

/** One row per influencer and site: what the painter, contractor or architect brought in. */
export const salesByInfluencer: ReportKind<SalesFilters> = {
  kind: 'sales-by-influencer',
  title: 'Sales by influencer',
  permission: 'sales:read',
  columns: [
    { key: 'influencer', header: 'Influencer' },
    { key: 'roles', header: 'Role' },
    { key: 'phone', header: 'Mobile' },
    { key: 'site', header: 'Site' },
    { key: 'customers', header: 'Billed to' },
    ...totalColumns,
    { key: 'points', header: 'Painter points' },
  ],
  ...salesFilters,
  query: (tx: Transaction, auth, filters) =>
    tx
      .select({
        influencer: influencers.displayName,
        roles: sql<
          string | null
        >`(select string_agg(${partyRoles.role}::text, ', ' order by ${partyRoles.role}) from ${partyRoles} where ${partyRoles.partyId} = ${influencers.id} and ${partyRoles.role}::text = any(${`{${INFLUENCER_ROLES.join(',')}}`}::text[]))`,
        phone: influencers.phone,
        site: sql<string | null>`${projects.number} || ' ' || ${projects.name}`,
        customers: sql<
          string | null
        >`string_agg(distinct ${taxDocuments.buyerName}, ', ' order by ${taxDocuments.buyerName})`,
        ...totals,
        // Painter points (P2-M36) the bills earned the influencer, less what the notes took back.
        points: sql<string>`coalesce(sum((select sum(l.points) from loyalty_ledger l join loyalty_accounts a on a.id = l.account_id where l.tax_document_id = ${taxDocuments.id} and a.party_id = ${influencers.id} and l.kind in ('influencer', 'adjust'))), 0)`,
      })
      .from(taxDocuments)
      .innerJoin(influencers, eq(influencers.id, taxDocuments.influencerPartyId))
      .leftJoin(projects, eq(projects.id, taxDocuments.projectId))
      .where(issuedSales(auth, filters))
      .groupBy(influencers.id, projects.id)
      .orderBy(desc(totals.total), asc(influencers.displayName), asc(projects.number))
      .$dynamic(),
  toRow: (r) => ({
    influencer: text(r.influencer),
    roles: text(r.roles),
    phone: text(r.phone),
    site: text(r.site),
    customers: text(r.customers),
    ...totalCells(r),
    points: Number(r.points),
  }),
};

/** One row per site (project): its sales, and who brought them in. */
export const salesBySite: ReportKind<SalesFilters> = {
  kind: 'sales-by-site',
  title: 'Sales by site',
  permission: 'sales:read',
  columns: [
    { key: 'number', header: 'Project' },
    { key: 'site', header: 'Site' },
    { key: 'customer', header: 'Customer' },
    { key: 'city', header: 'City' },
    { key: 'influencers', header: 'Influencers' },
    ...totalColumns,
  ],
  ...salesFilters,
  query: (tx: Transaction, auth, filters) =>
    tx
      .select({
        number: projects.number,
        site: projects.name,
        customer: customers.displayName,
        city: projects.city,
        influencers: sql<
          string | null
        >`string_agg(distinct ${influencers.displayName}, ', ' order by ${influencers.displayName})`,
        ...totals,
      })
      .from(taxDocuments)
      .innerJoin(projects, eq(projects.id, taxDocuments.projectId))
      .innerJoin(customers, eq(customers.id, projects.customerPartyId))
      .leftJoin(influencers, eq(influencers.id, taxDocuments.influencerPartyId))
      .where(issuedSales(auth, filters))
      .groupBy(projects.id, customers.id)
      .orderBy(desc(totals.total), asc(projects.number))
      .$dynamic(),
  toRow: (r) => ({
    number: text(r.number),
    site: text(r.site),
    customer: text(r.customer),
    city: text(r.city),
    influencers: text(r.influencers),
    ...totalCells(r),
  }),
};
