import { z } from 'zod';

/** The audited tables, by the area of the product they belong to. */
export const AUDIT_AREAS = {
  product_variants: 'Product prices and pack sizes',
  products: 'Products',
  brands: 'Brands',
  categories: 'Categories',
  roles: 'Roles',
  role_permissions: 'Role permissions',
  organization_members: 'Member access',
  member_stores: 'Member stores',
  stock_ledger: 'Stock adjustments',
  organizations: 'Plan and account',
  support_grants: 'Support access',
  contracts: 'Contracts',
  credit_profiles: 'Credit',
  credit_rules: 'Credit rules',
  loyalty_settings: 'Loyalty programme',
  loyalty_accounts: 'Loyalty accounts',
  loyalty_ledger: 'Loyalty adjustments',
  organization_branding: 'Branding',
  organization_logos: 'Logo',
  parties: 'Party merges',
  tax_categories: 'Tax categories',
  tax_rates: 'Tax rates',
  stores: 'GST registrations',
  gstin_profiles: 'GSTIN profiles',
  sales_settings: 'Sales settings',
  document_series: 'Document series',
  tax_documents: 'Invoices',
} as const;
export type AuditTable = keyof typeof AUDIT_AREAS;

const moment = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const listAuditSchema = z.object({
  table: z.enum(Object.keys(AUDIT_AREAS) as [AuditTable, ...AuditTable[]]).optional(),
  recordId: z.string().trim().min(1).max(64).optional(),
  actorMemberId: z.uuid().optional(),
  from: moment.optional(),
  to: moment.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAuditQuery = z.output<typeof listAuditSchema>;
