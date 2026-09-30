import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Role every tenant-scoped query runs as. Row-level security policies apply to
 * it, so a query can only ever see rows of the organisation set for the current
 * transaction. Created by migration 0000 (roles are server-wide, so it is
 * created only if missing).
 */
export const tenantRole = pgRole('app_tenant').existing();

/** The organisation id set for the current transaction, or NULL when none is set. */
const currentOrganizationId = sql`nullif(current_setting('app.current_organization_id', true), '')::uuid`;

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** A paint business using the product (a tenant). */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ...timestamps,
  },
  (table) => [
    // Tenants can read and update their own organisation, but never create or
    // delete organisations: that is done by the platform, outside tenant scope.
    pgPolicy('organizations_tenant_select', {
      for: 'select',
      to: tenantRole,
      using: sql`${table.id} = ${currentOrganizationId}`,
    }),
    pgPolicy('organizations_tenant_update', {
      for: 'update',
      to: tenantRole,
      using: sql`${table.id} = ${currentOrganizationId}`,
      withCheck: sql`${table.id} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Where stock is held: a retail store or a godown (warehouse). */
export const locationType = pgEnum('location_type', ['store', 'godown']);

/** A store or godown belonging to an organisation. */
export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Short code used on documents, unique within an organisation (for example "HYD1"). */
    code: text('code').notNull(),
    type: locationType('type').notNull().default('store'),
    city: text('city'),
    state: text('state'),
    gstin: text('gstin'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('stores_organization_code_unique').on(table.organizationId, table.code),
    index('stores_organization_id_idx').on(table.organizationId),
    pgPolicy('stores_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();
