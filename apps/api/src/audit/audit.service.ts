import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { formatINR } from '@paint/shared';
import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { AUDIT_AREAS, type AuditTable, type ListAuditQuery } from './audit.schemas.js';

const {
  auditLog,
  brands,
  categories,
  organizationMembers,
  parties,
  productVariants,
  products,
  roles,
  stockLedger,
  stores,
  taxCategories,
  users,
} = schema;

export interface AuditChange {
  readonly field: string;
  readonly label: string;
  readonly old: unknown;
  readonly new: unknown;
  /** Ready to show, e.g. "₹600.00", "Yes", a role or store name. */
  readonly oldText: string | null;
  readonly newText: string | null;
}

export interface AuditEntry {
  readonly id: number;
  readonly occurredAt: string;
  /** Null for system work, such as setting up a new business. */
  readonly actor: { readonly memberId: string; readonly name: string } | null;
  readonly area: string;
  readonly table: string;
  readonly recordId: string;
  /** What the record is, e.g. a SKU, a role or a member's name. */
  readonly recordLabel: string | null;
  readonly action: 'insert' | 'update' | 'delete';
  readonly changes: AuditChange[];
}

export interface AuditPage {
  readonly items: AuditEntry[];
  readonly total: number;
}

const FIELD_LABELS: Record<string, string> = {
  mrp_paise: 'MRP',
  selling_price_paise: 'Selling price',
  label: 'Label',
  key: 'Key',
  name: 'Name',
  permission: 'Permission',
  granted: 'Granted (or denied)',
  role_id: 'Role',
  all_stores: 'All stores',
  is_active: 'Active',
  two_factor_reset_at: 'Two-factor reset',
  store_id: 'Store',
  variant_id: 'Product',
  movement_type: 'Type',
  quantity: 'Quantity',
  note: 'Note',
  plan: 'Plan',
  feature_flags: 'Features',
  suspended_at: 'Suspended',
  suspend_reason: 'Suspension reason',
  two_factor_required: 'Two-factor required',
  reason: 'Reason',
  minutes: 'Minutes',
  approved_at: 'Approved',
  declined_at: 'Declined',
  expires_at: 'Expires',
  ended_at: 'Ended',
  status: 'Status',
  start_date: 'Start date',
  end_date: 'End date',
  renewal_date: 'Renewal date',
  value_paise: 'Value',
  termination_reason: 'Termination reason',
  limit_paise: 'Credit limit',
  credit_days: 'Credit days',
  hold_reason: 'Hold reason',
  normal_up_to_percent: 'Normal up to (%)',
  manager_up_to_percent: 'Manager approval up to (%)',
  hold_after_overdue_days: 'Hold after overdue (days)',
  earn_points: 'Points earned',
  earn_per_paise: 'For every',
  tiers: 'Tiers',
  expiry_days: 'Points expire after (days)',
  min_redemption_points: 'Minimum redemption',
  points: 'Points',
  branding: 'Branding',
  merged_into_id: 'Merged into',
  parent_id: 'Parent category',
  brand_id: 'Brand',
  category_id: 'Category',
  slug: 'Sign-in link',
  sha256: 'Logo file (SHA-256)',
  content_type: 'File type',
  width: 'Width (px)',
  height: 'Height (px)',
  tax_category_id: 'Tax category',
  hsn_code: 'HSN code',
  rate_bps: 'GST rate (basis points)',
  effective_from: 'From',
  effective_to: 'To',
  is_default: 'Default',
  gst_registration_type: 'Registration type',
  gst_state_code: 'State code',
  gstin: 'GSTIN',
  legal_name: 'Legal name',
  trade_name: 'Trade name',
  address_line: 'Address',
  city: 'City',
  pincode: 'PIN code',
  number: 'Number',
  cancel_reason: 'Cancellation reason',
  irn: 'IRN',
  ack_no: 'Acknowledgement number',
  aato_band: 'Turnover band',
  einvoice_required_from: 'E-invoice from',
  eway_threshold_paise: 'E-way bill threshold (paise)',
  stock_post_on: 'Stock out on',
  walk_in_party_id: 'Walk-in customer',
  quote_validity_days: 'Quotation validity (days)',
  partial_min_advance_pct: 'Minimum advance (%)',
  default_price_mode: 'Prices',
  billing_live_on: 'Billing from',
  kind: 'Document',
  prefix: 'Prefix',
  digits: 'Digits',
  cash_needs_register: 'Cash needs an open register',
  register_variance_alert_paise: 'Register variance alert (paise)',
  // The bank account invoices print: a change is a classic fraud route, so it is audited in full.
  bank_name: 'Invoice bank',
  bank_account_name: 'Invoice bank account name',
  bank_account_number: 'Invoice bank account number',
  bank_ifsc: 'Invoice bank IFSC',
  upi_id: 'Invoice UPI ID',
  invoice_terms: 'Invoice terms',
  purpose: 'For',
  nature: 'Tax nature',
  supply_type: 'Supply',
  mode_kind: 'Payment mode kind',
  mode_id: 'Payment mode',
  party_id: 'Party',
  tally_ledger_name: 'Tally ledger',
  tally_group: 'Tally group',
  position: 'Order',
  register_code: 'Register',
  opening_float_paise: 'Opening float (paise)',
  expected_cash_paise: 'Expected cash (paise)',
  counted_cash_paise: 'Counted cash (paise)',
  variance_paise: 'Variance (paise)',
  cheque_status: 'Cheque',
  bounce_reason: 'Bounce reason',
  period_from: 'From',
  period_to: 'To',
  kinds: 'Vouchers',
  format: 'Format',
  billing_interval: 'Billed',
  store_quantity: 'Stores billed',
  trial_ends_at: 'Trial ends',
  current_period_end: 'Paid until',
  cancel_at_period_end: 'Ends with the period',
  past_due_since: 'Payment overdue since',
  gateway: 'Collected by',
  invoice_id: 'Invoice',
  amount_paise: 'Amount (paise)',
  paid_on: 'Paid on',
  mode: 'Paid by',
  reference: 'Reference',
  recorded_by_user_id: 'Recorded by (platform)',
  decided_by_user_id: 'Decided by (platform)',
};

