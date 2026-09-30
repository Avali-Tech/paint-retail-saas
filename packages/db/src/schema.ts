import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  primaryKey,
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
    // Lets other tables reference (organization_id, store_id) so a row can never
    // point at a store from a different organisation.
    unique('stores_organization_id_id_unique').on(table.organizationId, table.id),
    index('stores_organization_id_idx').on(table.organizationId),
    pgPolicy('stores_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A person who can sign in. Identity is global (one person, one phone number);
 * access to each organisation comes from organization_members.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fullName: text('full_name').notNull(),
    /** E.164 format, for example +919876543210. */
    phone: text('phone').unique(),
    /** Stored lowercase. */
    email: text('email').unique(),
    /** scrypt hash; null for users who only sign in with OTP. */
    passwordHash: text('password_hash'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check('users_phone_or_email', sql`${table.phone} is not null or ${table.email} is not null`),
    check('users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check('users_phone_e164', sql`${table.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    // Tenants can see the people who belong to their organisation, and no one else.
    pgPolicy('users_tenant_select', {
      for: 'select',
      to: tenantRole,
      using: sql`exists (
        select 1 from organization_members m
        where m.user_id = ${table.id} and m.organization_id = ${currentOrganizationId}
      )`,
    }),
  ],
).enableRLS();

/** A named set of permissions within an organisation, e.g. "Branch Manager". */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Stable identifier, e.g. "branch_manager". */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Created automatically with the organisation; cannot be deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    unique('roles_organization_key_unique').on(table.organizationId, table.key),
    unique('roles_organization_id_id_unique').on(table.organizationId, table.id),
    pgPolicy('roles_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Permissions granted by a role. Permission keys are defined in @paint/shared. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    organizationId: uuid('organization_id').notNull(),
    roleId: uuid('role_id').notNull(),
    permission: text('permission').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permission] }),
    foreignKey({
      name: 'role_permissions_role_fk',
      columns: [table.organizationId, table.roleId],
      foreignColumns: [roles.organizationId, roles.id],
    }).onDelete('cascade'),
    pgPolicy('role_permissions_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** A user's membership of an organisation: their role and which stores they can access. */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    roleId: uuid('role_id').notNull(),
    /** True for owners and admins: access to every store, including future ones. */
    allStores: boolean('all_stores').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('organization_members_organization_user_unique').on(table.organizationId, table.userId),
    unique('organization_members_organization_id_id_unique').on(table.organizationId, table.id),
    index('organization_members_user_id_idx').on(table.userId),
    foreignKey({
      name: 'organization_members_role_fk',
      columns: [table.organizationId, table.roleId],
      foreignColumns: [roles.organizationId, roles.id],
    }).onDelete('restrict'),
    pgPolicy('organization_members_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Stores a member can access when they don't have all-store access. */
export const memberStores = pgTable(
  'member_stores',
  {
    organizationId: uuid('organization_id').notNull(),
    memberId: uuid('member_id').notNull(),
    storeId: uuid('store_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.storeId] }),
    foreignKey({
      name: 'member_stores_member_fk',
      columns: [table.organizationId, table.memberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'member_stores_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('cascade'),
    pgPolicy('member_stores_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A signed-in device. The client holds a random token; only its SHA-256 hash is
 * stored, so a database leak does not reveal usable tokens.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    pgPolicy('sessions_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A one-time sign-in code sent by SMS. Only its hash is stored. Used outside
 * tenant scope, so tenants have no policy here and can never read it.
 */
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('otp_challenges_phone_created_at_idx').on(table.phone, table.createdAt)],
).enableRLS();
