import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { canAccessStore, type Permission } from '@paint/shared';
import { and, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';

const {
  accountingExports,
  contracts,
  goodsReceipts,
  leads,
  opportunities,
  parties,
  payments,
  products,
  projects,
  purchaseOrders,
  registerSessions,
  stockCounts,
  stores,
  taxDocuments,
  transfers,
} = schema;

export const RECORD_TYPES = schema.documentRecordType.enumValues;
export type RecordType = (typeof RECORD_TYPES)[number];

interface RecordRule {
  readonly read: Permission;
  readonly manage: Permission;
  readonly table: PgTable;
  readonly id: PgColumn;
  /**
   * The columns naming the stores the record belongs to; members see it if
   * they work at any of them. None: the record is business-wide.
   */
  readonly stores: readonly PgColumn[];
  /** The store column whose null means business-wide, e.g. a party without a home store. */
  readonly businessWideIfNull?: PgColumn;
  /** How people name the record, e.g. "LD-000004 · Kondapur tower". */
  readonly label: SQL;
}

/** Who may see and change each kind of record — and so what is attached to it. */
const RULES: Record<RecordType, RecordRule> = {
  party: {
    read: 'parties:read',
    manage: 'parties:manage',
    table: parties,
    id: parties.id,
    stores: [parties.homeStoreId],
    businessWideIfNull: parties.homeStoreId,
    label: sql`${parties.displayName}`,
  },
  product: {
    read: 'catalog:read',
    manage: 'catalog:manage',
    table: products,
    id: products.id,
    stores: [],
    label: sql`${products.name}`,
  },
  store: {
    read: 'stores:read',
    manage: 'stores:manage',
    table: stores,
    id: stores.id,
    stores: [stores.id],
    label: sql`${stores.code} || ' · ' || ${stores.name}`,
  },
  purchase_order: {
    read: 'purchasing:read',
    manage: 'purchasing:manage',
    table: purchaseOrders,
    id: purchaseOrders.id,
    stores: [purchaseOrders.storeId],
    label: sql`${purchaseOrders.number}`,
  },
  goods_receipt: {
    read: 'purchasing:read',
    manage: 'purchasing:manage',
    table: goodsReceipts,
    id: goodsReceipts.id,
    stores: [goodsReceipts.storeId],
    label: sql`${goodsReceipts.number}`,
  },
  transfer: {
    read: 'inventory:read',
    manage: 'inventory:manage',
    table: transfers,
    id: transfers.id,
    stores: [transfers.fromStoreId, transfers.toStoreId],
    label: sql`${transfers.number}`,
  },
  lead: {
    read: 'leads:read',
    manage: 'leads:manage',
    table: leads,
    id: leads.id,
    stores: [leads.storeId],
    label: sql`${leads.number} || ' · ' || ${leads.title}`,
  },
  opportunity: {
    read: 'leads:read',
    manage: 'leads:manage',
    table: opportunities,
    id: opportunities.id,
    stores: [opportunities.storeId],
    label: sql`${opportunities.number} || ' · ' || ${opportunities.title}`,
  },
  project: {
    read: 'projects:read',
    manage: 'projects:manage',
    table: projects,
    id: projects.id,
    stores: [projects.storeId],
    label: sql`${projects.number} || ' · ' || ${projects.name}`,
  },
  contract: {
    read: 'contracts:read',
    manage: 'contracts:manage',
    table: contracts,
    id: contracts.id,
    stores: [contracts.storeId],
    businessWideIfNull: contracts.storeId,
    label: sql`${contracts.number} || ' · ' || ${contracts.title}`,
  },
  stock_count: {
    read: 'inventory:read',
    manage: 'inventory:manage',
    table: stockCounts,
    id: stockCounts.id,
    stores: [stockCounts.storeId],
    label: sql`${stockCounts.number}`,
  },
  tax_document: {
    read: 'sales:read',
    manage: 'billing:issue',
    table: taxDocuments,
    id: taxDocuments.id,
    stores: [taxDocuments.storeId],
    label: sql`coalesce(${taxDocuments.number}, 'Draft')`,
  },
  payment: {
    read: 'sales:read',
    manage: 'payments:manage',
    table: payments,
    id: payments.id,
    stores: [payments.storeId],
    label: sql`${payments.number}`,
  },
  register_session: {
    read: 'register:manage',
    manage: 'register:manage',
    table: registerSessions,
    id: registerSessions.id,
    stores: [registerSessions.storeId],
    label: sql`${registerSessions.registerCode}`,
  },
  accounting_export: {
    read: 'accounting:export',
    manage: 'accounting:export',
    table: accountingExports,
    id: accountingExports.id,
    stores: [],
    label: sql`${accountingExports.periodFrom}::text || ' – ' || ${accountingExports.periodTo}::text`,
  },
};

/**
 * The stores the record belongs to (empty = the whole business), or null if
 * there is no such record.
 */
async function recordStores(
  tx: Transaction,
  rule: RecordRule,
  recordId: string,
): Promise<string[] | null> {
  const columns = Object.fromEntries(
    rule.stores.map((column, index) => [`s${String(index)}`, column]),
  );
  const [row] = await tx
    .select({ found: sql<number>`1`, ...columns })
    .from(rule.table)
    .where(eq(rule.id, recordId));
  if (!row) return null;
  return (Object.values(row) as unknown[]).filter(
    (value): value is string => typeof value === 'string',
  );
}

/**
 * Checks the member may see (`read`) or change (`manage`) the record and what is
 * attached to it, and returns the stores it belongs to (empty = business-wide):
 * 403 without the record's permission, 404 if the record does not exist or
 * belongs to stores they do not work at.
 */
export async function requireRecordAccess(
  tx: Transaction,
  auth: AuthContext,
  recordType: RecordType,
  recordId: string,
  need: 'read' | 'manage',
  /** What is being checked, for the message. */
  what = 'documents',
): Promise<string[]> {
  const rule = RULES[recordType];
  if (!auth.permissions.has(rule[need])) {
    throw new ForbiddenException(
      need === 'read'
        ? `You cannot see ${what} on this record`
        : `You cannot change ${what} on this record`,
    );
  }
  const storeIds = await recordStores(tx, rule, recordId);
  if (!storeIds || (storeIds.length > 0 && !storeIds.some((id) => canAccessStore(auth, id)))) {
    throw new NotFoundException('Record not found');
  }
  return storeIds;
}

/**
 * For lists across records (every document or activity the member may see): a
 * condition on a row's record type and id that holds exactly when
 * requireRecordAccess(…, 'read') would let the member see that record.
 */
export function visibleRecords(
  auth: AuthContext,
  recordTypeColumn: AnyColumn,
  recordIdColumn: AnyColumn,
  /** The kinds of record the rows can be about. */
  types: readonly RecordType[],
): SQL {
  const ids = [...auth.storeIds];
  const branches = types
    .filter((type) => auth.permissions.has(RULES[type].read))
    .map((type) => {
      const rule = RULES[type];
      const atMyStores =
        auth.allStores || rule.stores.length === 0
          ? undefined
          : or(
              ...rule.stores.map((column) => inArray(column, ids)),
              rule.businessWideIfNull && isNull(rule.businessWideIfNull),
            );
      return sql`(${recordTypeColumn} = ${type} and exists (select 1 from ${rule.table} where ${and(eq(rule.id, recordIdColumn), atMyStores)}))`;
    });
  return branches.length === 0 ? sql`false` : sql`(${sql.join(branches, sql` or `)})`;
}

/** The name of the record a row is about, e.g. "PO-000012" or "LD-000004 · Kondapur tower". */
export function recordLabel(
  recordTypeColumn: AnyColumn,
  recordIdColumn: AnyColumn,
  types: readonly RecordType[],
): SQL<string> {
  const cases = types.map((type) => {
    const rule = RULES[type];
    return sql`when ${type} then (select ${rule.label} from ${rule.table} where ${eq(rule.id, recordIdColumn)})`;
  });
  return sql<string>`(case ${recordTypeColumn}::text ${sql.join(cases, sql` `)} end)`;
}

/** The permissions that let someone see and change a kind of record. */
export function recordPermissions(recordType: RecordType): {
  read: Permission;
  manage: Permission;
} {
  const { read, manage } = RULES[recordType];
  return { read, manage };
}