// Every named table's records are keyed by a uuid: comparing uuids (not id::text) lets each
// lookup use the primary key instead of scanning the table, e.g. the whole stock ledger.
const recordUuid = sql`${auditLog.recordId}::uuid`;

const recordLabel = sql<string | null>`case ${auditLog.tableName}
  when 'product_variants' then (select ${productVariants.sku} from ${productVariants} where ${productVariants.id} = ${recordUuid})
  when 'products' then (select ${products.name} from ${products} where ${products.id} = ${recordUuid})
  when 'brands' then (select ${brands.name} from ${brands} where ${brands.id} = ${recordUuid})
  when 'categories' then (select ${categories.name} from ${categories} where ${categories.id} = ${recordUuid})
  when 'stock_ledger' then (select ${productVariants.sku} from ${stockLedger} join ${productVariants} on ${productVariants.id} = ${stockLedger.variantId} where ${stockLedger.id} = ${recordUuid})
  when 'roles' then (select ${roles.name} from ${roles} where ${roles.id} = ${recordUuid})
  when 'role_permissions' then (select ${roles.name} from ${roles} where ${roles.id} = ${recordUuid})
  when 'organizations' then (select o.name from organizations o where o.id = ${recordUuid})
  when 'support_grants' then (select g.reason from support_grants g where g.id = ${recordUuid})
  when 'contracts' then (select c.number || ' · ' || c.title from contracts c where c.id = ${recordUuid})
  when 'credit_profiles' then (select p.display_name from credit_profiles cp join parties p on p.id = cp.party_id where cp.id = ${recordUuid})
  when 'credit_rules' then 'Credit rules'
  when 'loyalty_settings' then 'Loyalty programme'
  when 'organization_branding' then 'Branding'
  when 'organization_logos' then 'Logo'
  when 'parties' then (select p.display_name from parties p where p.id = ${recordUuid})
  when 'loyalty_accounts' then (select p.display_name from loyalty_accounts la join parties p on p.id = la.party_id where la.id = ${recordUuid})
  when 'tax_categories' then (select tc.name from tax_categories tc where tc.id = ${recordUuid})
  when 'tax_rates' then (select tc.name from tax_rates tr join tax_categories tc on tc.id = tr.tax_category_id where tr.id = ${recordUuid})
  when 'stores' then (select s.code || ' · ' || s.name from stores s where s.id = ${recordUuid})
  when 'gstin_profiles' then (select gp.gstin from gstin_profiles gp where gp.id = ${recordUuid})
  when 'sales_settings' then 'Sales settings'
  when 'document_series' then (select s.code || ' · ' || ds.prefix from document_series ds join stores s on s.id = ds.store_id where ds.id = ${recordUuid})
  when 'tax_documents' then (select coalesce(td.number, 'Draft') from tax_documents td where td.id = ${recordUuid})
  when 'payment_modes' then (select pm.name from payment_modes pm where pm.id = ${recordUuid})
  when 'subscriptions' then 'Subscription'
  when 'subscription_payments' then (select i.number from subscription_payments sp join subscription_invoices i on i.id = sp.invoice_id where sp.id = ${recordUuid})
  when 'subscription_plan_requests' then 'Plan request'
  when 'ledger_mappings' then (select lm.tally_ledger_name from ledger_mappings lm where lm.id = ${recordUuid})
  when 'register_sessions' then (select s.code || ' · ' || rs.register_code from register_sessions rs join stores s on s.id = rs.store_id where rs.id = ${recordUuid})
  when 'payments' then (select p.number from payments p where p.id = ${recordUuid})
  when 'accounting_exports' then (select ae.period_from::text || ' – ' || ae.period_to::text from accounting_exports ae where ae.id = ${recordUuid})
  when 'loyalty_ledger' then (select p.display_name from loyalty_accounts la join parties p on p.id = la.party_id where la.id = ${recordUuid})
  else (select ${users.fullName} from ${organizationMembers} join ${users} on ${users.id} = ${organizationMembers.userId} where ${organizationMembers.id}::text = ${auditLog.recordId})
end`;

