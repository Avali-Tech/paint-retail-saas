import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { formatINR } from '@paint/shared';
import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { AUDIT_AREAS, type AuditTable, type ListAuditQuery } from './audit.schemas.js';

const { auditLog, organizationMembers, productVariants, roles, stockLedger, stores, users } =
  schema;

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
  key: 'Key',
  name: 'Name',
  permission: 'Permission',
  role_id: 'Role',
  all_stores: 'All stores',
  is_active: 'Active',
  store_id: 'Store',
  variant_id: 'Product',
  movement_type: 'Type',
  quantity: 'Quantity',
  note: 'Note',
  plan: 'Plan',
  feature_flags: 'Features',
  suspended_at: 'Suspended',
  suspend_reason: 'Suspension reason',
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
};

const recordLabel = sql<string | null>`case ${auditLog.tableName}
  when 'product_variants' then (select ${productVariants.sku} from ${productVariants} where ${productVariants.id}::text = ${auditLog.recordId})
  when 'stock_ledger' then (select ${productVariants.sku} from ${stockLedger} join ${productVariants} on ${productVariants.id} = ${stockLedger.variantId} where ${stockLedger.id}::text = ${auditLog.recordId})
  when 'roles' then (select ${roles.name} from ${roles} where ${roles.id}::text = ${auditLog.recordId})
  when 'role_permissions' then (select ${roles.name} from ${roles} where ${roles.id}::text = ${auditLog.recordId})
  when 'organizations' then (select o.name from organizations o where o.id::text = ${auditLog.recordId})
  when 'support_grants' then (select g.reason from support_grants g where g.id::text = ${auditLog.recordId})
  when 'contracts' then (select c.number || ' · ' || c.title from contracts c where c.id::text = ${auditLog.recordId})
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
    ];
    return new Map(found.map(({ id, name }) => [id, name]));
  }
}

/** A value as people read it: rupees for prices, Yes/No, names for ids. */
function describe(field: string, value: unknown, names: Map<string, string>): string | null {
  if (value === undefined || value === null) return null;
  if (field.endsWith('_paise')) return formatINR(Number(value));
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // Numbers such as quantities come through as JSON numbers.
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return names.get(text) ?? text;
}