/** The read-only audit log viewer (roadmap P1-M20). */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  list(auth: AuthContext, query: ListAuditQuery): Promise<AuditPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        query.table ? eq(auditLog.tableName, query.table) : undefined,
        query.recordId ? eq(auditLog.recordId, query.recordId) : undefined,
        query.actorMemberId ? eq(auditLog.actorMemberId, query.actorMemberId) : undefined,
        query.from ? gte(auditLog.occurredAt, query.from) : undefined,
        // Stored times have microseconds; ours have milliseconds. Include the whole
        // millisecond, so a time copied from an entry finds that entry.
        query.to
          ? lt(
              auditLog.occurredAt,
              sql`${query.to.toISOString()}::timestamptz + interval '1 millisecond'`,
            )
          : undefined,
      );
      const rows = await tx
        .select({ entry: auditLog, actorName: users.fullName, recordLabel })
        .from(auditLog)
        .leftJoin(organizationMembers, eq(organizationMembers.id, auditLog.actorMemberId))
        .leftJoin(users, eq(users.id, organizationMembers.userId))
        .where(where)
        .orderBy(desc(auditLog.id))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(auditLog).where(where);
      const names = await this.names(
        tx,
        rows.map(({ entry }) => entry),
      );
      return {
        items: rows.map(({ entry, actorName, recordLabel: label }) => {
          const before = (entry.oldValues ?? {}) as Record<string, unknown>;
          const after = (entry.newValues ?? {}) as Record<string, unknown>;
          // jsonb does not keep key order, so list fields in a fixed, meaningful order.
          const fields = Object.keys(FIELD_LABELS).filter(
            (field) => field in before || field in after,
          );
          return {
            id: entry.id,
            occurredAt: entry.occurredAt.toISOString(),
            actor: entry.actorMemberId
              ? { memberId: entry.actorMemberId, name: String(actorName) }
              : null,
            area: AUDIT_AREAS[entry.tableName as AuditTable],
            table: entry.tableName,
            recordId: entry.recordId,
            recordLabel: label,
            action: entry.action,
            changes: fields.map((field) => ({
              field,
              label: String(FIELD_LABELS[field]),
              old: before[field] ?? null,
              new: after[field] ?? null,
              oldText: describe(field, before[field], names),
              newText: describe(field, after[field], names),
            })),
          };
        }),
        total: Number(totals?.total),
      };
    });
  }

  /** Names for the role, store and product ids that appear in the entries. */
  private async names(
    tx: Transaction,
    entries: { oldValues: unknown; newValues: unknown }[],
  ): Promise<Map<string, string>> {
    const ids = (field: string) =>
      entries.flatMap(({ oldValues, newValues }) =>
        [oldValues, newValues].flatMap((values) => {
          const value = (values ?? {}) as Record<string, unknown>;
          return typeof value[field] === 'string' ? [value[field]] : [];
        }),
      );
    const found = [
      ...(await tx
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(inArray(roles.id, ids('role_id')))),
      ...(await tx
        .select({ id: stores.id, name: stores.code })
        .from(stores)
        .where(inArray(stores.id, ids('store_id')))),
      ...(await tx
        .select({ id: productVariants.id, name: productVariants.sku })
        .from(productVariants)
        .where(inArray(productVariants.id, ids('variant_id')))),
      ...(await tx
        .select({ id: parties.id, name: parties.displayName })
        .from(parties)
        .where(inArray(parties.id, ids('merged_into_id')))),
      ...(await tx
        .select({ id: brands.id, name: brands.name })
        .from(brands)
        .where(inArray(brands.id, ids('brand_id')))),
      ...(await tx
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(inArray(categories.id, [...ids('category_id'), ...ids('parent_id')]))),
      ...(await tx
        .select({ id: taxCategories.id, name: taxCategories.name })
        .from(taxCategories)
        .where(inArray(taxCategories.id, ids('tax_category_id')))),
    ];
    return new Map(found.map(({ id, name }) => [id, name]));
  }
}

/** A value as people read it: rupees for prices, Yes/No, names for ids. */
function describe(field: string, value: unknown, names: Map<string, string>): string | null {
  if (value === undefined || value === null) return null;
  if (field.endsWith('_paise')) return formatINR(Number(value));
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // Lists of text, such as invoice terms, read one after another.
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(' · ');
  }
  // Numbers such as quantities come through as JSON numbers.
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return names.get(text) ?? text;
}
