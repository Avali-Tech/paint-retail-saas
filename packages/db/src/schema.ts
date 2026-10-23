import { sql, type AnyColumn } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
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
export const plan = pgEnum('plan', ['trial', 'starter', 'standard', 'enterprise']);

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /**
     * The business's sign-in link name (`/sign-in?b=<slug>`): unique ignoring case,
     * stored lower-case. Left out on insert, the organizations_slug trigger derives it
     * from the name (generate_organization_slug, migration 0048); owners change it.
     */
    slug: text('slug')
      .notNull()
      .$defaultFn(() => sql`null`),
    /** Set by the platform (roadmap P1-M23); limits come from @paint/shared PLANS. */
    plan: plan('plan').notNull().default('trial'),
    /** Per-business overrides of the plan's features, e.g. {"loyalty": true}. */
    featureFlags: jsonb('feature_flags').notNull().default({}),
    /** A suspended business cannot sign in. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendReason: text('suspend_reason'),
    /** Owners and organization admins must use two-factor sign-in (TOTP). */
    twoFactorRequired: boolean('two_factor_required').notNull().default(true),
    /** Registered legal name: the default for each store's GST registration. */
    legalName: text('legal_name'),
    ...timestamps,
  },
  (table) => [
    check(
      'organizations_suspend_reason',
      sql`(${table.suspendedAt} is null) = (${table.suspendReason} is null)`,
    ),
    check(
      'organizations_slug_format',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) between 3 and 40`,
    ),
    uniqueIndex('organizations_slug_unique').on(sql`lower(${table.slug})`),
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

/** How a store is registered under GST (one registration per state). */
export const gstRegistrationType = pgEnum('gst_registration_type', [
  'regular',
  'composition',
  'unregistered',
]);

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
    /** GSTN state code of the registration, e.g. "36" (Telangana); the GSTIN starts with it. */
    stateCode: text('gst_state_code'),
    registrationType: gstRegistrationType('gst_registration_type')
      .notNull()
      .default('unregistered'),
    /** As on the registration certificate; defaults to the business's legal name. */
    legalName: text('legal_name'),
    tradeName: text('trade_name'),
    addressLine: text('address_line'),
    pincode: text('pincode'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('stores_organization_code_unique').on(table.organizationId, table.code),
    check('stores_gst_state_code_format', sql`${table.stateCode} ~ '^[0-9]{2}$'`),
    check('stores_pincode_format', sql`${table.pincode} ~ '^[1-9][0-9]{5}$'`),
    // Releases before GST registrations saved a bare GSTIN without a state code.
    check(
      'stores_gstin_in_state',
      sql`${table.gstin} is null or ${table.stateCode} is null or left(${table.gstin}, 2) = ${table.stateCode}`,
    ),
    check(
      'stores_registration_complete',
      sql`${table.registrationType} = 'unregistered' or (${table.gstin} is not null and ${table.stateCode} is not null and ${table.legalName} is not null)`,
    ),
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
    /** The platform's support staff, here for an approved support grant; hidden from member lists. */
    isSupport: boolean('is_support').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    /** When an owner last reset this member's two-factor sign-in (audited). */
    twoFactorResetAt: timestamp('two_factor_reset_at', { withTimezone: true }),
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
 * A member's own exceptions to their role: a permission granted on top of it,
 * or one taken away from it (a denial wins). Owners have none.
 */
export const memberPermissionExceptions = pgTable(
  'member_permission_exceptions',
  {
    organizationId: uuid('organization_id').notNull(),
    memberId: uuid('member_id').notNull(),
    permission: text('permission').notNull(),
    /** True to grant the permission, false to deny it. */
    granted: boolean('granted').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.permission] }),
    foreignKey({
      name: 'member_permission_exceptions_member_fk',
      columns: [table.organizationId, table.memberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('cascade'),
    pgPolicy('member_permission_exceptions_tenant_isolation', {
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
    /** Set for the platform's support sessions; they end with their grant. */
    supportGrantId: uuid('support_grant_id'),
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

/**
 * A person's authenticator app (TOTP, RFC 6238). Belongs to the person, so it
 * covers every business they work for and the platform console. The secret is
 * encrypted (AES-256-GCM); it counts only once confirmed with a code.
 */
export const userTotp = pgTable('user_totp', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretCiphertext: text('secret_ciphertext').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  /** The last time step accepted, so a code cannot be used twice. */
  lastUsedStep: bigint('last_used_step', { mode: 'bigint' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Row-level security with no tenant policy: only sign-in code reads it.
}).enableRLS();

/** One-time recovery codes for a lost phone; stored as keyed hashes. */
export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('user_recovery_codes_unique').on(table.userId, table.codeHash)],
).enableRLS();

/**
 * The second step of a sign-in: issued after the password or SMS code, it
 * becomes a session once a TOTP or recovery code is given. Short-lived, with a
 * limited number of tries. No organisation = the platform console.
 */
export const twoFactorChallenges = pgTable(
  'two_factor_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('two_factor_challenges_attempts', sql`${table.attempts} >= 0`)],
).enableRLS();

/** Whether a party is an individual or a business. */
export const partyKind = pgEnum('party_kind', ['person', 'organization']);

/** The roles a party can play; one party can hold several (roadmap §3.5). */
export const partyRole = pgEnum('party_role', [
  'customer',
  'contractor',
  'painter',
  'architect',
  'dealer',
  'supplier',
  'distributor',
  'sub_dealer',
]);

export const customerType = pgEnum('customer_type', [
  'retail',
  'contractor',
  'painter',
  'dealer',
  'builder',
  'corporate',
]);

export const contactMethod = pgEnum('contact_method', ['phone', 'whatsapp', 'email', 'visit']);

/**
 * Anyone the business deals with: customers, contractors, painters, architects,
 * dealers, suppliers. One record per real person or company, with roles attached.
 */
export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: partyKind('kind').notNull().default('person'),
    displayName: text('display_name').notNull(),
    legalName: text('legal_name'),
    /** For businesses: who to speak to. */
    contactPerson: text('contact_person'),
    phone: text('phone'),
    alternatePhone: text('alternate_phone'),
    email: text('email'),
    gstin: text('gstin'),
    pan: text('pan'),
    addressLine: text('address_line'),
    city: text('city'),
    state: text('state'),
    pincode: text('pincode'),
    /**
     * GSTN state code of the place of supply. A trigger sets it from the GSTIN
     * whenever there is one (migration 0052); otherwise it is entered.
     */
    placeOfSupply: text('place_of_supply'),
    /** Store the party mainly deals with; null = business-wide (e.g. a supplier). */
    homeStoreId: uuid('home_store_id'),
    notes: text('notes'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isActive: boolean('is_active').notNull().default(true),
    /** Set when this party was a duplicate merged into another; old links lead there. */
    mergedIntoId: uuid('merged_into_id'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergedByMemberId: uuid('merged_by_member_id'),
    ...timestamps,
  },
  (table) => [
    // Duplicate detection: one party per mobile number and per GSTIN in a business.
    unique('parties_organization_phone_unique').on(table.organizationId, table.phone),
    unique('parties_organization_gstin_unique').on(table.organizationId, table.gstin),
    unique('parties_organization_id_id_unique').on(table.organizationId, table.id),
    index('parties_organization_display_name_idx').on(table.organizationId, table.displayName),
    foreignKey({
      name: 'parties_home_store_fk',
      columns: [table.organizationId, table.homeStoreId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    check('parties_phone_e164', sql`${table.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check('parties_alternate_phone_e164', sql`${table.alternatePhone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check('parties_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check(
      'parties_gstin_format',
      sql`${table.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
    ),
    check('parties_pan_format', sql`${table.pan} ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`),
    check('parties_pincode_format', sql`${table.pincode} ~ '^[1-9][0-9]{5}$'`),
    check('parties_place_of_supply_format', sql`${table.placeOfSupply} ~ '^[0-9]{2}$'`),
    foreignKey({
      name: 'parties_merged_into_fk',
      columns: [table.organizationId, table.mergedIntoId],
      foreignColumns: [table.organizationId, table.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'parties_merged_by_fk',
      columns: [table.organizationId, table.mergedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'parties_merge_complete',
      sql`(${table.mergedIntoId} is null) = (${table.mergedAt} is null) and (${table.mergedAt} is null) = (${table.mergedByMemberId} is null)`,
    ),
    check('parties_not_merged_into_self', sql`${table.mergedIntoId} <> ${table.id}`),
    check('parties_merged_inactive', sql`${table.mergedIntoId} is null or not ${table.isActive}`),
    pgPolicy('parties_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Roles held by a party. */
export const partyRoles = pgTable(
  'party_roles',
  {
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    role: partyRole('role').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.partyId, table.role] }),
    index('party_roles_organization_role_idx').on(table.organizationId, table.role),
    foreignKey({
      name: 'party_roles_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('cascade'),
    pgPolicy('party_roles_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Extra details for parties with the customer role (roadmap §3.7). */
export const customerProfiles = pgTable(
  'customer_profiles',
  {
    partyId: uuid('party_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    customerType: customerType('customer_type').notNull().default('retail'),
    /** Salesperson responsible for this customer. */
    assignedMemberId: uuid('assigned_member_id'),
    preferredContact: contactMethod('preferred_contact').notNull().default('phone'),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: 'customer_profiles_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'customer_profiles_assigned_member_fk',
      columns: [table.organizationId, table.assignedMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    pgPolicy('customer_profiles_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** A manufacturer brand sold by the business, e.g. Asian Paints. */
export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('brands_organization_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    unique('brands_organization_id_id_unique').on(table.organizationId, table.id),
    pgPolicy('brands_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** A product category; with a parent it is a subcategory (two levels). */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    /** Inactive categories keep their products but take no new ones. */
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('categories_organization_parent_name_unique').on(
      table.organizationId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`,
    ),
    unique('categories_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'categories_parent_fk',
      columns: [table.organizationId, table.parentId],
      foreignColumns: [table.organizationId, table.id],
    }).onDelete('restrict'),
    check('categories_not_own_parent', sql`${table.parentId} <> ${table.id}`),
    pgPolicy('categories_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A business's tax category, e.g. "Paints 18%". Its rate lives in tax_rates, one
 * row per period, so a change in law is a new row and history stays as it was.
 * Every business starts with the defaults of seed_default_tax_categories (0052).
 */
export const taxCategories = pgTable(
  'tax_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Created with the business by a trigger, so they go with it (tenants cannot delete either).
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Set on the categories every business starts with, e.g. "paints"; null for the business's own. */
    key: text('key'),
    name: text('name').notNull(),
    /** The category new products get when none is chosen (before GST registration). */
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tax_categories_organization_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    unique('tax_categories_organization_key_unique').on(table.organizationId, table.key),
    unique('tax_categories_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('tax_categories_one_default')
      .on(table.organizationId)
      .where(sql`${table.isDefault}`),
    check('tax_categories_default_active', sql`not ${table.isDefault} or ${table.isActive}`),
    pgPolicy('tax_categories_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * One period of a tax category's rate. Periods never overlap (an exclusion
 * constraint, 0052); rows are never edited or deleted, except that the open
 * period is closed (effective_to set) when the next rate is added.
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    taxCategoryId: uuid('tax_category_id').notNull(),
    /** Basis points: 1800 = 18%. */
    rateBps: integer('rate_bps').notNull(),
    /** India-time calendar days, both inclusive; effective_to null = still in force. */
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tax_rates_category_from_unique').on(table.taxCategoryId, table.effectiveFrom),
    foreignKey({
      name: 'tax_rates_category_fk',
      columns: [table.organizationId, table.taxCategoryId],
      foreignColumns: [taxCategories.organizationId, taxCategories.id],
    }).onDelete('cascade'),
    check('tax_rates_rate_range', sql`${table.rateBps} between 0 and 10000`),
    check(
      'tax_rates_period_order',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    pgPolicy('tax_rates_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const productType = pgEnum('product_type', [
  'interior_paint',
  'exterior_paint',
  'primer',
  'putty',
  'enamel',
  'wood_finish',
  'waterproofing',
  'texture',
  'thinner',
  'tool',
  'other',
  /** Tinting colorant, stocked loose in ml or g so each dose can be taken out (round 8a). */
  'colorant',
]);

/** Units a pack size can be expressed in. */
export const unitOfMeasure = pgEnum('unit_of_measure', ['ml', 'l', 'g', 'kg', 'piece', 'set', 'm']);

/**
 * A product family, e.g. "Apex Ultima" by Asian Paints. Tax details live here;
 * pack sizes, SKUs and prices live on its variants.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    brandId: uuid('brand_id').notNull(),
    categoryId: uuid('category_id'),
    name: text('name').notNull(),
    type: productType('type').notNull(),
    description: text('description'),
    hsnCode: text('hsn_code').notNull(),
    /**
     * Deprecated: the tax category's rate when the product was last saved, kept
     * only so the previous release can still read products. Drop in a later release.
     */
    gstRateBps: integer('gst_rate_bps').notNull(),
    /**
     * Where the GST rate comes from. Null only for products the previous release
     * created during a rollout; the API sets it on every create (migration 0052).
     */
    taxCategoryId: uuid('tax_category_id'),
    /**
     * Square feet one litre covers in one coat (the estimator, spec §6.2). Null for
     * hardware, which has none, and for paint whose data sheet is not entered yet.
     */
    coverageSqftPerLitre: numeric('coverage_sqft_per_litre', {
      precision: 6,
      scale: 2,
      mode: 'number',
    }),
    /** Coats the estimator uses when a surface does not say; null for hardware. */
    defaultCoats: integer('default_coats'),
    /** Its packs are bases tinted at the counter (spec §6.3); false for hardware. */
    isTintable: boolean('is_tintable').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('products_organization_brand_name_unique').on(
      table.organizationId,
      table.brandId,
      sql`lower(${table.name})`,
    ),
    unique('products_organization_id_id_unique').on(table.organizationId, table.id),
    index('products_organization_name_idx').on(table.organizationId, table.name),
    foreignKey({
      name: 'products_brand_fk',
      columns: [table.organizationId, table.brandId],
      foreignColumns: [brands.organizationId, brands.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'products_category_fk',
      columns: [table.organizationId, table.categoryId],
      foreignColumns: [categories.organizationId, categories.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'products_tax_category_fk',
      columns: [table.organizationId, table.taxCategoryId],
      foreignColumns: [taxCategories.organizationId, taxCategories.id],
    }).onDelete('restrict'),
    index('products_tax_category_idx').on(table.organizationId, table.taxCategoryId),
    check('products_hsn_format', sql`${table.hsnCode} ~ '^[0-9]{4}([0-9]{2}){0,2}$'`),
    check('products_gst_rate_range', sql`${table.gstRateBps} between 0 and 10000`),
    check('products_coverage_positive', sql`${table.coverageSqftPerLitre} > 0`),
    check('products_default_coats_range', sql`${table.defaultCoats} between 1 and 5`),
    pgPolicy('products_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** A sellable pack of a product, e.g. Apex Ultima 20 L (SKU AP-ULT-20L). */
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    productId: uuid('product_id').notNull(),
    /** Stored uppercase; unique within the business. */
    sku: text('sku').notNull(),
    packSize: numeric('pack_size', { precision: 12, scale: 3, mode: 'number' }).notNull(),
    unit: unitOfMeasure('unit').notNull(),
    /**
     * What tells same-sized packs apart, e.g. "2 inch", "Grit 120", "48 mm" or "Red";
     * trimmed, 1 to 40 characters. Brushes and sandpaper are all "1 piece".
     */
    label: text('label'),
    /** Maximum retail price printed on the pack, in paise. */
    mrpPaise: bigint('mrp_paise', { mode: 'number' }),
    /** Default selling price, in paise. Never above the MRP. */
    sellingPricePaise: bigint('selling_price_paise', { mode: 'number' }),
    /**
     * Grams per millilitre, to turn a dose in ml into stock kept in g and back
     * (round 8a: colorants, putty). Null when not known.
     */
    densityGPerMl: numeric('density_g_per_ml', { precision: 7, scale: 4, mode: 'number' }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('product_variants_organization_sku_unique').on(table.organizationId, table.sku),
    // One variant per size and label; no label counts as one value, and case does not matter.
    uniqueIndex('product_variants_product_pack_label_unique').on(
      table.productId,
      table.packSize,
      table.unit,
      sql`lower(coalesce(${table.label}, ''))`,
    ),
    unique('product_variants_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'product_variants_product_fk',
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
    }).onDelete('cascade'),
    check('product_variants_sku_format', sql`${table.sku} ~ '^[A-Z0-9][A-Z0-9._/-]{1,39}$'`),
    check('product_variants_pack_size_positive', sql`${table.packSize} > 0`),
    check(
      'product_variants_label_format',
      sql`${table.label} = btrim(${table.label}) and char_length(${table.label}) between 1 and 40`,
    ),
    check(
      'product_variants_prices_not_negative',
      sql`${table.mrpPaise} >= 0 and ${table.sellingPricePaise} >= 0`,
    ),
    check(
      'product_variants_density_range',
      sql`${table.densityGPerMl} > 0 and ${table.densityGPerMl} <= 25`,
    ),
    check(
      'product_variants_price_within_mrp',
      sql`${table.sellingPricePaise} is null or ${table.mrpPaise} is null or ${table.sellingPricePaise} <= ${table.mrpPaise}`,
    ),
    pgPolicy('product_variants_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Barcodes printed on or assigned to a variant; unique within the business. */
export const productBarcodes = pgTable(
  'product_barcodes',
  {
    organizationId: uuid('organization_id').notNull(),
    barcode: text('barcode').notNull(),
    variantId: uuid('variant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.barcode] }),
    index('product_barcodes_variant_id_idx').on(table.variantId),
    foreignKey({
      name: 'product_barcodes_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('cascade'),
    pgPolicy('product_barcodes_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Why stock moved. The sign of the quantity must match the type (see check below). */
export const stockMovementType = pgEnum('stock_movement_type', [
  'opening',
  'purchase_receipt',
  'purchase_return',
  'transfer_in',
  'transfer_out',
  'sale',
  'sale_return',
  'adjustment',
  'damage',
  'count_correction',
  /** Colorant dosed into a tinted pack that left the store (round 8a). */
  'tint_use',
]);

/**
 * Every stock movement, forever. Append-only: a trigger refuses updates and
 * deletes, so mistakes are corrected with a new entry. Positive quantity = in,
 * negative = out, in units of the variant (packs, or ml for colorants later).
 */
export const stockLedger = pgTable(
  'stock_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    movementType: stockMovementType('movement_type').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    /** Cost per unit for incoming stock, in paise; drives the weighted-average cost. */
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }),
    /** What caused the movement, e.g. a transfer or goods receipt (later modules). */
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    note: text('note'),
    createdByMemberId: uuid('created_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('stock_ledger_store_variant_created_idx').on(
      table.organizationId,
      table.storeId,
      table.variantId,
      table.createdAt,
    ),
    index('stock_ledger_reference_idx').on(table.referenceType, table.referenceId),
    // Newest movements first (stock ledger report and GET /stock/ledger); NULLS FIRST matches
    // ORDER BY ... DESC, so no sort is needed. See docs/performance.md.
    index('stock_ledger_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'stock_ledger_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_ledger_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_ledger_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'stock_ledger_quantity_sign',
      // As text: 'tint_use' cannot be cast to in the migration that adds it (0092).
      sql`case
        when ${table.movementType} in ('opening', 'purchase_receipt', 'transfer_in', 'sale_return') then ${table.quantity} > 0
        when ${table.movementType}::text in ('purchase_return', 'transfer_out', 'sale', 'damage', 'tint_use') then ${table.quantity} < 0
        else ${table.quantity} <> 0
      end`,
    ),
    check('stock_ledger_unit_cost_not_negative', sql`${table.unitCostPaise} >= 0`),
    pgPolicy('stock_ledger_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Current stock per store and variant, kept in step with stock_ledger in the
 * same transaction. on_hand always equals the sum of the ledger (checked by
 * findStockMismatches); it can never go negative.
 */
export const stockBalances = pgTable(
  'stock_balances',
  {
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    onHand: numeric('on_hand', { precision: 14, scale: 3, mode: 'number' }).notNull().default(0),
    /** Held for confirmed orders (Phase 2). Available = on_hand - reserved. */
    reserved: numeric('reserved', { precision: 14, scale: 3, mode: 'number' }).notNull().default(0),
    /** Weighted-average cost per unit in paise; null until a costed receipt. */
    avgCostPaise: bigint('avg_cost_paise', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.variantId] }),
    index('stock_balances_organization_variant_idx').on(table.organizationId, table.variantId),
    foreignKey({
      name: 'stock_balances_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_balances_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    check('stock_balances_on_hand_not_negative', sql`${table.onHand} >= 0`),
    check(
      'stock_balances_reserved_within_on_hand',
      sql`${table.reserved} >= 0 and ${table.reserved} <= ${table.onHand}`,
    ),
    pgPolicy('stock_balances_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Gap-free document numbers per organisation and series (transfers now; GST
 * invoices later, which must be numbered without gaps per financial year).
 * Incremented inside the transaction that creates the document, so a rolled-back
 * document never consumes a number.
 */
export const documentSequences = pgTable(
  'document_sequences',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** e.g. "transfer", or later "invoice:36AABCU9603R1ZO:2026-27". */
    series: text('series').notNull(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.series] }),
    check('document_sequences_last_value_not_negative', sql`${table.lastValue} >= 0`),
    pgPolicy('document_sequences_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const transferStatus = pgEnum('transfer_status', [
  'requested',
  'approved',
  'in_transit',
  'received',
  'rejected',
  'cancelled',
]);

/** Stock moving from one store to another (roadmap §3.15). */
export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Human-readable, gap-free, e.g. TR-000042. */
    number: text('number').notNull(),
    fromStoreId: uuid('from_store_id').notNull(),
    toStoreId: uuid('to_store_id').notNull(),
    status: transferStatus('status').notNull().default('requested'),
    note: text('note'),
    /** Why it was rejected or cancelled. */
    closingReason: text('closing_reason'),
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    approvedByMemberId: uuid('approved_by_member_id'),
    dispatchedByMemberId: uuid('dispatched_by_member_id'),
    receivedByMemberId: uuid('received_by_member_id'),
    closedByMemberId: uuid('closed_by_member_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('transfers_organization_number_unique').on(table.organizationId, table.number),
    unique('transfers_organization_id_id_unique').on(table.organizationId, table.id),
    index('transfers_from_store_status_idx').on(
      table.organizationId,
      table.fromStoreId,
      table.status,
    ),
    index('transfers_to_store_status_idx').on(table.organizationId, table.toStoreId, table.status),
    foreignKey({
      name: 'transfers_from_store_fk',
      columns: [table.organizationId, table.fromStoreId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transfers_to_store_fk',
      columns: [table.organizationId, table.toStoreId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transfers_requested_by_fk',
      columns: [table.organizationId, table.requestedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('transfers_different_stores', sql`${table.fromStoreId} <> ${table.toStoreId}`),
    pgPolicy('transfers_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** A product on a transfer, with the quantity at each stage. */
export const transferLines = pgTable(
  'transfer_lines',
  {
    organizationId: uuid('organization_id').notNull(),
    transferId: uuid('transfer_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    requestedQuantity: numeric('requested_quantity', {
      precision: 14,
      scale: 3,
      mode: 'number',
    }).notNull(),
    approvedQuantity: numeric('approved_quantity', { precision: 14, scale: 3, mode: 'number' }),
    dispatchedQuantity: numeric('dispatched_quantity', { precision: 14, scale: 3, mode: 'number' }),
    /** Arrived in good condition. */
    receivedQuantity: numeric('received_quantity', { precision: 14, scale: 3, mode: 'number' }),
    /** Arrived damaged (written off at the destination). */
    damagedQuantity: numeric('damaged_quantity', { precision: 14, scale: 3, mode: 'number' }),
    /**
     * The sending store's average cost per unit at dispatch, in paise. The
     * receiving store takes the stock in at this cost, so stock value is preserved.
     */
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }),
  },
  (table) => [
    primaryKey({ columns: [table.transferId, table.variantId] }),
    foreignKey({
      name: 'transfer_lines_transfer_fk',
      columns: [table.organizationId, table.transferId],
      foreignColumns: [transfers.organizationId, transfers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'transfer_lines_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    check('transfer_lines_requested_positive', sql`${table.requestedQuantity} > 0`),
    check(
      'transfer_lines_approved_within_requested',
      sql`${table.approvedQuantity} >= 0 and ${table.approvedQuantity} <= ${table.requestedQuantity}`,
    ),
    check(
      'transfer_lines_dispatched_within_approved',
      sql`${table.dispatchedQuantity} >= 0 and ${table.dispatchedQuantity} <= ${table.approvedQuantity}`,
    ),
    check(
      'transfer_lines_received_within_dispatched',
      sql`${table.receivedQuantity} >= 0 and ${table.damagedQuantity} >= 0
        and ${table.receivedQuantity} + ${table.damagedQuantity} <= ${table.dispatchedQuantity}`,
    ),
    pgPolicy('transfer_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const stockCountStatus = pgEnum('stock_count_status', [
  'counting',
  'submitted',
  'approved',
  'cancelled',
]);

/** What a count covers: the whole store, one brand, or one category (with subcategories). */
export const stockCountScope = pgEnum('stock_count_scope', ['full', 'brand', 'category']);

/** Why counted stock differs from the books (roadmap P1-M13). */
export const varianceReason = pgEnum('variance_reason', [
  'damage',
  'theft',
  'expiry',
  'counting_error',
  'other',
]);

/** A physical stock count at one store. */
export const stockCounts = pgTable(
  'stock_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. SC-000007. */
    number: text('number').notNull(),
    storeId: uuid('store_id').notNull(),
    scope: stockCountScope('scope').notNull(),
    /** Brand or category id for a partial count. */
    scopeId: uuid('scope_id'),
    status: stockCountStatus('status').notNull().default('counting'),
    note: text('note'),
    closingReason: text('closing_reason'),
    startedByMemberId: uuid('started_by_member_id').notNull(),
    submittedByMemberId: uuid('submitted_by_member_id'),
    approvedByMemberId: uuid('approved_by_member_id'),
    closedByMemberId: uuid('closed_by_member_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('stock_counts_organization_number_unique').on(table.organizationId, table.number),
    unique('stock_counts_organization_id_id_unique').on(table.organizationId, table.id),
    // One open count per store at a time.
    uniqueIndex('stock_counts_one_open_per_store')
      .on(table.organizationId, table.storeId)
      .where(sql`${table.status} in ('counting', 'submitted')`),
    foreignKey({
      name: 'stock_counts_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_counts_started_by_fk',
      columns: [table.organizationId, table.startedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'stock_counts_scope_id_matches_scope',
      sql`(${table.scope} = 'full') = (${table.scopeId} is null)`,
    ),
    pgPolicy('stock_counts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** One product on a count: the books at the start, and what was physically counted. */
export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    organizationId: uuid('organization_id').notNull(),
    countId: uuid('count_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    /** On hand when the count started (or when the product was first counted). */
    expectedQuantity: numeric('expected_quantity', {
      precision: 14,
      scale: 3,
      mode: 'number',
    }).notNull(),
    countedQuantity: numeric('counted_quantity', { precision: 14, scale: 3, mode: 'number' }),
    reason: varianceReason('reason'),
    countedByMemberId: uuid('counted_by_member_id'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.countId, table.variantId] }),
    foreignKey({
      name: 'stock_count_lines_count_fk',
      columns: [table.organizationId, table.countId],
      foreignColumns: [stockCounts.organizationId, stockCounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'stock_count_lines_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    check('stock_count_lines_expected_not_negative', sql`${table.expectedQuantity} >= 0`),
    check('stock_count_lines_counted_not_negative', sql`${table.countedQuantity} >= 0`),
    pgPolicy('stock_count_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * When to reorder a product at a store (roadmap §3.17). Alert when available
 * stock falls to the reorder level; it is critical below the minimum; order up
 * to the maximum.
 */
export const reorderRules = pgTable(
  'reorder_rules',
  {
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    minQuantity: numeric('min_quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    reorderLevel: numeric('reorder_level', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    maxQuantity: numeric('max_quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    updatedByMemberId: uuid('updated_by_member_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.variantId] }),
    index('reorder_rules_organization_store_idx').on(table.organizationId, table.storeId),
    foreignKey({
      name: 'reorder_rules_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'reorder_rules_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('cascade'),
    check(
      'reorder_rules_levels_in_order',
      sql`0 <= ${table.minQuantity} and ${table.minQuantity} <= ${table.reorderLevel}
        and ${table.reorderLevel} <= ${table.maxQuantity} and ${table.maxQuantity} > 0`,
    ),
    pgPolicy('reorder_rules_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Purchasing terms for a party with the supplier role (roadmap §3.18). */
export const supplierProfiles = pgTable(
  'supplier_profiles',
  {
    partyId: uuid('party_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    /** Days of credit the supplier gives. */
    paymentTermsDays: integer('payment_terms_days').notNull().default(0),
    /** Typical days from order to delivery. */
    leadTimeDays: integer('lead_time_days'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'supplier_profiles_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('cascade'),
    check(
      'supplier_profiles_payment_terms_range',
      sql`${table.paymentTermsDays} between 0 and 365`,
    ),
    check('supplier_profiles_lead_time_range', sql`${table.leadTimeDays} between 0 and 365`),
    pgPolicy('supplier_profiles_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Products a supplier provides, with the last cost paid (updated on each receipt). */
export const supplierProducts = pgTable(
  'supplier_products',
  {
    organizationId: uuid('organization_id').notNull(),
    supplierPartyId: uuid('supplier_party_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    /** The supplier's own code for the product, if different. */
    supplierSku: text('supplier_sku'),
    lastCostPaise: bigint('last_cost_paise', { mode: 'number' }),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.supplierPartyId, table.variantId] }),
    foreignKey({
      name: 'supplier_products_party_fk',
      columns: [table.organizationId, table.supplierPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'supplier_products_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('cascade'),
    check('supplier_products_last_cost_not_negative', sql`${table.lastCostPaise} >= 0`),
    pgPolicy('supplier_products_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const purchaseOrderStatus = pgEnum('purchase_order_status', [
  'open',
  'partially_received',
  'received',
  'closed',
  'cancelled',
]);

/** An order to a supplier for delivery to one store (roadmap §3.19). */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. PO-000012. */
    number: text('number').notNull(),
    supplierPartyId: uuid('supplier_party_id').notNull(),
    storeId: uuid('store_id').notNull(),
    status: purchaseOrderStatus('status').notNull().default('open'),
    expectedDate: date('expected_date', { mode: 'string' }),
    note: text('note'),
    closingReason: text('closing_reason'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    closedByMemberId: uuid('closed_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('purchase_orders_organization_number_unique').on(table.organizationId, table.number),
    unique('purchase_orders_organization_id_id_unique').on(table.organizationId, table.id),
    index('purchase_orders_store_status_idx').on(table.organizationId, table.storeId, table.status),
    foreignKey({
      name: 'purchase_orders_supplier_fk',
      columns: [table.organizationId, table.supplierPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'purchase_orders_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'purchase_orders_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    pgPolicy('purchase_orders_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    organizationId: uuid('organization_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    orderedQuantity: numeric('ordered_quantity', {
      precision: 14,
      scale: 3,
      mode: 'number',
    }).notNull(),
    /** Agreed cost per unit, in paise. */
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }),
    /** Paid units received so far (free scheme units are not counted against the order). */
    receivedQuantity: numeric('received_quantity', { precision: 14, scale: 3, mode: 'number' })
      .notNull()
      .default(0),
  },
  (table) => [
    primaryKey({ columns: [table.purchaseOrderId, table.variantId] }),
    foreignKey({
      name: 'purchase_order_lines_order_fk',
      columns: [table.organizationId, table.purchaseOrderId],
      foreignColumns: [purchaseOrders.organizationId, purchaseOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'purchase_order_lines_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    check('purchase_order_lines_ordered_positive', sql`${table.orderedQuantity} > 0`),
    check('purchase_order_lines_cost_not_negative', sql`${table.unitCostPaise} >= 0`),
    check(
      'purchase_order_lines_received_within_ordered',
      sql`${table.receivedQuantity} >= 0 and ${table.receivedQuantity} <= ${table.orderedQuantity}`,
    ),
    pgPolicy('purchase_order_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Goods received at a store (GRN), against a purchase order or directly against
 * the supplier's invoice. A supplier invoice can be entered only once.
 */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. GRN-000034. */
    number: text('number').notNull(),
    storeId: uuid('store_id').notNull(),
    supplierPartyId: uuid('supplier_party_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id'),
    supplierInvoiceNumber: text('supplier_invoice_number'),
    supplierInvoiceDate: date('supplier_invoice_date', { mode: 'string' }),
    note: text('note'),
    receivedByMemberId: uuid('received_by_member_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('goods_receipts_organization_number_unique').on(table.organizationId, table.number),
    unique('goods_receipts_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('goods_receipts_supplier_invoice_unique')
      .on(table.organizationId, table.supplierPartyId, sql`lower(${table.supplierInvoiceNumber})`)
      .where(sql`${table.supplierInvoiceNumber} is not null`),
    index('goods_receipts_purchase_order_idx').on(table.purchaseOrderId),
    foreignKey({
      name: 'goods_receipts_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'goods_receipts_supplier_fk',
      columns: [table.organizationId, table.supplierPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'goods_receipts_purchase_order_fk',
      columns: [table.organizationId, table.purchaseOrderId],
      foreignColumns: [purchaseOrders.organizationId, purchaseOrders.id],
    }).onDelete('restrict'),
    pgPolicy('goods_receipts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    organizationId: uuid('organization_id').notNull(),
    goodsReceiptId: uuid('goods_receipt_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    /** Paid units received. */
    quantity: numeric('quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    /** Scheme free units, received at zero cost. */
    freeQuantity: numeric('free_quantity', { precision: 14, scale: 3, mode: 'number' })
      .notNull()
      .default(0),
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }),
  },
  (table) => [
    primaryKey({ columns: [table.goodsReceiptId, table.variantId] }),
    foreignKey({
      name: 'goods_receipt_lines_receipt_fk',
      columns: [table.organizationId, table.goodsReceiptId],
      foreignColumns: [goodsReceipts.organizationId, goodsReceipts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'goods_receipt_lines_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    check(
      'goods_receipt_lines_quantities',
      sql`${table.quantity} >= 0 and ${table.freeQuantity} >= 0 and ${table.quantity} + ${table.freeQuantity} > 0`,
    ),
    check('goods_receipt_lines_cost_not_negative', sql`${table.unitCostPaise} >= 0`),
    pgPolicy('goods_receipt_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Records that can carry documents; access to a document follows access to its record. */
export const documentRecordType = pgEnum('document_record_type', [
  'party',
  'product',
  'store',
  'purchase_order',
  'goods_receipt',
  'transfer',
  'stock_count',
  'lead',
  'opportunity',
  'project',
  'contract',
  'tax_document',
  'payment',
  'register_session',
  'accounting_export',
]);

export const documentCategory = pgEnum('document_category', [
  'gst_certificate',
  'pan_card',
  'trade_licence',
  'cancelled_cheque',
  'contract',
  'quotation',
  'invoice',
  'delivery_challan',
  'photo',
  'other',
  'before_photo',
  'after_photo',
  'receipt',
  'accounting_export',
]);

/**
 * A file attached to a record (roadmap P1-M18). The bytes live in object
 * storage under `storage_key`; only files that passed the virus scan are saved.
 * Deleting hides the document but keeps the file for the audit trail.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    recordType: documentRecordType('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    category: documentCategory('category').notNull(),
    /** The uploader's file name, cleaned of paths and control characters. */
    fileName: text('file_name').notNull(),
    /** Detected from the file's content, not taken from the uploader. */
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    /** What the file shows, e.g. "North wall before repair". */
    note: text('note'),
    uploadedByMemberId: uuid('uploaded_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedByMemberId: uuid('deleted_by_member_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('documents_storage_key_unique').on(table.storageKey),
    unique('documents_organization_id_id_unique').on(table.organizationId, table.id),
    index('documents_record_idx')
      .on(table.organizationId, table.recordType, table.recordId)
      .where(sql`${table.deletedAt} is null`),
    // Documents across records, newest first. NULLS FIRST matches ORDER BY ... DESC.
    index('documents_recent_idx')
      .on(table.organizationId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.deletedAt} is null`),
    foreignKey({
      name: 'documents_uploaded_by_fk',
      columns: [table.organizationId, table.uploadedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'documents_deleted_by_fk',
      columns: [table.organizationId, table.deletedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('documents_size_positive', sql`${table.sizeBytes} > 0`),
    check('documents_sha256_format', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'documents_deleted_together',
      sql`(${table.deletedAt} is null) = (${table.deletedByMemberId} is null)`,
    ),
    pgPolicy('documents_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What a notification is about (roadmap P1-M19). */
export const notificationEvent = pgEnum('notification_event', [
  'transfer_awaiting_approval',
  'transfer_awaiting_receipt',
  'stock_count_awaiting_approval',
  'low_stock',
  'follow_up_due',
  'support_access_requested',
  'contract_renewal_due',
  'credit_request_awaiting_approval',
  'credit_request_decided',
  'loyalty_tier_reached',
  'cheque_bounced',
  'register_variance',
  'reconciliation_mismatch',
  'credit_approval_requested',
  'credit_approval_decided',
  'credit_hold_applied',
  'promise_broken',
  'payment_link_paid',
  'payment_link_refund',
  'scheme_slab_near',
  'scheme_claim_overdue',
  /** A tinted pack left with more colorant than the store had in stock (round 8a). */
  'colorant_short',
  /** Stock that has not sold or moved out for the business's slow-mover days. */
  'slow_movers',
]);

/** An in-app notification for one member. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    memberId: uuid('member_id').notNull(),
    event: notificationEvent('event').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Where in the app to open, e.g. /transfers/<id>. */
    link: text('link').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    index('notifications_member_idx').on(table.memberId, table.createdAt),
    index('notifications_member_unread_idx')
      .on(table.memberId)
      .where(sql`${table.readAt} is null`),
    foreignKey({
      name: 'notifications_member_fk',
      columns: [table.organizationId, table.memberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('cascade'),
    pgPolicy('notifications_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** A member's choice of channels for one event; no row = every channel on. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    organizationId: uuid('organization_id').notNull(),
    memberId: uuid('member_id').notNull(),
    event: notificationEvent('event').notNull(),
    inApp: boolean('in_app').notNull(),
    email: boolean('email').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.event] }),
    foreignKey({
      name: 'notification_preferences_member_fk',
      columns: [table.organizationId, table.memberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('cascade'),
    pgPolicy('notification_preferences_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const emailStatus = pgEnum('email_status', ['pending', 'sent', 'failed']);

/**
 * Emails waiting to be sent (the outbox pattern): written in the same
 * transaction as the event, sent afterwards by the worker, with retries.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    memberId: uuid('member_id').notNull(),
    event: notificationEvent('event').notNull(),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    textBody: text('text_body').notNull(),
    status: emailStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    index('email_outbox_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: 'email_outbox_member_fk',
      columns: [table.organizationId, table.memberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('cascade'),
    check('email_outbox_attempts_not_negative', sql`${table.attempts} >= 0`),
    check(
      'email_outbox_sent_when_sent',
      sql`(${table.status} = 'sent') = (${table.sentAt} is not null)`,
    ),
    pgPolicy('email_outbox_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Products already reported as low at a store, so each dip below the reorder
 * level is announced once. Cleared when stock recovers above the level.
 */
export const lowStockAlerts = pgTable(
  'low_stock_alerts',
  {
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    alertedAt: timestamp('alerted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.variantId] }),
    foreignKey({
      name: 'low_stock_alerts_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'low_stock_alerts_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('cascade'),
    pgPolicy('low_stock_alerts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Products already announced as slow at a store: once per idle stretch. A
 * sale, a transfer out or running out of it clears the row, so the next
 * stretch is announced again.
 */
export const slowMoverAlerts = pgTable(
  'slow_mover_alerts',
  {
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    alertedAt: timestamp('alerted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.variantId] }),
    foreignKey({
      name: 'slow_mover_alerts_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'slow_mover_alerts_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('cascade'),
    pgPolicy('slow_mover_alerts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** How a lead reached us (roadmap P1-M07). */
export const leadSource = pgEnum('lead_source', [
  'walk_in',
  'phone_call',
  'referral',
  'architect',
  'contractor',
  'painter',
  'website',
  'social_media',
  'exhibition',
  'other',
]);

export const leadStage = pgEnum('lead_stage', [
  'new',
  'contacted',
  'qualified',
  'opportunity',
  'won',
  'lost',
]);

/**
 * A potential piece of business, e.g. a contractor calling about a 4-floor
 * building. Becomes an opportunity once qualified.
 */
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. LD-000007. */
    number: text('number').notNull(),
    storeId: uuid('store_id').notNull(),
    /** Who the lead is with. */
    partyId: uuid('party_id').notNull(),
    title: text('title').notNull(),
    requirement: text('requirement'),
    source: leadSource('source').notNull(),
    /** The architect, contractor or customer who referred it. */
    referredByPartyId: uuid('referred_by_party_id'),
    estimatedValuePaise: bigint('estimated_value_paise', { mode: 'number' }),
    expectedOrderDate: date('expected_order_date', { mode: 'string' }),
    assignedMemberId: uuid('assigned_member_id'),
    stage: leadStage('stage').notNull().default('new'),
    lostReason: text('lost_reason'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it was won or lost. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    unique('leads_organization_number_unique').on(table.organizationId, table.number),
    unique('leads_organization_id_id_unique').on(table.organizationId, table.id),
    index('leads_store_stage_idx').on(table.organizationId, table.storeId, table.stage),
    index('leads_assigned_idx').on(table.assignedMemberId),
    index('leads_party_idx').on(table.partyId),
    foreignKey({
      name: 'leads_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'leads_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'leads_referred_by_fk',
      columns: [table.organizationId, table.referredByPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'leads_assigned_member_fk',
      columns: [table.organizationId, table.assignedMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'leads_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('leads_value_not_negative', sql`${table.estimatedValuePaise} >= 0`),
    check('leads_lost_reason', sql`(${table.stage} = 'lost') = (${table.lostReason} is not null)`),
    check(
      'leads_closed_when_closed',
      sql`(${table.stage} in ('won', 'lost')) = (${table.closedAt} is not null)`,
    ),
    pgPolicy('leads_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const opportunityStage = pgEnum('opportunity_stage', [
  'discovery',
  'proposal',
  'negotiation',
  'won',
  'lost',
]);

/** A qualified lead with an expected order: what, how much, when, how likely. */
export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. OP-000003. */
    number: text('number').notNull(),
    storeId: uuid('store_id').notNull(),
    /** The customer. */
    partyId: uuid('party_id').notNull(),
    /** The lead it came from, if any. */
    leadId: uuid('lead_id'),
    title: text('title').notNull(),
    expectedValuePaise: bigint('expected_value_paise', { mode: 'number' }).notNull(),
    /** Litres of paint expected. */
    expectedQuantity: numeric('expected_quantity', { precision: 12, scale: 3, mode: 'number' }),
    expectedOrderDate: date('expected_order_date', { mode: 'string' }),
    categoryId: uuid('category_id'),
    salespersonMemberId: uuid('salesperson_member_id'),
    /** Chance of winning, 0–100 %. */
    probability: integer('probability').notNull(),
    stage: opportunityStage('stage').notNull().default('discovery'),
    lostReason: text('lost_reason'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    unique('opportunities_organization_number_unique').on(table.organizationId, table.number),
    unique('opportunities_organization_id_id_unique').on(table.organizationId, table.id),
    unique('opportunities_lead_unique').on(table.leadId),
    index('opportunities_store_stage_idx').on(table.organizationId, table.storeId, table.stage),
    index('opportunities_salesperson_idx').on(table.salespersonMemberId),
    index('opportunities_party_idx').on(table.partyId),
    foreignKey({
      name: 'opportunities_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'opportunities_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'opportunities_lead_fk',
      columns: [table.organizationId, table.leadId],
      foreignColumns: [leads.organizationId, leads.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'opportunities_category_fk',
      columns: [table.organizationId, table.categoryId],
      foreignColumns: [categories.organizationId, categories.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'opportunities_salesperson_fk',
      columns: [table.organizationId, table.salespersonMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'opportunities_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('opportunities_value_not_negative', sql`${table.expectedValuePaise} >= 0`),
    check('opportunities_quantity_positive', sql`${table.expectedQuantity} > 0`),
    check('opportunities_probability_range', sql`${table.probability} between 0 and 100`),
    check(
      'opportunities_lost_reason',
      sql`(${table.stage} = 'lost') = (${table.lostReason} is not null)`,
    ),
    check(
      'opportunities_closed_when_closed',
      sql`(${table.stage} in ('won', 'lost')) = (${table.closedAt} is not null)`,
    ),
    pgPolicy('opportunities_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const projectStage = pgEnum('project_stage', [
  'identified',
  'survey',
  'specification',
  'quotation',
  'negotiation',
  'order',
  'execution',
  'completed',
  'cancelled',
]);

/**
 * A painting job at a site (roadmap P1-M08), not just another lead: the
 * customer, the people involved, the site and how much paint it needs.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. PJ-000004. */
    number: text('number').notNull(),
    storeId: uuid('store_id').notNull(),
    name: text('name').notNull(),
    customerPartyId: uuid('customer_party_id').notNull(),
    /** The opportunity it came from, if any. */
    opportunityId: uuid('opportunity_id'),
    addressLine: text('address_line'),
    city: text('city'),
    state: text('state'),
    pincode: text('pincode'),
    /** Map pin. */
    latitude: numeric('latitude', { precision: 9, scale: 6, mode: 'number' }),
    longitude: numeric('longitude', { precision: 9, scale: 6, mode: 'number' }),
    startDate: date('start_date', { mode: 'string' }),
    expectedCompletionDate: date('expected_completion_date', { mode: 'string' }),
    estimatedAreaSqFt: numeric('estimated_area_sq_ft', { precision: 12, scale: 2, mode: 'number' }),
    /** Litres of paint the job needs. */
    estimatedPaintLitres: numeric('estimated_paint_litres', {
      precision: 12,
      scale: 3,
      mode: 'number',
    }),
    expectedOrderValuePaise: bigint('expected_order_value_paise', { mode: 'number' }),
    stage: projectStage('stage').notNull().default('identified'),
    cancelReason: text('cancel_reason'),
    notes: text('notes'),
    assignedMemberId: uuid('assigned_member_id').notNull(),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    unique('projects_organization_number_unique').on(table.organizationId, table.number),
    unique('projects_organization_id_id_unique').on(table.organizationId, table.id),
    unique('projects_opportunity_unique').on(table.opportunityId),
    index('projects_store_stage_idx').on(table.organizationId, table.storeId, table.stage),
    index('projects_customer_idx').on(table.customerPartyId),
    foreignKey({
      name: 'projects_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'projects_customer_fk',
      columns: [table.organizationId, table.customerPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'projects_opportunity_fk',
      columns: [table.organizationId, table.opportunityId],
      foreignColumns: [opportunities.organizationId, opportunities.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'projects_assigned_member_fk',
      columns: [table.organizationId, table.assignedMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'projects_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('projects_pin_complete', sql`(${table.latitude} is null) = (${table.longitude} is null)`),
    check('projects_latitude_range', sql`${table.latitude} between -90 and 90`),
    check('projects_longitude_range', sql`${table.longitude} between -180 and 180`),
    check('projects_area_positive', sql`${table.estimatedAreaSqFt} > 0`),
    check('projects_paint_positive', sql`${table.estimatedPaintLitres} > 0`),
    check('projects_value_not_negative', sql`${table.expectedOrderValuePaise} >= 0`),
    check('projects_dates_in_order', sql`${table.expectedCompletionDate} >= ${table.startDate}`),
    check(
      'projects_cancel_reason',
      sql`(${table.stage} = 'cancelled') = (${table.cancelReason} is not null)`,
    ),
    check(
      'projects_closed_when_closed',
      sql`(${table.stage} in ('completed', 'cancelled')) = (${table.closedAt} is not null)`,
    ),
    pgPolicy('projects_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const projectPartyRole = pgEnum('project_party_role', [
  'architect',
  'contractor',
  'painter',
  'dealer',
]);

/** The people working on a project besides the customer; any number of each. */
export const projectParties = pgTable(
  'project_parties',
  {
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    partyId: uuid('party_id').notNull(),
    role: projectPartyRole('role').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.partyId, table.role] }),
    index('project_parties_party_idx').on(table.partyId),
    foreignKey({
      name: 'project_parties_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_parties_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    pgPolicy('project_parties_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const activityType = pgEnum('activity_type', [
  'call',
  'meeting',
  'visit',
  'whatsapp',
  'email',
  'follow_up',
  'note',
  // A customer's promise to pay (P2-M11); the promise itself is in promises_to_pay.
  'promise_to_pay',
]);

/** Records an activity can be about; customers, contractors, dealers and suppliers are parties. */
export const activityRecordType = pgEnum('activity_record_type', [
  'party',
  'lead',
  'opportunity',
  'project',
]);

/**
 * Something done or to do about a record (roadmap P1-M09): a call made, a
 * visit planned, a follow-up due. Done when completed_at is set; scheduled
 * while due_at is set and it is neither done nor cancelled.
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    recordType: activityRecordType('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The record's store, for store-level lists; null for business-wide parties. */
    storeId: uuid('store_id'),
    type: activityType('type').notNull(),
    subject: text('subject').notNull(),
    notes: text('notes'),
    /** What came of it, written when it is done. */
    outcome: text('outcome'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** When the assignee was reminded that it is due. */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    assignedMemberId: uuid('assigned_member_id').notNull(),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // For composite foreign keys (promises_to_pay.activity_id, MVP 3).
    unique('activities_organization_id_id_unique').on(table.organizationId, table.id),
    index('activities_record_idx').on(table.organizationId, table.recordType, table.recordId),
    index('activities_assignee_open_idx')
      .on(table.assignedMemberId, table.dueAt)
      .where(sql`${table.completedAt} is null and ${table.cancelledAt} is null`),
    // A team's open follow-ups, soonest first.
    index('activities_open_due_idx')
      .on(table.organizationId, table.dueAt)
      .where(sql`${table.completedAt} is null and ${table.cancelledAt} is null`),
    // Activities across records, latest first (when it happened or is due).
    index('activities_moment_idx').on(
      table.organizationId,
      sql`(coalesce(${table.completedAt}, ${table.cancelledAt}, ${table.dueAt}, ${table.createdAt})) desc`,
    ),
    index('activities_reminder_idx')
      .on(table.dueAt)
      .where(
        sql`${table.completedAt} is null and ${table.cancelledAt} is null and ${table.remindedAt} is null`,
      ),
    foreignKey({
      name: 'activities_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'activities_assigned_member_fk',
      columns: [table.organizationId, table.assignedMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'activities_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'activities_scheduled_or_done',
      sql`${table.dueAt} is not null or ${table.completedAt} is not null`,
    ),
    check(
      'activities_done_or_cancelled',
      sql`not (${table.completedAt} is not null and ${table.cancelledAt} is not null)`,
    ),
    pgPolicy('activities_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Kinds of agreement (roadmap P1-M24); contractor and supplier agreements come first. */
export const contractType = pgEnum('contract_type', [
  'contractor_agreement',
  'supplier_agreement',
  'customer_agreement',
  'dealer_agreement',
  'other',
]);

/**
 * Stored lifecycle of a contract. "Expired" is not stored: an active contract
 * whose end date has passed (in India) is shown as expired.
 */
export const contractStatus = pgEnum('contract_status', [
  'draft',
  'active',
  'terminated',
  'renewed',
]);

/**
 * An agreement with a contractor, supplier, customer or dealer (roadmap
 * P1-M24): a record with terms, dates and status, not a legal engine. Files are
 * attached as documents of record type "contract". Renewing creates the
 * follow-on contract, which points back at this one.
 */
export const contracts = pgTable(
  'contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. CT-000004. */
    number: text('number').notNull(),
    type: contractType('type').notNull(),
    title: text('title').notNull(),
    partyId: uuid('party_id').notNull(),
    /** Null for business-wide agreements. */
    storeId: uuid('store_id'),
    projectId: uuid('project_id'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    /** When to act on renewal; the assignee is reminded on this day. */
    renewalDate: date('renewal_date', { mode: 'string' }).notNull(),
    valuePaise: bigint('value_paise', { mode: 'number' }),
    terms: text('terms'),
    creditTerms: text('credit_terms'),
    discountTerms: text('discount_terms'),
    notes: text('notes'),
    status: contractStatus('status').notNull().default('draft'),
    terminationReason: text('termination_reason'),
    /** The contract this one renews. */
    renewalOfId: uuid('renewal_of_id'),
    /** When the assignee was reminded about the renewal; cleared when the date moves. */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    assignedMemberId: uuid('assigned_member_id').notNull(),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it was terminated or renewed. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    unique('contracts_organization_number_unique').on(table.organizationId, table.number),
    unique('contracts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('contracts_renewal_of_unique').on(table.renewalOfId),
    index('contracts_party_idx').on(table.partyId),
    index('contracts_store_status_idx').on(table.organizationId, table.storeId, table.status),
    index('contracts_reminder_idx')
      .on(table.renewalDate)
      .where(sql`${table.status} = 'active' and ${table.remindedAt} is null`),
    foreignKey({
      name: 'contracts_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_renewal_of_fk',
      columns: [table.organizationId, table.renewalOfId],
      foreignColumns: [table.organizationId, table.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_assigned_member_fk',
      columns: [table.organizationId, table.assignedMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('contracts_dates_in_order', sql`${table.endDate} >= ${table.startDate}`),
    check('contracts_renewal_by_end', sql`${table.renewalDate} <= ${table.endDate}`),
    check('contracts_value_not_negative', sql`${table.valuePaise} >= 0`),
    check(
      'contracts_termination_reason',
      sql`(${table.status} = 'terminated') = (${table.terminationReason} is not null)`,
    ),
    check(
      'contracts_ended_when_ended',
      sql`(${table.status} in ('terminated', 'renewed')) = (${table.endedAt} is not null)`,
    ),
    check('contracts_not_own_renewal', sql`${table.renewalOfId} <> ${table.id}`),
    pgPolicy('contracts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Whether a party buys on credit (roadmap P1-M25). */
export const creditStatus = pgEnum('credit_status', ['none', 'active', 'on_hold']);

/** Who put an account on hold: a person, or the nightly overdue check (P2-M09). */
export const creditHoldKind = pgEnum('credit_hold_kind', ['manual', 'auto']);

/** How risky the business judges a credit customer to be. */
export const creditRisk = pgEnum('credit_risk', ['low', 'medium', 'high']);

/**
 * A party's credit (roadmap P1-M25, spec §3.21): limit, days to pay, status and
 * risk. Limits and days change only by an approved credit request. Until billing
 * exists (Release 2.0), exposure and overdue days are entered by hand.
 */
export const creditProfiles = pgTable(
  'credit_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    status: creditStatus('status').notNull().default('none'),
    limitPaise: bigint('limit_paise', { mode: 'number' }).notNull().default(0),
    /** Days the party has to pay. */
    creditDays: integer('credit_days').notNull().default(0),
    risk: creditRisk('risk').notNull().default('low'),
    /** What the party owes now, entered by hand until invoices exist. */
    manualExposurePaise: bigint('manual_exposure_paise', { mode: 'number' }).notNull().default(0),
    /** Days the oldest unpaid amount is overdue, entered by hand until invoices exist. */
    overdueDays: integer('overdue_days').notNull().default(0),
    exposureUpdatedAt: timestamp('exposure_updated_at', { withTimezone: true }),
    exposureUpdatedByMemberId: uuid('exposure_updated_by_member_id'),
    /**
     * Set at go-live (spec §4.7) from the hand-entered overdue days: the opening
     * balance counts as overdue since this India date until it is paid.
     */
    openingOverdueSince: date('opening_overdue_since', { mode: 'string' }),
    holdReason: text('hold_reason'),
    heldAt: timestamp('held_at', { withTimezone: true }),
    /** Who held the account; null for an automatic hold (P2-M09). */
    heldByMemberId: uuid('held_by_member_id'),
    /** Put on hold by a person, or by the nightly overdue check (P2-M09). */
    holdKind: creditHoldKind('hold_kind'),
    /**
     * Released from an automatic hold with approval: until this India date the
     * overdue block is waived and the nightly check leaves the account alone.
     */
    overdueWaivedUntil: date('overdue_waived_until', { mode: 'string' }),
    notes: text('notes'),
    /** Who approved the current limit and days. */
    approvedByMemberId: uuid('approved_by_member_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('credit_profiles_organization_id_id_unique').on(table.organizationId, table.id),
    unique('credit_profiles_party_unique').on(table.partyId),
    index('credit_profiles_status_idx').on(table.organizationId, table.status),
    foreignKey({
      name: 'credit_profiles_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_profiles_exposure_updated_by_fk',
      columns: [table.organizationId, table.exposureUpdatedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_profiles_held_by_fk',
      columns: [table.organizationId, table.heldByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_profiles_approved_by_fk',
      columns: [table.organizationId, table.approvedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('credit_profiles_limit_not_negative', sql`${table.limitPaise} >= 0`),
    check('credit_profiles_days_range', sql`${table.creditDays} between 0 and 365`),
    check('credit_profiles_exposure_not_negative', sql`${table.manualExposurePaise} >= 0`),
    check('credit_profiles_overdue_not_negative', sql`${table.overdueDays} >= 0`),
    check(
      'credit_profiles_limit_when_enabled',
      sql`${table.status} = 'none' or ${table.limitPaise} > 0`,
    ),
    check(
      'credit_profiles_hold_reason',
      sql`(${table.status} = 'on_hold') = (${table.holdReason} is not null)`,
    ),
    check(
      'credit_profiles_hold_complete',
      sql`(${table.holdReason} is null) = (${table.heldAt} is null) and (${table.heldAt} is null) = (${table.holdKind} is null) and (${table.heldByMemberId} is not null) = (${table.holdKind} is not distinct from 'manual')`,
    ),
    pgPolicy('credit_profiles_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const creditRequestStatus = pgEnum('credit_request_status', [
  'pending',
  'approved',
  'rejected',
]);

/**
 * A request to give a party credit or change its limit or days, decided by
 * someone with credit:approve. One pending request per party at a time.
 */
export const creditRequests = pgTable(
  'credit_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. CR-000004. */
    number: text('number').notNull(),
    partyId: uuid('party_id').notNull(),
    limitPaise: bigint('limit_paise', { mode: 'number' }).notNull(),
    creditDays: integer('credit_days').notNull(),
    /** The limit and days when the request was made, for the approver. */
    previousLimitPaise: bigint('previous_limit_paise', { mode: 'number' }).notNull(),
    previousCreditDays: integer('previous_credit_days').notNull(),
    /** Why the party should get it. */
    note: text('note'),
    status: creditRequestStatus('status').notNull().default('pending'),
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedByMemberId: uuid('decided_by_member_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** The approver's comment; required to reject. */
    decisionNote: text('decision_note'),
  },
  (table) => [
    unique('credit_requests_organization_number_unique').on(table.organizationId, table.number),
    uniqueIndex('credit_requests_one_pending_per_party')
      .on(table.partyId)
      .where(sql`${table.status} = 'pending'`),
    index('credit_requests_status_idx').on(table.organizationId, table.status, table.createdAt),
    foreignKey({
      name: 'credit_requests_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_requests_requested_by_fk',
      columns: [table.organizationId, table.requestedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_requests_decided_by_fk',
      columns: [table.organizationId, table.decidedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('credit_requests_limit_positive', sql`${table.limitPaise} > 0`),
    check('credit_requests_days_range', sql`${table.creditDays} between 0 and 365`),
    check(
      'credit_requests_decided_when_decided',
      sql`(${table.status} = 'pending') = (${table.decidedAt} is null and ${table.decidedByMemberId} is null)`,
    ),
    check(
      'credit_requests_rejection_note',
      sql`${table.status} <> 'rejected' or ${table.decisionNote} is not null`,
    ),
    pgPolicy('credit_requests_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A business's credit rules (spec §3.22): up to `normal_up_to_percent` of the
 * limit sells normally, up to `manager_up_to_percent` needs a manager, above
 * that the owner; overdue beyond `hold_after_overdue_days` blocks credit. No
 * row = the defaults.
 */
export const creditRules = pgTable(
  'credit_rules',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    normalUpToPercent: integer('normal_up_to_percent').notNull().default(80),
    managerUpToPercent: integer('manager_up_to_percent').notNull().default(100),
    holdAfterOverdueDays: integer('hold_after_overdue_days').notNull().default(30),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'credit_rules_percent_order',
      sql`0 <= ${table.normalUpToPercent} and ${table.normalUpToPercent} <= ${table.managerUpToPercent} and ${table.managerUpToPercent} <= 1000`,
    ),
    check('credit_rules_hold_days_positive', sql`${table.holdAfterOverdueDays} >= 1`),
    pgPolicy('credit_rules_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A business's loyalty programme (roadmap P1-M26): `earn_points` points for
 * every `earn_per_paise` of purchases, optional tiers by points earned, and
 * points that expire after `expiry_days` (null = never). No row = the defaults.
 */
export const loyaltySettings = pgTable(
  'loyalty_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    earnPoints: integer('earn_points').notNull().default(1),
    earnPerPaise: bigint('earn_per_paise', { mode: 'number' }).notNull().default(10_000),
    /** [{ name, minPoints }], by lifetime points earned, lowest first. */
    tiers: jsonb('tiers').$type<{ name: string; minPoints: number }[]>().notNull().default([]),
    expiryDays: integer('expiry_days'),
    minRedemptionPoints: integer('min_redemption_points').notNull().default(0),
    /** What one point is worth in paise when paid out (brand profitability's loyalty cost). */
    pointValuePaise: integer('point_value_paise').notNull().default(100),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'loyalty_settings_earn_positive',
      sql`${table.earnPoints} > 0 and ${table.earnPerPaise} > 0`,
    ),
    check('loyalty_settings_expiry_positive', sql`${table.expiryDays} > 0`),
    check('loyalty_settings_min_redemption', sql`${table.minRedemptionPoints} >= 0`),
    check('loyalty_settings_point_value', sql`${table.pointValuePaise} >= 0`),
    check('loyalty_settings_tiers_array', sql`jsonb_typeof(${table.tiers}) = 'array'`),
    pgPolicy('loyalty_settings_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const loyaltyStatus = pgEnum('loyalty_status', ['active', 'closed']);

/**
 * A party's loyalty account, typically a painter or contractor. Its points
 * balance is never stored: it is the sum of its ledger entries.
 */
export const loyaltyAccounts = pgTable(
  'loyalty_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    status: loyaltyStatus('status').notNull().default('active'),
    /** The salesperson who looks after the party; told when it reaches a new tier. */
    assignedMemberId: uuid('assigned_member_id'),
    /** The day (in India) the expiry job last checked this account. */
    expiryCheckedOn: date('expiry_checked_on', { mode: 'string' }),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('loyalty_accounts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('loyalty_accounts_party_unique').on(table.partyId),
    foreignKey({
      name: 'loyalty_accounts_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loyalty_accounts_assigned_member_fk',
      columns: [table.organizationId, table.assignedMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loyalty_accounts_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    pgPolicy('loyalty_accounts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Why points moved: a purchase recorded by hand (until billing exists), a
 * manual or campaign award, a redemption, an adjustment with a reason, expiry
 * of unused points, or points the influencer (painter) of an invoice earned by
 * the earn rules (P2-M36).
 */
export const loyaltyEntryKind = pgEnum('loyalty_entry_kind', [
  'purchase',
  'award',
  'campaign',
  'redeem',
  'adjust',
  'expire',
  'influencer',
]);

/**
 * The points ledger: append-only (a trigger refuses changes and deletes). Each
 * entry that adds points is a lot that expires on `expires_on`; points are used
 * soonest-expiring first.
 */
export const loyaltyLedger = pgTable(
  'loyalty_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    accountId: uuid('account_id').notNull(),
    kind: loyaltyEntryKind('kind').notNull(),
    /** Positive adds points, negative takes them away. */
    points: integer('points').notNull(),
    /** The purchase the points were earned on, entered by hand until billing exists. */
    manualPurchasePaise: bigint('manual_purchase_paise', { mode: 'number' }),
    /**
     * After go-live (spec §4.7): the invoice a purchase was earned on, or the
     * credit note or cancelled invoice an adjustment takes points back for.
     */
    taxDocumentId: uuid('tax_document_id'),
    /** Bill number for a purchase, campaign name for a campaign award. */
    reference: text('reference'),
    /** What it was for; the reason, for an adjustment. */
    note: text('note'),
    expiresOn: date('expires_on', { mode: 'string' }),
    /** Null for points expired by the system. */
    createdByMemberId: uuid('created_by_member_id'),
    /** Clock time, not transaction time, so entries written together keep their order. */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('loyalty_ledger_account_idx').on(table.organizationId, table.accountId, table.createdAt),
    index('loyalty_ledger_expiry_idx')
      .on(table.expiresOn)
      .where(sql`${table.expiresOn} is not null`),
    foreignKey({
      name: 'loyalty_ledger_account_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [loyaltyAccounts.organizationId, loyaltyAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loyalty_ledger_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'loyalty_ledger_points_sign',
      sql`case ${table.kind}
        when 'redeem' then ${table.points} < 0
        when 'expire' then ${table.points} < 0
        when 'adjust' then ${table.points} <> 0
        else ${table.points} > 0 end`,
    ),
    // `kind::text` where a rule names 'influencer': a value added to an enum cannot
    // be cast to in the transaction that adds it, and migrations run in one.
    check(
      'loyalty_ledger_purchase',
      sql`(${table.kind} <> 'purchase' or num_nonnulls(${table.manualPurchasePaise}, ${table.taxDocumentId}) = 1)
        and (${table.manualPurchasePaise} is null or (${table.kind} = 'purchase' and ${table.manualPurchasePaise} > 0))
        and (${table.taxDocumentId} is null or ${table.kind}::text in ('purchase', 'adjust', 'influencer'))`,
    ),
    // Influencer points always name the invoice they were earned on.
    check(
      'loyalty_ledger_influencer',
      sql`${table.kind}::text <> 'influencer' or ${table.taxDocumentId} is not null`,
    ),
    // One purchase entry per invoice: issuing never earns twice.
    uniqueIndex('loyalty_ledger_invoice_purchase_unique')
      .on(table.taxDocumentId)
      .where(sql`${table.kind} = 'purchase' and ${table.taxDocumentId} is not null`),
    // Nor does it earn its influencer twice. An index predicate must be immutable,
    // which `kind::text` is not: migration 0072 defines loyalty_is_influencer().
    uniqueIndex('loyalty_ledger_invoice_influencer_unique')
      .on(table.taxDocumentId)
      .where(sql`loyalty_is_influencer(${table.kind})`),
    index('loyalty_ledger_tax_document_idx')
      .on(table.organizationId, table.taxDocumentId)
      .where(sql`${table.taxDocumentId} is not null`),
    foreignKey({
      name: 'loyalty_ledger_tax_document_fk',
      columns: [table.organizationId, table.taxDocumentId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('restrict'),
    check(
      'loyalty_ledger_reference',
      sql`${table.kind}::text not in ('purchase', 'campaign', 'influencer') or ${table.reference} is not null`,
    ),
    check(
      'loyalty_ledger_adjust_reason',
      sql`${table.kind} <> 'adjust' or ${table.note} is not null`,
    ),
    check('loyalty_ledger_expiry_on_lots', sql`${table.expiresOn} is null or ${table.points} > 0`),
    check(
      'loyalty_ledger_system_expiry',
      sql`(${table.kind} = 'expire') = (${table.createdByMemberId} is null)`,
    ),
    pgPolicy('loyalty_ledger_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What an earn rule counts: taxable value (₹) or litres of paint. */
export const loyaltyEarnBasis = pgEnum('loyalty_earn_basis', ['value', 'litre']);

/**
 * How the influencer (painter or contractor) of an invoice earns points (P2-M36,
 * docs/mvp-3/credit-and-receivables.md §6.5): `points` for every `per_paise` of
 * a line's taxable value, or for every `per_millilitres` of paint on it, times
 * `multiplier_bps` ÷ 10,000. A rule with a brand applies to that brand's lines
 * only; one without applies to every line. The best matching active rule per
 * line wins (the earning code decides "best"). Audited.
 */
export const loyaltyEarnRules = pgTable(
  'loyalty_earn_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    basis: loyaltyEarnBasis('basis').notNull(),
    points: integer('points').notNull(),
    /** Value basis: points per this many paise of taxable value (10,000 = per ₹100). */
    perPaise: bigint('per_paise', { mode: 'number' }),
    /** Litre basis: points per this many millilitres (1,000 = per litre). */
    perMillilitres: integer('per_millilitres'),
    /** Only lines of this brand; null = every brand. */
    brandId: uuid('brand_id'),
    /** Basis points: 10,000 = ×1, 20,000 = ×2 (a brand's double points). */
    multiplierBps: integer('multiplier_bps').notNull().default(10_000),
    /** India dates the rule applies on (by invoice date); null = open-ended. */
    validFrom: date('valid_from', { mode: 'string' }),
    validUntil: date('valid_until', { mode: 'string' }),
    isActive: boolean('is_active').notNull().default(true),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('loyalty_earn_rules_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('loyalty_earn_rules_organization_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    index('loyalty_earn_rules_brand_idx').on(table.organizationId, table.brandId),
    foreignKey({
      name: 'loyalty_earn_rules_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'loyalty_earn_rules_brand_fk',
      columns: [table.organizationId, table.brandId],
      foreignColumns: [brands.organizationId, brands.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loyalty_earn_rules_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'loyalty_earn_rules_name',
      sql`${table.name} = btrim(${table.name}) and char_length(${table.name}) between 1 and 100`,
    ),
    check('loyalty_earn_rules_points_positive', sql`${table.points} > 0`),
    check(
      'loyalty_earn_rules_basis',
      sql`(${table.basis} = 'value') = (${table.perPaise} is not null)
        and (${table.basis} = 'litre') = (${table.perMillilitres} is not null)
        and (${table.perPaise} is null or ${table.perPaise} > 0)
        and (${table.perMillilitres} is null or ${table.perMillilitres} > 0)`,
    ),
    check('loyalty_earn_rules_multiplier', sql`${table.multiplierBps} between 1 and 1000000`),
    check(
      'loyalty_earn_rules_period',
      sql`${table.validFrom} is null or ${table.validUntil} is null or ${table.validFrom} <= ${table.validUntil}`,
    ),
    pgPolicy('loyalty_earn_rules_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A business's look (white-label): the choices validated and normalised by
 * validateBranding in @paint/shared, from which the web app derives its theme.
 * No row = the product's default look.
 */
export const organizationBranding = pgTable(
  'organization_branding',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    branding: jsonb('branding').$type<Record<string, string>>().notNull(),
    updatedByMemberId: uuid('updated_by_member_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'organization_branding_updated_by_fk',
      columns: [table.organizationId, table.updatedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('organization_branding_object', sql`jsonb_typeof(${table.branding}) = 'object'`),
    pgPolicy('organization_branding_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A business's logo (white-label): a PNG, JPEG or WebP checked from its bytes and
 * scanned like documents, stored in S3 under `<organization>/branding/logo-<id>`.
 * Served through the API, never from S3 directly. No row = no logo; replacing or
 * removing it keeps the old file for the audit trail.
 */
export const organizationLogos = pgTable(
  'organization_logos',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Also the logo's version in its address, so browsers can keep it for good. */
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    uploadedByMemberId: uuid('uploaded_by_member_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'organization_logos_uploaded_by_fk',
      columns: [table.organizationId, table.uploadedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'organization_logos_content_type',
      sql`${table.contentType} in ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check('organization_logos_sha256', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'organization_logos_dimensions',
      sql`${table.width} > 0 and ${table.height} > 0 and ${table.sizeBytes} > 0`,
    ),
    pgPolicy('organization_logos_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const auditAction = pgEnum('audit_action', ['insert', 'update', 'delete']);

/**
 * Who changed what and when, with old and new values (roadmap P1-M20).
 * Written only by the audit_row_change() trigger on sensitive tables, never by
 * the application, and never changed afterwards.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid('organization_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** The signed-in member who made the change; null for system work. */
    actorMemberId: uuid('actor_member_id'),
    tableName: text('table_name').notNull(),
    recordId: text('record_id').notNull(),
    action: auditAction('action').notNull(),
    /** The watched columns before the change (null for inserts). */
    oldValues: jsonb('old_values'),
    /** The watched columns after the change (null for deletes). */
    newValues: jsonb('new_values'),
  },
  (table) => [
    index('audit_log_organization_time_idx').on(table.organizationId, table.occurredAt),
    index('audit_log_record_idx').on(table.organizationId, table.tableName, table.recordId),
    pgPolicy('audit_log_tenant_read', {
      for: 'select',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** The SaaS operator's own staff (roadmap P1-M23). Outside every tenant. */
export const platformAdmins = pgTable('platform_admins', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Row-level security with no tenant policy: tenants can never see a row.
}).enableRLS();

/** Sign-ins to the platform console; separate from tenant sessions. */
export const platformSessions = pgTable('platform_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}).enableRLS();

/**
 * Access to a business for the platform's support staff: asked for with a
 * reason, approved (or declined) by the business, time-limited, and ended
 * early by either side.
 */
export const supportGrants = pgTable(
  'support_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platformUserId: uuid('platform_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Kept on the grant: the business cannot see platform staff's accounts. */
    requestedByName: text('requested_by_name').notNull().default(''),
    reason: text('reason').notNull(),
    /** How long access lasts once approved. */
    minutes: integer('minutes').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedByMemberId: uuid('decided_by_member_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('support_grants_organization_idx').on(table.organizationId, table.requestedAt),
    foreignKey({
      name: 'support_grants_decided_by_fk',
      columns: [table.organizationId, table.decidedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('support_grants_minutes_range', sql`${table.minutes} between 15 and 480`),
    check(
      'support_grants_one_decision',
      sql`not (${table.approvedAt} is not null and ${table.declinedAt} is not null)`,
    ),
    check(
      'support_grants_expiry_when_approved',
      sql`(${table.approvedAt} is null) = (${table.expiresAt} is null)`,
    ),
    pgPolicy('support_grants_tenant_read', {
      for: 'select',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
    pgPolicy('support_grants_tenant_decide', {
      for: 'update',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Every request made with support access, for the business to review. */
export const supportAccessLog = pgTable(
  'support_access_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid('organization_id').notNull(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => supportGrants.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    method: text('method').notNull(),
    path: text('path').notNull(),
  },
  (table) => [
    index('support_access_log_grant_idx').on(table.grantId, table.occurredAt),
    pgPolicy('support_access_log_tenant_read', {
      for: 'select',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Sales tax documents (MVP 2, Sell & Bill; spec docs/mvp-2/sell-and-bill.md §3).
// ---------------------------------------------------------------------------

/** Aggregate annual turnover band of a GSTIN: decides HSN digits (§2.7). */
export const aatoBand = pgEnum('aato_band', ['up_to_5cr', 'above_5cr']);

/**
 * Per-GSTIN settings beyond the store registration: turnover band, the date
 * e-invoicing (IRN) became mandatory, and the e-way bill threshold. No row = the
 * defaults (up to ₹5 crore, no e-invoicing, ₹50,000).
 */
export const gstinProfiles = pgTable(
  'gstin_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    gstin: text('gstin').notNull(),
    aatoBand: aatoBand('aato_band').notNull().default('up_to_5cr'),
    /** From this India date, B2B documents need an IRN (Rule 48(4)). */
    einvoiceRequiredFrom: date('einvoice_required_from', { mode: 'string' }),
    ewayThresholdPaise: bigint('eway_threshold_paise', { mode: 'number' })
      .notNull()
      .default(5_000_000),
    ...timestamps,
  },
  (table) => [
    unique('gstin_profiles_organization_gstin_unique').on(table.organizationId, table.gstin),
    check(
      'gstin_profiles_gstin_format',
      sql`${table.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
    ),
    check('gstin_profiles_eway_threshold_positive', sql`${table.ewayThresholdPaise} > 0`),
    pgPolicy('gstin_profiles_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** When stock leaves on an order invoice: at issue, or at dispatch (§4.2). */
export const stockPostOn = pgEnum('stock_post_on', ['invoice', 'dispatch']);
/** Whether unit prices include GST (counter prices) or have it added. */
export const priceMode = pgEnum('price_mode', ['inclusive', 'exclusive']);

/**
 * What a payment link asks for (P2-M32, [PO-43]): what is owed net of the party's advance
 * (`net`: a statement's balance and its link agree) or the bills' full outstanding.
 */
export const paymentLinkAmountBasis = pgEnum('payment_link_amount_basis', ['net', 'full']);

/** A business's selling settings. No row = the defaults. */
export const salesSettings = pgTable(
  'sales_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stockPostOn: stockPostOn('stock_post_on').notNull().default('invoice'),
    /** The party walk-in sales are billed to; created on the first walk-in bill. */
    walkInPartyId: uuid('walk_in_party_id'),
    quoteValidityDays: integer('quote_validity_days').notNull().default(15),
    partialMinAdvancePct: integer('partial_min_advance_pct').notNull().default(0),
    defaultPriceMode: priceMode('default_price_mode').notNull().default('inclusive'),
    /** The day the business started billing here (cut-over from MVP 1 figures, §4.7). */
    billingLiveOn: date('billing_live_on', { mode: 'string' }),
    /** Millilitres in one "shot" and one "Y" of the tinting machine (round 8a); null: not set. */
    tintShotMl: numeric('tint_shot_ml', { precision: 7, scale: 4, mode: 'number' }),
    tintYMl: numeric('tint_y_ml', { precision: 7, scale: 4, mode: 'number' }),
    /** Days without a sale or transfer out before stock is announced as slow; null: no alert. */
    slowMoverAlertDays: integer('slow_mover_alert_days').$type<45 | 90 | 180 | 365>().default(90),
    /** What bringing stock from another store costs (a delivery boy, a trip); null: not set. */
    storeDeliveryCostPaise: bigint('store_delivery_cost_paise', { mode: 'number' }),
    /** Cash is taken only into an open register session ([PO-11]: yes for cash). */
    cashNeedsRegister: boolean('cash_needs_register').notNull().default(true),
    /** A register closing further off than this tells the branch managers (spec §5.5). */
    registerVarianceAlertPaise: bigint('register_variance_alert_paise', { mode: 'number' })
      .notNull()
      .default(0),
    // Printed on the A4 invoice (spec §5.4): the four bank fields together or none.
    bankName: text('bank_name'),
    bankAccountName: text('bank_account_name'),
    bankAccountNumber: text('bank_account_number'),
    bankIfsc: text('bank_ifsc'),
    /** Printed under the bank details, so only with them. */
    upiId: text('upi_id'),
    /** Terms and conditions printed on every invoice, in order. */
    invoiceTerms: text('invoice_terms')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Minutes a UPI payment link stays payable ([PO-41]: 10 by default). */
    paymentLinkValidityMinutes: integer('payment_link_validity_minutes').notNull().default(10),
    /** Minutes a link sent in a message stays payable ([PO-61]: a day by default). */
    messageLinkValidityMinutes: integer('message_link_validity_minutes').notNull().default(1440),
    /** The most one payment link may ask for ([PO-42]: ₹1,00,000 by default). */
    paymentLinkCapPaise: bigint('payment_link_cap_paise', { mode: 'number' })
      .notNull()
      .default(10_000_000),
    /** Links ask for what is owed net of the advance, or the bills' full outstanding ([PO-43]). */
    paymentLinkAmountBasis: paymentLinkAmountBasis('payment_link_amount_basis')
      .notNull()
      .default('net'),
    /** The business's cost of money a year, basis points ([PO-5]; brand profitability's credit cost). */
    costOfMoneyBps: integer('cost_of_money_bps').notNull().default(1200),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'sales_settings_walk_in_party_fk',
      columns: [table.organizationId, table.walkInPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    check('sales_settings_quote_validity', sql`${table.quoteValidityDays} between 1 and 365`),
    check('sales_settings_advance_pct', sql`${table.partialMinAdvancePct} between 0 and 100`),
    check('sales_settings_variance_alert', sql`${table.registerVarianceAlertPaise} >= 0`),
    // The windows the Slow movers screen offers.
    check('sales_settings_slow_mover_days', sql`${table.slowMoverAlertDays} in (45, 90, 180, 365)`),
    check(
      'sales_settings_store_delivery_cost',
      sql`${table.storeDeliveryCostPaise} between 0 and 10000000`,
    ),
    check(
      'sales_settings_tint_units_positive',
      sql`${table.tintShotMl} > 0 and ${table.tintYMl} > 0`,
    ),
    check(
      'sales_settings_bank_complete',
      sql`num_nonnulls(${table.bankName}, ${table.bankAccountName}, ${table.bankAccountNumber}, ${table.bankIfsc}) in (0, 4)`,
    ),
    check(
      'sales_settings_upi_with_bank',
      sql`${table.upiId} is null or ${table.bankName} is not null`,
    ),
    check('sales_settings_invoice_terms', sql`cardinality(${table.invoiceTerms}) <= 10`),
    check('sales_settings_cost_of_money', sql`${table.costOfMoneyBps} between 0 and 10000`),
    check(
      'sales_settings_payment_links',
      sql`${table.paymentLinkValidityMinutes} between 5 and 43200
        and ${table.paymentLinkCapPaise} between 100 and 50000000`,
    ),
    check(
      'sales_settings_message_link_validity',
      sql`${table.messageLinkValidityMinutes} between 5 and 43200`,
    ),
    pgPolicy('sales_settings_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** The kinds of GST document; each is numbered in its own series. */
export const taxDocumentKind = pgEnum('tax_document_kind', [
  'invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note',
  'receipt_voucher',
  'refund_voucher',
]);

/**
 * How a store numbers one kind of document: `PREFIX/26-27/000123`, at most 16
 * characters (Rule 46(b)). One active series per store and kind.
 */
export const documentSeries = pgTable(
  'document_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    kind: taxDocumentKind('kind').notNull(),
    prefix: text('prefix').notNull(),
    digits: integer('digits').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('document_series_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('document_series_one_active')
      .on(table.storeId, table.kind)
      .where(sql`${table.isActive}`),
    foreignKey({
      name: 'document_series_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    check('document_series_prefix_format', sql`${table.prefix} ~ '^[A-Z0-9]+$'`),
    check(
      'document_series_length',
      sql`${table.digits} >= 1 and char_length(${table.prefix}) + 7 + ${table.digits} <= 16`,
    ),
    pgPolicy('document_series_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const taxDocumentStatus = pgEnum('tax_document_status', ['draft', 'issued', 'cancelled']);
/** A line's GST nature: a 0% rate is nil-rated or exempt, and the two are reported apart. */
export const taxNature = pgEnum('tax_nature', ['taxable', 'nil_rated', 'exempt', 'non_gst']);
export const supplyType = pgEnum('supply_type', ['intra_state', 'inter_state']);
/** GSTR-1 table a sale is reported in (Rule 59(4)). */
export const gstClass = pgEnum('gst_class', ['b2b', 'b2cl', 'b2cs']);
export const stockPosting = pgEnum('stock_posting', ['on_issue', 'on_dispatch', 'none']);
/** B2B credit notes after 1 Oct 2025: has the buyer reversed the input credit? (s.34(2)) */
export const itcReversalStatus = pgEnum('itc_reversal_status', [
  'unknown',
  'reversed',
  'not_reversed',
]);

/**
 * A GST document: tax invoice, bill of supply, credit or debit note, receipt
 * or refund voucher. Drafts change freely; once issued only the changes
 * allowed by tax_documents_immutable (migration 0055) are possible.
 */
export const taxDocuments = pgTable(
  'tax_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    kind: taxDocumentKind('kind').notNull(),
    status: taxDocumentStatus('status').notNull().default('draft'),
    storeId: uuid('store_id').notNull(),
    seriesId: uuid('series_id'),
    /** e.g. AMP/26-27/000123; null while a draft. */
    number: text('number'),
    /** Financial year, e.g. 2026-27. */
    fy: text('fy'),
    issuedOn: date('issued_on', { mode: 'string' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    // Supplier snapshot, taken at issue.
    supplierGstin: text('supplier_gstin'),
    supplierStateCode: text('supplier_state_code'),
    supplierLegalName: text('supplier_legal_name'),
    supplierTradeName: text('supplier_trade_name'),
    supplierAddress: text('supplier_address'),
    // Buyer: the party, plus details typed on the bill; completed from the party at issue.
    partyId: uuid('party_id'),
    buyerName: text('buyer_name'),
    buyerGstin: text('buyer_gstin'),
    buyerAddress: text('buyer_address'),
    buyerStateCode: text('buyer_state_code'),
    // Ship-to: set when we move the goods (delivery); its state is then the place of supply for B2C.
    shipToName: text('ship_to_name'),
    shipToAddress: text('ship_to_address'),
    shipToStateCode: text('ship_to_state_code'),
    placeOfSupplyCode: text('place_of_supply_code'),
    supplyType: supplyType('supply_type'),
    gstClass: gstClass('gst_class'),
    priceMode: priceMode('price_mode').notNull().default('inclusive'),
    reverseCharge: boolean('reverse_charge').notNull().default(false),
    billDiscountBps: integer('bill_discount_bps'),
    billDiscountPaise: bigint('bill_discount_paise', { mode: 'number' }),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull().default(0),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),
    roundOffPaise: bigint('round_off_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    dueOn: date('due_on', { mode: 'string' }),
    projectId: uuid('project_id'),
    influencerPartyId: uuid('influencer_party_id'),
    /** Why a note was raised; free text on an invoice. */
    reason: text('reason'),
    note: text('note'),
    /** A discount credit note's scheme (the brand's or ours), e.g. "Diwali 2026" (round 3c). */
    schemeReference: text('scheme_reference'),
    /** The sales order an invoice bills (round 4a); its lines carry the order lines. */
    salesOrderId: uuid('sales_order_id'),
    /** checkCredit's figures when an invoice was issued on credit (P2-M09). */
    creditCheck: jsonb('credit_check').$type<Record<string, unknown>>(),
    /** The approval that let it be issued past the credit rules (P2-M09). */
    creditApprovalId: uuid('credit_approval_id'),
    stockPosting: stockPosting('stock_posting').notNull().default('on_issue'),
    itcReversalStatus: itcReversalStatus('itc_reversal_status'),
    // E-invoice (Release 2.3; entered by hand from the government portal until then).
    irn: text('irn'),
    ackNo: text('ack_no'),
    ackAt: timestamp('ack_at', { withTimezone: true }),
    signedQr: text('signed_qr'),
    cancelReason: text('cancel_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByMemberId: uuid('cancelled_by_member_id'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    issuedByMemberId: uuid('issued_by_member_id'),
    ...timestamps,
  },
  (table): PgTableExtraConfigValue[] => [
    unique('tax_documents_organization_id_id_unique').on(table.organizationId, table.id),
    // Lets an allocation point at a document of its own party only (round 3a).
    unique('tax_documents_organization_id_party_unique').on(
      table.organizationId,
      table.id,
      table.partyId,
    ),
    // Rule 46(b): unique per GSTIN and financial year (drafts have no number).
    unique('tax_documents_number_unique').on(
      table.organizationId,
      table.supplierGstin,
      table.fy,
      table.kind,
      table.number,
    ),
    index('tax_documents_store_issued_idx').on(
      table.organizationId,
      table.storeId,
      table.issuedOn.desc().nullsFirst(),
    ),
    index('tax_documents_party_idx').on(table.organizationId, table.partyId),
    // Newest first at one store (GET /invoices?storeId=, a branch manager's list).
    index('tax_documents_store_created_idx').on(
      table.organizationId,
      table.storeId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // Newest first (GET /invoices); NULLS FIRST matches ORDER BY ... DESC.
    index('tax_documents_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'tax_documents_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_series_fk',
      columns: [table.organizationId, table.seriesId],
      foreignColumns: [documentSeries.organizationId, documentSeries.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_influencer_fk',
      columns: [table.organizationId, table.influencerPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_issued_by_fk',
      columns: [table.organizationId, table.issuedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    index('tax_documents_sales_order_idx')
      .on(table.organizationId, table.salesOrderId)
      .where(sql`${table.salesOrderId} is not null`),
    foreignKey({
      name: 'tax_documents_sales_order_fk',
      columns: [table.organizationId, table.salesOrderId],
      foreignColumns: [salesOrders.organizationId, salesOrders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_credit_approval_fk',
      columns: [table.organizationId, table.creditApprovalId],
      foreignColumns: [creditApprovals.organizationId, creditApprovals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_documents_cancelled_by_fk',
      columns: [table.organizationId, table.cancelledByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    // Everything an issued document must carry, and nothing a draft may.
    check(
      'tax_documents_issued_complete',
      sql`(${table.status} = 'draft') = (${table.number} is null)
        and (${table.status} = 'draft') = (${table.fy} is null)
        and (${table.status} = 'draft') = (${table.issuedOn} is null)
        and (${table.status} = 'draft') = (${table.issuedAt} is null)
        and (${table.status} = 'draft') = (${table.seriesId} is null)
        and (${table.status} = 'draft') = (${table.supplierGstin} is null)
        and (${table.status} = 'draft') = (${table.issuedByMemberId} is null)
        and (${table.status} = 'draft') = (${table.supplyType} is null)
        and (${table.status} = 'draft') = (${table.placeOfSupplyCode} is null)
        and (${table.status} = 'draft') = (${table.gstClass} is null)`,
    ),
    check(
      'tax_documents_number_format',
      sql`${table.number} ~ '^[A-Z0-9/-]{1,16}$' and ${table.fy} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
    check(
      'tax_documents_cancelled',
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} is not null)
        and (${table.cancelledAt} is null) = (${table.cancelReason} is null)
        and (${table.cancelledAt} is null) = (${table.cancelledByMemberId} is null)`,
    ),
    check(
      'tax_documents_total',
      sql`${table.totalPaise} = ${table.taxablePaise} + ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise} + ${table.cessPaise} + ${table.roundOffPaise}`,
    ),
    check(
      'tax_documents_amounts_not_negative',
      sql`${table.taxablePaise} >= 0 and ${table.cgstPaise} >= 0 and ${table.sgstPaise} >= 0 and ${table.igstPaise} >= 0 and ${table.cessPaise} >= 0 and ${table.totalPaise} >= 0`,
    ),
    check('tax_documents_round_off', sql`${table.roundOffPaise} between -50 and 50`),
    check(
      'tax_documents_tax_by_supply',
      sql`case ${table.supplyType}
        when 'intra_state' then ${table.igstPaise} = 0 and ${table.cgstPaise} = ${table.sgstPaise}
        when 'inter_state' then ${table.cgstPaise} = 0 and ${table.sgstPaise} = 0
        else true end`,
    ),
    check(
      'tax_documents_bill_of_supply_untaxed',
      sql`${table.kind} <> 'bill_of_supply' or ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise} + ${table.cessPaise} = 0`,
    ),
    check(
      'tax_documents_one_bill_discount',
      sql`${table.billDiscountBps} is null or ${table.billDiscountPaise} is null`,
    ),
    check(
      'tax_documents_bill_discount_range',
      sql`${table.billDiscountBps} between 0 and 10000 and ${table.billDiscountPaise} >= 0`,
    ),
    check('tax_documents_no_reverse_charge', sql`not ${table.reverseCharge}`),
    check(
      'tax_documents_state_codes',
      sql`${table.buyerStateCode} ~ '^[0-9]{2}$' and ${table.shipToStateCode} ~ '^[0-9]{2}$' and ${table.placeOfSupplyCode} ~ '^[0-9]{2}$' and ${table.supplierStateCode} ~ '^[0-9]{2}$'`,
    ),
    check(
      'tax_documents_buyer_gstin_format',
      sql`${table.buyerGstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
    ),
    check('tax_documents_irn_with_ack', sql`${table.irn} is null or ${table.ackNo} is not null`),
    pgPolicy('tax_documents_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A line of a tax document. Description, HSN, unit, rate and amounts are a
 * snapshot taken at issue, so later product or rate changes never alter it.
 */
export const taxDocumentLines = pgTable(
  'tax_document_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    lineNo: integer('line_no').notNull(),
    variantId: uuid('variant_id').notNull(),
    description: text('description'),
    hsnCode: text('hsn_code'),
    /** GSTN unit quantity code, e.g. LTR. */
    uqc: text('uqc'),
    quantity: numeric('quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    discountBps: integer('discount_bps'),
    discountPaise: bigint('discount_paise', { mode: 'number' }),
    grossPaise: bigint('gross_paise', { mode: 'number' }).notNull().default(0),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull().default(0),
    taxCategoryId: uuid('tax_category_id'),
    /** Null on a bill of supply (no tax) and on drafts. */
    rateBps: integer('rate_bps'),
    /** The rate's nature, as issue decided it; null exactly when the rate is. */
    taxNature: taxNature('tax_nature'),
    cessBps: integer('cess_bps'),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    /** On a note: the invoice line it corrects. */
    sourceLineId: uuid('source_line_id'),
    /** On an invoice from an order: the order line it bills. */
    orderLineId: uuid('order_line_id'),
  },
  (table) => [
    unique('tax_document_lines_organization_id_id_unique').on(table.organizationId, table.id),
    unique('tax_document_lines_document_line_unique').on(table.documentId, table.lineNo),
    index('tax_document_lines_variant_idx').on(table.organizationId, table.variantId),
    foreignKey({
      name: 'tax_document_lines_document_fk',
      columns: [table.organizationId, table.documentId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tax_document_lines_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_document_lines_tax_category_fk',
      columns: [table.organizationId, table.taxCategoryId],
      foreignColumns: [taxCategories.organizationId, taxCategories.id],
    }).onDelete('restrict'),
    index('tax_document_lines_order_line_idx')
      .on(table.organizationId, table.orderLineId)
      .where(sql`${table.orderLineId} is not null`),
    foreignKey({
      name: 'tax_document_lines_order_line_fk',
      columns: [table.organizationId, table.orderLineId],
      foreignColumns: [salesOrderLines.organizationId, salesOrderLines.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_document_lines_source_line_fk',
      columns: [table.organizationId, table.sourceLineId],
      foreignColumns: [table.organizationId, table.id],
    }).onDelete('restrict'),
    check('tax_document_lines_line_no_positive', sql`${table.lineNo} > 0`),
    check('tax_document_lines_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'tax_document_lines_nature_with_rate',
      sql`(${table.taxNature} is null) = (${table.rateBps} is null)`,
    ),
    check(
      'tax_document_lines_amounts',
      sql`${table.unitPricePaise} >= 0 and ${table.grossPaise} >= 0 and ${table.taxablePaise} >= 0
        and ${table.cgstPaise} >= 0 and ${table.sgstPaise} >= 0 and ${table.igstPaise} >= 0 and ${table.cessPaise} >= 0
        and ${table.totalPaise} = ${table.taxablePaise} + ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise} + ${table.cessPaise}`,
    ),
    check(
      'tax_document_lines_one_discount',
      sql`(${table.discountBps} is null or ${table.discountPaise} is null)
        and ${table.discountBps} between 0 and 10000 and ${table.discountPaise} >= 0`,
    ),
    check('tax_document_lines_rate_range', sql`${table.rateBps} between 0 and 10000`),
    check('tax_document_lines_hsn_format', sql`${table.hsnCode} ~ '^[0-9]{4}([0-9]{2}){0,2}$'`),
    pgPolicy('tax_document_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Taxable value and tax per HSN code and rate, as printed; GSTR-1 and Tally read these. */
export const taxDocumentTaxRows = pgTable(
  'tax_document_tax_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    hsnCode: text('hsn_code').notNull(),
    rateBps: integer('rate_bps').notNull(),
    cessBps: integer('cess_bps').notNull().default(0),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull(),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull(),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull(),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('tax_document_tax_rows_unique').on(
      table.documentId,
      table.hsnCode,
      table.rateBps,
      table.cessBps,
    ),
    foreignKey({
      name: 'tax_document_tax_rows_document_fk',
      columns: [table.organizationId, table.documentId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('cascade'),
    check(
      'tax_document_tax_rows_amounts',
      sql`${table.taxablePaise} >= 0 and ${table.cgstPaise} >= 0 and ${table.sgstPaise} >= 0 and ${table.igstPaise} >= 0 and ${table.cessPaise} >= 0`,
    ),
    pgPolicy('tax_document_tax_rows_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const taxDocumentLinkKind = pgEnum('tax_document_link_kind', [
  'note_of',
  'advance_adjusted_in',
  'replaces',
]);

/** How documents relate: a note to its invoices, an advance to the invoice using it. */
export const taxDocumentLinks = pgTable(
  'tax_document_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    fromDocumentId: uuid('from_document_id').notNull(),
    toDocumentId: uuid('to_document_id').notNull(),
    kind: taxDocumentLinkKind('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tax_document_links_unique').on(table.fromDocumentId, table.toDocumentId, table.kind),
    index('tax_document_links_to_idx').on(table.organizationId, table.toDocumentId),
    foreignKey({
      name: 'tax_document_links_from_fk',
      columns: [table.organizationId, table.fromDocumentId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tax_document_links_to_fk',
      columns: [table.organizationId, table.toDocumentId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('restrict'),
    check('tax_document_links_not_self', sql`${table.fromDocumentId} <> ${table.toDocumentId}`),
    pgPolicy('tax_document_links_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const salesReturnStatus = pgEnum('sales_return_status', ['draft', 'completed']);
export const returnDisposition = pgEnum('return_disposition', ['restock', 'damage']);

/** Goods brought back against an invoice; completing it issues the credit note (Release 2.0 round 3). */
export const salesReturns = pgTable(
  'sales_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** e.g. SR-000004; set on completion. */
    number: text('number'),
    invoiceId: uuid('invoice_id').notNull(),
    storeId: uuid('store_id').notNull(),
    status: salesReturnStatus('status').notNull().default('draft'),
    creditNoteId: uuid('credit_note_id'),
    note: text('note'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('sales_returns_organization_id_id_unique').on(table.organizationId, table.id),
    unique('sales_returns_organization_number_unique').on(table.organizationId, table.number),
    index('sales_returns_invoice_idx').on(table.organizationId, table.invoiceId),
    foreignKey({
      name: 'sales_returns_invoice_fk',
      columns: [table.organizationId, table.invoiceId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_returns_credit_note_fk',
      columns: [table.organizationId, table.creditNoteId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_returns_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_returns_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'sales_returns_completed',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)
        and (${table.status} = 'completed') = (${table.creditNoteId} is not null)
        and (${table.status} = 'completed') = (${table.number} is not null)`,
    ),
    pgPolicy('sales_returns_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const salesReturnLines = pgTable(
  'sales_return_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    returnId: uuid('return_id').notNull(),
    invoiceLineId: uuid('invoice_line_id').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    disposition: returnDisposition('disposition').notNull(),
    reason: text('reason'),
  },
  (table) => [
    unique('sales_return_lines_return_line_unique').on(
      table.returnId,
      table.invoiceLineId,
      table.disposition,
    ),
    index('sales_return_lines_invoice_line_idx').on(table.organizationId, table.invoiceLineId),
    foreignKey({
      name: 'sales_return_lines_return_fk',
      columns: [table.organizationId, table.returnId],
      foreignColumns: [salesReturns.organizationId, salesReturns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sales_return_lines_invoice_line_fk',
      columns: [table.organizationId, table.invoiceLineId],
      foreignColumns: [taxDocumentLines.organizationId, taxDocumentLines.id],
    }).onDelete('restrict'),
    check('sales_return_lines_quantity_positive', sql`${table.quantity} > 0`),
    pgPolicy('sales_return_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Why a party's balance moved. `cancellation` reverses a same-day cancelled invoice. */
export const partyLedgerEntryType = pgEnum('party_ledger_entry_type', [
  'opening',
  'invoice',
  'debit_note',
  'credit_note',
  'payment_in',
  'refund_out',
  'cheque_bounce',
  'adjustment',
  'cancellation',
]);

/**
 * What each party owes, forever. Append-only (a trigger refuses changes and
 * deletes, migration 0055). Positive = the party owes more. Written only by
 * postPartyLedger, which keeps party_balances in step.
 */
export const partyLedger = pgTable(
  'party_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    storeId: uuid('store_id'),
    /** India business date of the entry. */
    entryOn: date('entry_on', { mode: 'string' }).notNull(),
    entryType: partyLedgerEntryType('entry_type').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    note: text('note'),
    createdByMemberId: uuid('created_by_member_id'),
    /** Clock time, so entries written in one transaction keep their order. */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    // Lets an allocation point at an opening balance or charge of its own party only.
    unique('party_ledger_organization_id_party_unique').on(
      table.organizationId,
      table.id,
      table.partyId,
    ),
    index('party_ledger_party_idx').on(
      table.organizationId,
      table.partyId,
      table.entryOn,
      table.createdAt,
    ),
    // One entry of each type per document: a retried post can never count twice.
    uniqueIndex('party_ledger_reference_unique')
      .on(table.referenceType, table.referenceId, table.entryType)
      .where(sql`${table.referenceId} is not null`),
    foreignKey({
      name: 'party_ledger_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'party_ledger_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'party_ledger_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'party_ledger_amount_sign',
      sql`case
        when ${table.entryType} in ('invoice', 'debit_note', 'refund_out', 'cheque_bounce') then ${table.amountPaise} > 0
        when ${table.entryType} in ('credit_note', 'payment_in', 'cancellation') then ${table.amountPaise} < 0
        else ${table.amountPaise} <> 0
      end`,
    ),
    check(
      'party_ledger_reference_pair',
      sql`(${table.referenceType} is null) = (${table.referenceId} is null)`,
    ),
    pgPolicy('party_ledger_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Each party's balance, kept equal to the sum of its ledger by postPartyLedger. */
export const partyBalances = pgTable(
  'party_balances',
  {
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').primaryKey(),
    balancePaise: bigint('balance_paise', { mode: 'number' }).notNull().default(0),
    /** Payments not yet allocated to a document (Release 2.0 round 3). */
    advancePaise: bigint('advance_paise', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('party_balances_organization_idx').on(table.organizationId),
    foreignKey({
      name: 'party_balances_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    check('party_balances_advance_not_negative', sql`${table.advancePaise} >= 0`),
    pgPolicy('party_balances_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * The first response to each `Idempotency-Key` a member sends, so a retried
 * create or issue returns it instead of acting twice. Kept for 24 hours.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull(),
    key: text('key').notNull(),
    /** SHA-256 of the method, path and body: the same key with another request is refused. */
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('idempotency_keys_member_key_unique').on(
      table.organizationId,
      table.memberId,
      table.key,
    ),
    index('idempotency_keys_created_idx').on(table.createdAt),
    foreignKey({
      name: 'idempotency_keys_member_fk',
      columns: [table.organizationId, table.memberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('cascade'),
    check('idempotency_keys_key_length', sql`char_length(${table.key}) between 1 and 200`),
    pgPolicy('idempotency_keys_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// Payments, allocations and the cash register (Release 2.0 round 3a) --------

export const paymentModeKind = pgEnum('payment_mode_kind', [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
  /** Paid online through a payment link (P2-M32): recorded by the gateway's webhook only. */
  'upi_link',
]);

/** How a business takes money: the five base modes, plus its own (a finance company, a wallet). */
export const paymentModes = pgTable(
  'payment_modes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    kind: paymentModeKind('kind').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('payment_modes_organization_id_id_unique').on(table.organizationId, table.id),
    // A payment snapshots its mode's kind; this key keeps the two equal.
    unique('payment_modes_organization_id_kind_unique').on(
      table.organizationId,
      table.id,
      table.kind,
    ),
    uniqueIndex('payment_modes_name_unique').on(table.organizationId, sql`lower(${table.name})`),
    foreignKey({
      name: 'payment_modes_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    check('payment_modes_name_length', sql`char_length(${table.name}) between 1 and 60`),
    pgPolicy('payment_modes_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const registerSessionStatus = pgEnum('register_session_status', ['open', 'closed']);

/**
 * One cashier's shift at a counter (spec §5.5): opened with a float, closed
 * with the cash counted. One open session per register; immutable once closed
 * (trigger, migration 0058).
 */
export const registerSessions = pgTable(
  'register_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    /** The counter, e.g. COUNTER1. */
    registerCode: text('register_code').notNull(),
    status: registerSessionStatus('status').notNull().default('open'),
    openedByMemberId: uuid('opened_by_member_id').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    openingFloatPaise: bigint('opening_float_paise', { mode: 'number' }).notNull(),
    openingNote: text('opening_note'),
    closedByMemberId: uuid('closed_by_member_id'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Float + cash in − cash out ± movements, fixed at close. */
    expectedCashPaise: bigint('expected_cash_paise', { mode: 'number' }),
    countedCashPaise: bigint('counted_cash_paise', { mode: 'number' }),
    /** Counted − expected: negative when cash is short. */
    variancePaise: bigint('variance_paise', { mode: 'number' }),
    /** How many of each note and coin were counted, keyed by its paise value. */
    denominations: jsonb('denominations').$type<Record<string, number>>(),
    closingNote: text('closing_note'),
    ...timestamps,
  },
  (table) => [
    unique('register_sessions_organization_id_id_unique').on(table.organizationId, table.id),
    // A payment's session must be at the payment's store.
    unique('register_sessions_organization_id_store_unique').on(
      table.organizationId,
      table.id,
      table.storeId,
    ),
    uniqueIndex('register_sessions_one_open')
      .on(table.organizationId, table.storeId, table.registerCode)
      .where(sql`${table.status} = 'open'`),
    index('register_sessions_store_opened_idx').on(
      table.organizationId,
      table.storeId,
      table.openedAt.desc().nullsFirst(),
    ),
    // Newest first across every store (GET /register-sessions without a store).
    index('register_sessions_organization_opened_idx').on(
      table.organizationId,
      table.openedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'register_sessions_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'register_sessions_opened_by_fk',
      columns: [table.organizationId, table.openedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'register_sessions_closed_by_fk',
      columns: [table.organizationId, table.closedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('register_sessions_code_format', sql`${table.registerCode} ~ '^[A-Z0-9-]{1,20}$'`),
    check('register_sessions_float', sql`${table.openingFloatPaise} >= 0`),
    check(
      'register_sessions_closed',
      sql`(${table.status} = 'closed') = (${table.closedAt} is not null)
        and (${table.status} = 'closed') = (${table.closedByMemberId} is not null)
        and (${table.status} = 'closed') = (${table.expectedCashPaise} is not null)
        and (${table.status} = 'closed') = (${table.countedCashPaise} is not null)
        and (${table.status} = 'closed') = (${table.variancePaise} is not null)`,
    ),
    check(
      'register_sessions_variance',
      sql`${table.countedCashPaise} >= 0
        and ${table.variancePaise} = ${table.countedCashPaise} - ${table.expectedCashPaise}`,
    ),
    pgPolicy('register_sessions_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const registerMovementKind = pgEnum('register_movement_kind', [
  'pay_in',
  'pay_out',
  'bank_deposit',
]);

/** Cash into or out of the drawer other than sales and refunds. Insert only, while open. */
export const registerCashMovements = pgTable(
  'register_cash_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    kind: registerMovementKind('kind').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('register_cash_movements_session_idx').on(table.organizationId, table.sessionId),
    foreignKey({
      name: 'register_cash_movements_session_fk',
      columns: [table.organizationId, table.sessionId],
      foreignColumns: [registerSessions.organizationId, registerSessions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'register_cash_movements_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('register_cash_movements_amount_positive', sql`${table.amountPaise} > 0`),
    check(
      'register_cash_movements_reason_length',
      sql`char_length(${table.reason}) between 1 and 200`,
    ),
    pgPolicy('register_cash_movements_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const paymentDirection = pgEnum('payment_direction', ['in', 'out']);
export const chequeStatus = pgEnum('cheque_status', ['pending', 'cleared', 'bounced']);

/**
 * Money received from a party (`in`) or refunded to one (`out`), spec §3.3.
 * Never edited or deleted: the only change is a cheque's status, once, from
 * pending to cleared or bounced (trigger, migration 0058). What it pays is in
 * `allocations`; its ledger entry is written in the same transaction.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    /** RC-000123 (money in) or RF-000012 (refund), gap-free per organisation. */
    number: text('number').notNull(),
    direction: paymentDirection('direction').notNull(),
    partyId: uuid('party_id').notNull(),
    modeId: uuid('mode_id').notNull(),
    /** The mode's kind when paid (kept equal by the foreign key). */
    modeKind: paymentModeKind('mode_kind').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    /** Cash in: what was handed over; the change went back. */
    tenderedPaise: bigint('tendered_paise', { mode: 'number' }),
    /** India business date the money moved. */
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    /** UTR, card slip or cheque number. */
    reference: text('reference'),
    chequeDate: date('cheque_date', { mode: 'string' }),
    chequeStatus: chequeStatus('cheque_status'),
    chequeClearedOn: date('cheque_cleared_on', { mode: 'string' }),
    chequeBouncedOn: date('cheque_bounced_on', { mode: 'string' }),
    bounceReason: text('bounce_reason'),
    registerSessionId: uuid('register_session_id'),
    /** A payment gateway's id, for matching (2.1): its payment id for a link payment. */
    gatewayReference: text('gateway_reference'),
    /** The payment link it paid (P2-M32): recorded by the gateway's webhook, with no member. */
    paymentLinkId: uuid('payment_link_id'),
    note: text('note'),
    /**
     * The GST receipt voucher (an advance, Rule 50) or refund voucher (Rule
     * 51) number, from the store's series, and the registration that issued it.
     */
    voucherNumber: text('voucher_number'),
    voucherFy: text('voucher_fy'),
    voucherSeriesId: uuid('voucher_series_id'),
    supplierGstin: text('supplier_gstin'),
    /** Null only for money a gateway reported (a payment link): no member took it. */
    createdByMemberId: uuid('created_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('payments_organization_id_id_unique').on(table.organizationId, table.id),
    // Allocations name their party; these keys keep it the payment's party.
    unique('payments_organization_id_party_unique').on(
      table.organizationId,
      table.id,
      table.partyId,
    ),
    unique('payments_organization_number_unique').on(table.organizationId, table.number),
    unique('payments_voucher_unique').on(
      table.organizationId,
      table.supplierGstin,
      table.voucherFy,
      table.voucherNumber,
    ),
    index('payments_party_idx').on(table.organizationId, table.partyId, table.receivedOn),
    index('payments_store_received_idx').on(
      table.organizationId,
      table.storeId,
      table.receivedOn.desc().nullsFirst(),
    ),
    index('payments_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('payments_register_session_idx')
      .on(table.registerSessionId)
      .where(sql`${table.registerSessionId} is not null`),
    // A gateway's payment is recorded once, however many events report it.
    uniqueIndex('payments_link_gateway_reference_unique')
      .on(table.organizationId, table.gatewayReference)
      .where(sql`${table.paymentLinkId} is not null`),
    index('payments_payment_link_idx')
      .on(table.paymentLinkId)
      .where(sql`${table.paymentLinkId} is not null`),
    foreignKey({
      name: 'payments_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payments_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payments_mode_fk',
      columns: [table.organizationId, table.modeId, table.modeKind],
      foreignColumns: [paymentModes.organizationId, paymentModes.id, paymentModes.kind],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payments_register_session_fk',
      columns: [table.organizationId, table.registerSessionId, table.storeId],
      foreignColumns: [
        registerSessions.organizationId,
        registerSessions.id,
        registerSessions.storeId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payments_payment_link_fk',
      columns: [table.organizationId, table.paymentLinkId, table.partyId],
      foreignColumns: [paymentLinks.organizationId, paymentLinks.id, paymentLinks.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payments_voucher_series_fk',
      columns: [table.organizationId, table.voucherSeriesId],
      foreignColumns: [documentSeries.organizationId, documentSeries.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payments_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('payments_amount_positive', sql`${table.amountPaise} > 0`),
    check('payments_number_format', sql`${table.number} ~ '^R[CF]-[0-9]{6,}$'`),
    check(
      'payments_tendered',
      sql`${table.tenderedPaise} is null or (${table.modeKind} = 'cash' and ${table.direction} = 'in'
        and ${table.tenderedPaise} >= ${table.amountPaise})`,
    ),
    check(
      'payments_cheque',
      sql`(${table.modeKind} = 'cheque' and ${table.direction} = 'in') = (${table.chequeStatus} is not null)
        and (${table.chequeStatus} is not null) = (${table.chequeDate} is not null)
        and (${table.chequeStatus} is not distinct from 'cleared') = (${table.chequeClearedOn} is not null)
        and (${table.chequeStatus} is not distinct from 'bounced') = (${table.chequeBouncedOn} is not null)
        and (${table.chequeStatus} is not distinct from 'bounced') = (${table.bounceReason} is not null)`,
    ),
    check(
      'payments_voucher',
      sql`(${table.voucherNumber} is null) = (${table.voucherFy} is null)
        and (${table.voucherNumber} is null) = (${table.voucherSeriesId} is null)
        and (${table.voucherNumber} is null) = (${table.supplierGstin} is null)
        and ${table.voucherNumber} ~ '^[A-Z0-9/-]{1,16}$'
        and ${table.voucherFy} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
    // Link payments: money in from a gateway, or its refund through the gateway (out),
    // never in a register; the UPI link mode is theirs alone (compared as text, as 0079
    // added the value in the same migration).
    check(
      'payments_link',
      sql`(${table.paymentLinkId} is null
          or (${table.gatewayReference} is not null and ${table.registerSessionId} is null))
        and (${table.modeKind}::text = 'upi_link') = (${table.paymentLinkId} is not null)
        and (${table.createdByMemberId} is not null or ${table.paymentLinkId} is not null)`,
    ),
    check(
      'payments_text_lengths',
      sql`char_length(${table.reference}) <= 100 and char_length(${table.note}) <= 500
        and char_length(${table.gatewayReference}) <= 200 and char_length(${table.bounceReason}) <= 500`,
    ),
    pgPolicy('payments_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * What a payment or credit note pays (spec §3.3, §4.6): an invoice, bill of
 * supply or debit note, an opening balance or charge in the party ledger, or
 * a refund. Append-only; a negative row undoes an earlier one. A trigger
 * (migration 0058) keeps every source and target within its amount.
 */
/** Why an allocation was undone: by hand, or because its cheque bounced (spec §4.6). */
export const allocationReversalReason = pgEnum('allocation_reversal_reason', [
  'undone',
  'cheque_bounce',
]);

export const allocations = pgTable(
  'allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Source and target always belong to this party (composite keys). */
    partyId: uuid('party_id').notNull(),
    paymentId: uuid('payment_id'),
    creditNoteId: uuid('credit_note_id'),
    documentId: uuid('document_id'),
    partyLedgerId: uuid('party_ledger_id'),
    refundPaymentId: uuid('refund_payment_id'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    reversesAllocationId: uuid('reverses_allocation_id'),
    /** Set exactly on a reversing row. */
    reversalReason: allocationReversalReason('reversal_reason'),
    createdByMemberId: uuid('created_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('allocations_organization_id_id_unique').on(table.organizationId, table.id),
    // One reversal per row.
    unique('allocations_reverses_unique').on(table.reversesAllocationId),
    index('allocations_payment_idx')
      .on(table.paymentId)
      .where(sql`${table.paymentId} is not null`),
    index('allocations_credit_note_idx')
      .on(table.creditNoteId)
      .where(sql`${table.creditNoteId} is not null`),
    index('allocations_document_idx')
      .on(table.documentId)
      .where(sql`${table.documentId} is not null`),
    index('allocations_party_ledger_idx')
      .on(table.partyLedgerId)
      .where(sql`${table.partyLedgerId} is not null`),
    index('allocations_refund_idx')
      .on(table.refundPaymentId)
      .where(sql`${table.refundPaymentId} is not null`),
    index('allocations_party_idx').on(table.organizationId, table.partyId),
    foreignKey({
      name: 'allocations_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'allocations_payment_fk',
      columns: [table.organizationId, table.paymentId, table.partyId],
      foreignColumns: [payments.organizationId, payments.id, payments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'allocations_credit_note_fk',
      columns: [table.organizationId, table.creditNoteId, table.partyId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id, taxDocuments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'allocations_document_fk',
      columns: [table.organizationId, table.documentId, table.partyId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id, taxDocuments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'allocations_party_ledger_fk',
      columns: [table.organizationId, table.partyLedgerId, table.partyId],
      foreignColumns: [partyLedger.organizationId, partyLedger.id, partyLedger.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'allocations_refund_fk',
      columns: [table.organizationId, table.refundPaymentId, table.partyId],
      foreignColumns: [payments.organizationId, payments.id, payments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'allocations_reverses_fk',
      columns: [table.organizationId, table.reversesAllocationId],
      foreignColumns: [table.organizationId, table.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'allocations_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'allocations_one_source',
      sql`num_nonnulls(${table.paymentId}, ${table.creditNoteId}) = 1`,
    ),
    check(
      'allocations_one_target',
      sql`num_nonnulls(${table.documentId}, ${table.partyLedgerId}, ${table.refundPaymentId}) = 1`,
    ),
    check(
      'allocations_amount_sign',
      sql`${table.amountPaise} <> 0
        and (${table.reversesAllocationId} is null) = (${table.amountPaise} > 0)`,
    ),
    check('allocations_not_self', sql`${table.paymentId} <> ${table.refundPaymentId}`),
    check(
      'allocations_reversal_reason',
      sql`(${table.reversalReason} is null) = (${table.reversesAllocationId} is null)`,
    ),
    pgPolicy('allocations_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What a Tally ledger mapping is for (spec §6.1; the Tally mapper's `TallyLedgerPurpose`). */
export const tallyLedgerPurpose = pgEnum('tally_ledger_purpose', [
  'sales',
  'composition_sales',
  'output_cgst',
  'output_sgst',
  'output_igst',
  'output_cess',
  'round_off',
  'party',
  'walk_in',
  'payment_mode',
  /** Charges recovered from a customer for a bounced cheque (an income ledger). */
  'bounce_charges',
]);

/**
 * A business's override of a default Tally ledger name (spec §6.1): applies to
 * an amount of its purpose when every match column it sets agrees; the rule
 * setting most columns wins, the lower position a tie. Settings, audited.
 */
export const ledgerMappings = pgTable(
  'ledger_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    purpose: tallyLedgerPurpose('purpose').notNull(),
    // Match: null means any.
    rateBps: integer('rate_bps'),
    nature: taxNature('nature'),
    supplyType: supplyType('supply_type'),
    storeId: uuid('store_id'),
    modeKind: paymentModeKind('mode_kind'),
    modeId: uuid('mode_id'),
    partyId: uuid('party_id'),
    tallyLedgerName: text('tally_ledger_name').notNull(),
    /** The Tally group to create the ledger under, when not the purpose's usual one. */
    tallyGroup: text('tally_group'),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique('ledger_mappings_organization_id_id_unique').on(table.organizationId, table.id),
    index('ledger_mappings_purpose_idx').on(table.organizationId, table.purpose, table.position),
    foreignKey({
      name: 'ledger_mappings_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ledger_mappings_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ledger_mappings_mode_fk',
      columns: [table.organizationId, table.modeId],
      foreignColumns: [paymentModes.organizationId, paymentModes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ledger_mappings_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('cascade'),
    check(
      'ledger_mappings_name_length',
      sql`char_length(${table.tallyLedgerName}) between 1 and 200`,
    ),
    check('ledger_mappings_rate_range', sql`${table.rateBps} between 0 and 10000`),
    check(
      'ledger_mappings_group',
      sql`${table.tallyGroup} in ('Sales Accounts', 'Duties & Taxes', 'Indirect Expenses',
        'Sundry Debtors', 'Cash-in-Hand', 'Bank Accounts', 'Current Assets')`,
    ),
    check(
      'ledger_mappings_match_fits_purpose',
      sql`case
        when ${table.purpose} in ('party', 'walk_in') then num_nonnulls(${table.rateBps}, ${table.nature}, ${table.supplyType}, ${table.modeKind}, ${table.modeId}) = 0
        when ${table.purpose} = 'payment_mode' then num_nonnulls(${table.rateBps}, ${table.nature}, ${table.supplyType}, ${table.partyId}) = 0
        else num_nonnulls(${table.modeKind}, ${table.modeId}, ${table.partyId}) = 0
      end`,
    ),
    pgPolicy('ledger_mappings_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const accountingExportFormat = pgEnum('accounting_export_format', ['tally_xml', 'xlsx']);

/** One row per accounting export, for audit (spec §6.1): never changed except filing its file once. */
export const accountingExports = pgTable(
  'accounting_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Issue and receipt dates covered, India time, both inclusive. */
    periodFrom: date('period_from', { mode: 'string' }).notNull(),
    periodTo: date('period_to', { mode: 'string' }).notNull(),
    /** Voucher kinds included: sales, credit_note, debit_note, receipt. */
    kinds: text('kinds').array().notNull(),
    format: accountingExportFormat('format').notNull(),
    /** The stored XML or workbook (documents), once written. */
    documentId: uuid('document_id'),
    voucherCount: integer('voucher_count').notNull().default(0),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('accounting_exports_organization_id_id_unique').on(table.organizationId, table.id),
    index('accounting_exports_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'accounting_exports_document_fk',
      columns: [table.organizationId, table.documentId],
      foreignColumns: [documents.organizationId, documents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'accounting_exports_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('accounting_exports_period', sql`${table.periodFrom} <= ${table.periodTo}`),
    check(
      'accounting_exports_kinds',
      sql`cardinality(${table.kinds}) between 1 and 4
        and ${table.kinds} <@ array['sales', 'credit_note', 'debit_note', 'receipt']::text[]`,
    ),
    check('accounting_exports_voucher_count', sql`${table.voucherCount} >= 0`),
    pgPolicy('accounting_exports_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Quotations, sales orders, reservations and dispatches (MVP 2, Sell & Bill,
// round 4a; spec §3.3, §4.1–4.4)
// ---------------------------------------------------------------------------

/** A quotation version's life; `expired` is read from `valid_until` (no job writes it in 2.0). */
export const quotationStatus = pgEnum('quotation_status', [
  'draft',
  'sent',
  'accepted',
  'expired',
  'superseded',
  'converted',
]);

/** A sales order's life (spec §4.1). */
export const salesOrderStatus = pgEnum('sales_order_status', [
  'draft',
  'confirmed',
  'partly_fulfilled',
  'fulfilled',
  'cancelled',
  'closed',
]);

/** How an order is paid (spec §4.4). */
export const paymentTerms = pgEnum('payment_terms', ['prepaid', 'partial', 'postpaid']);

/** `open` reservations make up `stock_balances.reserved`. */
export const stockReservationStatus = pgEnum('stock_reservation_status', [
  'open',
  'consumed',
  'released',
]);

/** Header columns quotations and orders share: who, where, and the engine's totals. */
const salesHeaderColumns = () => ({
  storeId: uuid('store_id').notNull(),
  /** Who pays and owes (spec §6.4). */
  billToPartyId: uuid('bill_to_party_id').notNull(),
  /** Painter, contractor or architect who brought the sale. */
  influencerPartyId: uuid('influencer_party_id'),
  /** The site. */
  projectId: uuid('project_id'),
  shipToName: text('ship_to_name'),
  shipToAddress: text('ship_to_address'),
  shipToStateCode: text('ship_to_state_code'),
  priceMode: priceMode('price_mode').notNull(),
  billDiscountBps: integer('bill_discount_bps'),
  billDiscountPaise: bigint('bill_discount_paise', { mode: 'number' }),
  /** The India date the engine priced it on (rates in force that day). */
  pricedOn: date('priced_on', { mode: 'string' }).notNull(),
  placeOfSupplyCode: text('place_of_supply_code').notNull(),
  supplyType: supplyType('supply_type').notNull(),
  taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
  cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull(),
  sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull(),
  igstPaise: bigint('igst_paise', { mode: 'number' }).notNull(),
  cessPaise: bigint('cess_paise', { mode: 'number' }).notNull(),
  roundOffPaise: bigint('round_off_paise', { mode: 'number' }).notNull(),
  totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
  note: text('note'),
  createdByMemberId: uuid('created_by_member_id').notNull(),
  ...timestamps,
});

/** Line columns quotations and orders share: the variant, price, and the engine's figures. */
const salesLineColumns = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  lineNo: integer('line_no').notNull(),
  variantId: uuid('variant_id').notNull(),
  description: text('description').notNull(),
  hsnCode: text('hsn_code'),
  quantity: numeric('quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
  unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
  discountBps: integer('discount_bps'),
  discountPaise: bigint('discount_paise', { mode: 'number' }),
  taxCategoryId: uuid('tax_category_id'),
  /** Null on a composition store's (untaxed) document. */
  rateBps: integer('rate_bps'),
  taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
  cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull(),
  sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull(),
  igstPaise: bigint('igst_paise', { mode: 'number' }).notNull(),
  cessPaise: bigint('cess_paise', { mode: 'number' }).notNull(),
  totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
});

/**
 * A quotation version (P2-M03). Versions of one quote share its number; a
 * revision is a new row with `version + 1` pointing at the first version, and
 * the version it replaces becomes `superseded`. Editable only while a draft
 * (trigger quotations_draft_only, migration 0061).
 */
export const quotations = pgTable(
  'quotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** e.g. QT-000042, shared by every version. */
    number: text('number').notNull(),
    version: integer('version').notNull().default(1),
    /** The first version; null on the first version itself. */
    rootQuotationId: uuid('root_quotation_id'),
    status: quotationStatus('status').notNull().default('draft'),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** The order it became (status converted). */
    salesOrderId: uuid('sales_order_id'),
    ...salesHeaderColumns(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('quotations_organization_id_id_unique').on(table.organizationId, table.id),
    unique('quotations_number_version_unique').on(
      table.organizationId,
      table.number,
      table.version,
    ),
    // One live version per quote: every other is superseded.
    uniqueIndex('quotations_one_live_version')
      .on(table.organizationId, table.number)
      .where(sql`${table.status} <> 'superseded'`),
    uniqueIndex('quotations_sales_order_unique')
      .on(table.salesOrderId)
      .where(sql`${table.salesOrderId} is not null`),
    // Newest first (GET /quotations); NULLS FIRST matches ORDER BY ... DESC.
    index('quotations_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('quotations_bill_to_idx').on(table.organizationId, table.billToPartyId),
    foreignKey({
      name: 'quotations_root_fk',
      columns: [table.organizationId, table.rootQuotationId],
      foreignColumns: [table.organizationId, table.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quotations_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quotations_bill_to_fk',
      columns: [table.organizationId, table.billToPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quotations_influencer_fk',
      columns: [table.organizationId, table.influencerPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quotations_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quotations_sales_order_fk',
      columns: [table.organizationId, table.salesOrderId],
      foreignColumns: [salesOrders.organizationId, salesOrders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quotations_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('quotations_number_format', sql`${table.number} ~ '^QT-[0-9]{6,}$'`),
    check(
      'quotations_version_root',
      sql`${table.version} >= 1 and (${table.version} = 1) = (${table.rootQuotationId} is null)`,
    ),
    check(
      'quotations_sent',
      sql`(${table.status} in ('sent', 'accepted', 'converted')) <= (${table.sentAt} is not null)
        and (${table.status} = 'accepted') <= (${table.acceptedAt} is not null)
        and (${table.status} = 'converted') = (${table.salesOrderId} is not null)`,
    ),
    ...salesHeaderChecks('quotations', table),
    pgPolicy('quotations_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** The checks every priced quotation or order header keeps. */
function salesHeaderChecks(
  name: string,
  table: {
    shipToStateCode: AnyColumn;
    placeOfSupplyCode: AnyColumn;
    billDiscountBps: AnyColumn;
    billDiscountPaise: AnyColumn;
    supplyType: AnyColumn;
    taxablePaise: AnyColumn;
    cgstPaise: AnyColumn;
    sgstPaise: AnyColumn;
    igstPaise: AnyColumn;
    cessPaise: AnyColumn;
    roundOffPaise: AnyColumn;
    totalPaise: AnyColumn;
    note: AnyColumn;
  },
) {
  return [
    check(
      `${name}_state_codes`,
      sql`${table.shipToStateCode} ~ '^[0-9]{2}$' and ${table.placeOfSupplyCode} ~ '^[0-9]{2}$'`,
    ),
    check(
      `${name}_bill_discount`,
      sql`(${table.billDiscountBps} is null or ${table.billDiscountPaise} is null)
        and ${table.billDiscountBps} between 0 and 10000 and ${table.billDiscountPaise} >= 0`,
    ),
    check(
      `${name}_amounts`,
      sql`${table.taxablePaise} >= 0 and ${table.cgstPaise} >= 0 and ${table.sgstPaise} >= 0
        and ${table.igstPaise} >= 0 and ${table.cessPaise} >= 0 and ${table.totalPaise} >= 0
        and ${table.roundOffPaise} between -50 and 50
        and ${table.totalPaise} = ${table.taxablePaise} + ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise} + ${table.cessPaise} + ${table.roundOffPaise}`,
    ),
    check(
      `${name}_tax_by_supply`,
      sql`case ${table.supplyType}
        when 'intra_state' then ${table.igstPaise} = 0 and ${table.cgstPaise} = ${table.sgstPaise}
        else ${table.cgstPaise} = 0 and ${table.sgstPaise} = 0 end`,
    ),
    check(`${name}_note_length`, sql`char_length(${table.note}) <= 500`),
  ];
}

/** The checks every priced quotation or order line keeps. */
function salesLineChecks(
  name: string,
  table: {
    lineNo: AnyColumn;
    quantity: AnyColumn;
    unitPricePaise: AnyColumn;
    discountBps: AnyColumn;
    discountPaise: AnyColumn;
    rateBps: AnyColumn;
    hsnCode: AnyColumn;
    taxablePaise: AnyColumn;
    cgstPaise: AnyColumn;
    sgstPaise: AnyColumn;
    igstPaise: AnyColumn;
    cessPaise: AnyColumn;
    totalPaise: AnyColumn;
  },
) {
  return [
    check(`${name}_line_no_positive`, sql`${table.lineNo} > 0`),
    check(`${name}_quantity_positive`, sql`${table.quantity} > 0`),
    check(
      `${name}_amounts`,
      sql`${table.unitPricePaise} >= 0 and ${table.taxablePaise} >= 0
        and ${table.cgstPaise} >= 0 and ${table.sgstPaise} >= 0 and ${table.igstPaise} >= 0 and ${table.cessPaise} >= 0
        and ${table.totalPaise} = ${table.taxablePaise} + ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise} + ${table.cessPaise}`,
    ),
    check(
      `${name}_one_discount`,
      sql`(${table.discountBps} is null or ${table.discountPaise} is null)
        and ${table.discountBps} between 0 and 10000 and ${table.discountPaise} >= 0`,
    ),
    check(`${name}_rate_range`, sql`${table.rateBps} between 0 and 10000`),
    check(`${name}_hsn_format`, sql`${table.hsnCode} ~ '^[0-9]{4}([0-9]{2}){0,2}$'`),
  ];
}

/** A line of a quotation version, priced by the engine on the quote's `priced_on`. */
export const quotationLines = pgTable(
  'quotation_lines',
  {
    ...salesLineColumns(),
    quotationId: uuid('quotation_id').notNull(),
  },
  (table) => [
    unique('quotation_lines_organization_id_id_unique').on(table.organizationId, table.id),
    unique('quotation_lines_quotation_line_unique').on(table.quotationId, table.lineNo),
    foreignKey({
      name: 'quotation_lines_quotation_fk',
      columns: [table.organizationId, table.quotationId],
      foreignColumns: [quotations.organizationId, quotations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'quotation_lines_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quotation_lines_tax_category_fk',
      columns: [table.organizationId, table.taxCategoryId],
      foreignColumns: [taxCategories.organizationId, taxCategories.id],
    }).onDelete('restrict'),
    ...salesLineChecks('quotation_lines', table),
    pgPolicy('quotation_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A sales order (P2-M04), from a quotation or direct. Confirming it runs the
 * credit check (postpaid) and reserves every line; invoices bill its lines in
 * part or in full. Every status change and credit override is audited.
 */
export const salesOrders = pgTable(
  'sales_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** e.g. SO-000017. */
    number: text('number').notNull(),
    status: salesOrderStatus('status').notNull().default('draft'),
    paymentTerms: paymentTerms('payment_terms').notNull(),
    /** A partial order's minimum advance, fixed at confirm. */
    advanceRequiredPaise: bigint('advance_required_paise', { mode: 'number' }),
    quotationId: uuid('quotation_id'),
    /** checkCredit's figures at confirm (postpaid), with the position they came from. */
    creditCheck: jsonb('credit_check').$type<Record<string, unknown>>(),
    creditOverrideApproval: text('credit_override_approval'),
    creditOverrideByMemberId: uuid('credit_override_by_member_id'),
    creditOverrideReason: text('credit_override_reason'),
    creditOverriddenAt: timestamp('credit_overridden_at', { withTimezone: true }),
    /** The approval the confirm used (P2-M09); the override columns are filled from it. */
    creditApprovalId: uuid('credit_approval_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedByMemberId: uuid('confirmed_by_member_id'),
    cancelReason: text('cancel_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByMemberId: uuid('cancelled_by_member_id'),
    ...salesHeaderColumns(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('sales_orders_organization_id_id_unique').on(table.organizationId, table.id),
    unique('sales_orders_organization_number_unique').on(table.organizationId, table.number),
    uniqueIndex('sales_orders_quotation_unique')
      .on(table.quotationId)
      .where(sql`${table.quotationId} is not null`),
    index('sales_orders_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // Exposure: a party's open postpaid orders (spec §4.7).
    index('sales_orders_bill_to_status_idx').on(
      table.organizationId,
      table.billToPartyId,
      table.status,
    ),
    foreignKey({
      name: 'sales_orders_quotation_fk',
      columns: [table.organizationId, table.quotationId],
      foreignColumns: [quotations.organizationId, quotations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_bill_to_fk',
      columns: [table.organizationId, table.billToPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_influencer_fk',
      columns: [table.organizationId, table.influencerPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_confirmed_by_fk',
      columns: [table.organizationId, table.confirmedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_credit_override_by_fk',
      columns: [table.organizationId, table.creditOverrideByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_credit_approval_fk',
      columns: [table.organizationId, table.creditApprovalId],
      foreignColumns: [creditApprovals.organizationId, creditApprovals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_orders_cancelled_by_fk',
      columns: [table.organizationId, table.cancelledByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('sales_orders_number_format', sql`${table.number} ~ '^SO-[0-9]{6,}$'`),
    check(
      'sales_orders_confirmed',
      sql`(${table.status} = 'draft') = (${table.confirmedAt} is null)
        and (${table.confirmedAt} is null) = (${table.confirmedByMemberId} is null)`,
    ),
    check(
      'sales_orders_cancelled',
      sql`(${table.status} in ('cancelled', 'closed')) = (${table.cancelledAt} is not null)
        and (${table.cancelledAt} is null) = (${table.cancelReason} is null)
        and (${table.cancelledAt} is null) = (${table.cancelledByMemberId} is null)`,
    ),
    check(
      'sales_orders_credit_override',
      sql`(${table.creditOverrideApproval} is null) = (${table.creditOverrideByMemberId} is null)
        and (${table.creditOverrideApproval} is null) = (${table.creditOverrideReason} is null)
        and (${table.creditOverrideApproval} is null) = (${table.creditOverriddenAt} is null)
        and ${table.creditOverrideApproval} in ('manager', 'owner')
        and (${table.creditOverrideApproval} is null or ${table.creditCheck} is not null)`,
    ),
    check(
      'sales_orders_credit_check_postpaid',
      sql`${table.creditCheck} is null or (${table.paymentTerms} = 'postpaid' and ${table.status} <> 'draft')`,
    ),
    check(
      'sales_orders_advance',
      sql`${table.advanceRequiredPaise} is null or (${table.advanceRequiredPaise} >= 0 and ${table.paymentTerms} = 'partial')`,
    ),
    ...salesHeaderChecks('sales_orders', table),
    pgPolicy('sales_orders_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** A line of a sales order: what is billed or cancelled of it never exceeds its quantity. */
export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    ...salesLineColumns(),
    orderId: uuid('order_id').notNull(),
    /** The store the goods come from and are reserved at. */
    fulfilStoreId: uuid('fulfil_store_id').notNull(),
    quantityInvoiced: numeric('quantity_invoiced', { precision: 14, scale: 3, mode: 'number' })
      .notNull()
      .default(0),
    quantityCancelled: numeric('quantity_cancelled', { precision: 14, scale: 3, mode: 'number' })
      .notNull()
      .default(0),
  },
  (table) => [
    unique('sales_order_lines_organization_id_id_unique').on(table.organizationId, table.id),
    unique('sales_order_lines_order_line_unique').on(table.orderId, table.lineNo),
    foreignKey({
      name: 'sales_order_lines_order_fk',
      columns: [table.organizationId, table.orderId],
      foreignColumns: [salesOrders.organizationId, salesOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sales_order_lines_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_order_lines_fulfil_store_fk',
      columns: [table.organizationId, table.fulfilStoreId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sales_order_lines_tax_category_fk',
      columns: [table.organizationId, table.taxCategoryId],
      foreignColumns: [taxCategories.organizationId, taxCategories.id],
    }).onDelete('restrict'),
    check(
      'sales_order_lines_fulfilment',
      sql`${table.quantityInvoiced} >= 0 and ${table.quantityCancelled} >= 0
        and ${table.quantityInvoiced} + ${table.quantityCancelled} <= ${table.quantity}`,
    ),
    ...salesLineChecks('sales_order_lines', table),
    pgPolicy('sales_order_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Stock held for an order line at a store (spec §4.3). The open rows of a
 * store and variant add up to `stock_balances.reserved`, kept so by
 * reserveStock / releaseStock in the same transaction (findReservationMismatches
 * checks it). One open reservation per order line.
 */
export const stockReservations = pgTable(
  'stock_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    storeId: uuid('store_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    status: stockReservationStatus('status').notNull().default('open'),
    /** What consumed it: an invoice (stock out on issue) or a dispatch (stock out on dispatch). */
    consumedByType: text('consumed_by_type'),
    consumedById: uuid('consumed_by_id'),
    createdByMemberId: uuid('created_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    unique('stock_reservations_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('stock_reservations_one_open_per_line')
      .on(table.orderLineId)
      .where(sql`${table.status} = 'open'`),
    index('stock_reservations_open_idx')
      .on(table.organizationId, table.storeId, table.variantId)
      .where(sql`${table.status} = 'open'`),
    index('stock_reservations_order_line_idx').on(table.organizationId, table.orderLineId),
    foreignKey({
      name: 'stock_reservations_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_reservations_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_reservations_order_line_fk',
      columns: [table.organizationId, table.orderLineId],
      foreignColumns: [salesOrderLines.organizationId, salesOrderLines.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_reservations_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('stock_reservations_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'stock_reservations_closed',
      sql`(${table.status} = 'open') = (${table.closedAt} is null)
        and (${table.status} = 'consumed') = (${table.consumedById} is not null)
        and (${table.consumedById} is null) = (${table.consumedByType} is null)
        and ${table.consumedByType} in ('tax_document', 'dispatch')`,
    ),
    pgPolicy('stock_reservations_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Goods leaving for an issued invoice (spec §4.2, §2.10): with
 * `stock_post_on = dispatch` this is when the stock goes out. Append-only.
 */
export const dispatches = pgTable(
  'dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** e.g. DS-000003. */
    number: text('number').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    storeId: uuid('store_id').notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).notNull().defaultNow(),
    vehicleNo: text('vehicle_no'),
    ewayBillNo: text('eway_bill_no'),
    ewayValidUntil: date('eway_valid_until', { mode: 'string' }),
    /** Consignment value with tax (spec §2.10). */
    valuePaise: bigint('value_paise', { mode: 'number' }).notNull(),
    /** True when this dispatch took the stock out (the invoice posts on dispatch). */
    stockPosted: boolean('stock_posted').notNull(),
    note: text('note'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('dispatches_organization_id_id_unique').on(table.organizationId, table.id),
    unique('dispatches_organization_number_unique').on(table.organizationId, table.number),
    index('dispatches_invoice_idx').on(table.organizationId, table.invoiceId),
    foreignKey({
      name: 'dispatches_invoice_fk',
      columns: [table.organizationId, table.invoiceId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'dispatches_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'dispatches_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('dispatches_number_format', sql`${table.number} ~ '^DS-[0-9]{6,}$'`),
    check('dispatches_value_not_negative', sql`${table.valuePaise} >= 0`),
    check('dispatches_eway_bill_no', sql`${table.ewayBillNo} ~ '^[0-9]{12}$'`),
    check(
      'dispatches_eway_valid_with_number',
      sql`${table.ewayValidUntil} is null or ${table.ewayBillNo} is not null`,
    ),
    check(
      'dispatches_text_lengths',
      sql`char_length(${table.vehicleNo}) <= 20 and char_length(${table.note}) <= 500`,
    ),
    pgPolicy('dispatches_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What one dispatch took of an invoice line. */
export const dispatchLines = pgTable(
  'dispatch_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    dispatchId: uuid('dispatch_id').notNull(),
    invoiceLineId: uuid('invoice_line_id').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    valuePaise: bigint('value_paise', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('dispatch_lines_dispatch_line_unique').on(table.dispatchId, table.invoiceLineId),
    index('dispatch_lines_invoice_line_idx').on(table.organizationId, table.invoiceLineId),
    foreignKey({
      name: 'dispatch_lines_dispatch_fk',
      columns: [table.organizationId, table.dispatchId],
      foreignColumns: [dispatches.organizationId, dispatches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'dispatch_lines_invoice_line_fk',
      columns: [table.organizationId, table.invoiceLineId],
      foreignColumns: [taxDocumentLines.organizationId, taxDocumentLines.id],
    }).onDelete('restrict'),
    check('dispatch_lines_quantity_positive', sql`${table.quantity} > 0`),
    check('dispatch_lines_value_not_negative', sql`${table.valuePaise} >= 0`),
    pgPolicy('dispatch_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Paint data: tint records and estimates (MVP 2, Sell & Bill, round 5a;
// spec §3.3, §6.2, §6.3)
// ---------------------------------------------------------------------------

/**
 * The shade a line's base was tinted to (P2-M30): on exactly one quotation,
 * sales order or invoice line, inserted and deleted only while that line's
 * document is a draft, never updated (trigger tint_records_draft_only,
 * migration 0064). Store, party and site are copied from the document so the
 * shade history is searched across every store without joining documents.
 */
export const tintRecords = pgTable(
  'tint_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Where it was tinted: the document's store (an order line's fulfil store). */
    storeId: uuid('store_id').notNull(),
    /** The document's bill-to; null on a walk-in bill with no party. */
    partyId: uuid('party_id'),
    /** The document's site. */
    projectId: uuid('project_id'),
    quotationLineId: uuid('quotation_line_id'),
    salesOrderLineId: uuid('sales_order_line_id'),
    invoiceLineId: uuid('invoice_line_id'),
    /** The shade card's brand. */
    brandId: uuid('brand_id').notNull(),
    /** Normalised: trimmed, single spaces, upper case (normalizeShadeCode). */
    shadeCode: text('shade_code').notNull(),
    shadeName: text('shade_name'),
    /** The base: always the line's variant. */
    baseVariantId: uuid('base_variant_id').notNull(),
    /** Packs tinted. */
    packQuantity: numeric('pack_quantity', { precision: 14, scale: 3, mode: 'number' }).notNull(),
    /** Colorant cost per pack, for margin only. */
    colorantCostPaise: bigint('colorant_cost_paise', { mode: 'number' }),
    /** Tinting charge per pack, part of the line's unit price. */
    tintChargePaise: bigint('tint_charge_paise', { mode: 'number' }).notNull().default(0),
    /** Free text until machines are integrated (Release 2.4). */
    machine: text('machine'),
    /** Colorants per pack: [{ colorant, amount, unit }]. */
    formula: jsonb('formula')
      .notNull()
      .default([])
      .$type<{ colorant: string; amount: number; unit: string }[]>(),
    note: text('note'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tint_records_organization_id_id_unique').on(table.organizationId, table.id),
    // One shade per line.
    uniqueIndex('tint_records_quotation_line_unique')
      .on(table.quotationLineId)
      .where(sql`${table.quotationLineId} is not null`),
    uniqueIndex('tint_records_sales_order_line_unique')
      .on(table.salesOrderLineId)
      .where(sql`${table.salesOrderLineId} is not null`),
    uniqueIndex('tint_records_invoice_line_unique')
      .on(table.invoiceLineId)
      .where(sql`${table.invoiceLineId} is not null`),
    // "Same shade as last time" (spec §3.3): by party and shade, by site, by shade; newest first.
    index('tint_records_party_shade_idx').on(
      table.organizationId,
      table.partyId,
      table.shadeCode,
      table.createdAt.desc().nullsFirst(),
    ),
    index('tint_records_project_idx')
      .on(table.organizationId, table.projectId, table.createdAt.desc().nullsFirst())
      .where(sql`${table.projectId} is not null`),
    index('tint_records_shade_idx').on(
      table.organizationId,
      table.shadeCode,
      table.createdAt.desc().nullsFirst(),
    ),
    index('tint_records_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'tint_records_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tint_records_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tint_records_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    // A draft's lines are replaced on edit: their tint records go with them.
    foreignKey({
      name: 'tint_records_quotation_line_fk',
      columns: [table.organizationId, table.quotationLineId],
      foreignColumns: [quotationLines.organizationId, quotationLines.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tint_records_sales_order_line_fk',
      columns: [table.organizationId, table.salesOrderLineId],
      foreignColumns: [salesOrderLines.organizationId, salesOrderLines.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tint_records_invoice_line_fk',
      columns: [table.organizationId, table.invoiceLineId],
      foreignColumns: [taxDocumentLines.organizationId, taxDocumentLines.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tint_records_brand_fk',
      columns: [table.organizationId, table.brandId],
      foreignColumns: [brands.organizationId, brands.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tint_records_base_variant_fk',
      columns: [table.organizationId, table.baseVariantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tint_records_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'tint_records_one_line',
      sql`num_nonnulls(${table.quotationLineId}, ${table.salesOrderLineId}, ${table.invoiceLineId}) = 1`,
    ),
    check(
      'tint_records_shade_code_format',
      sql`${table.shadeCode} = upper(${table.shadeCode}) and ${table.shadeCode} ~ '^[^[:space:]]+( [^[:space:]]+)*$'
        and char_length(${table.shadeCode}) <= 40`,
    ),
    check('tint_records_pack_quantity_positive', sql`${table.packQuantity} > 0`),
    check(
      'tint_records_amounts',
      sql`${table.colorantCostPaise} >= 0 and ${table.tintChargePaise} >= 0`,
    ),
    check(
      'tint_records_formula',
      sql`jsonb_typeof(${table.formula}) = 'array' and jsonb_array_length(${table.formula}) <= 16`,
    ),
    check(
      'tint_records_text_lengths',
      sql`char_length(${table.shadeName}) between 1 and 80 and char_length(${table.machine}) between 1 and 80
        and char_length(${table.note}) between 1 and 500`,
    ),
    pgPolicy('tint_records_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** An estimate's life: `draft` is edited and computed; `converted` became a quotation. */
export const estimateStatus = pgEnum('estimate_status', ['draft', 'converted']);

/** What a surface is (spec §3.3). */
export const surfaceKind = pgEnum('surface_kind', [
  'interior_wall',
  'ceiling',
  'exterior',
  'wood',
  'metal',
]);

/** The state of a surface, which decides primer and putty (spec §6.2). */
export const surfaceCondition = pgEnum('surface_condition', ['new', 'repaint', 'damaged']);

/** Good / better / best product choices. */
export const estimateTier = pgEnum('estimate_tier', ['good', 'better', 'best']);

/**
 * A paint estimate (P2-M29): surfaces to paint and up to three product
 * choices, whose litres and pack mix the estimator computes (built after 5a).
 * Changes only while a draft; converting it into a quotation is final
 * (trigger estimates_draft_only, migration 0064).
 */
export const estimates = pgTable(
  'estimates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** e.g. ES-000007. */
    number: text('number').notNull(),
    status: estimateStatus('status').notNull().default('draft'),
    storeId: uuid('store_id').notNull(),
    /** The customer; needed by the time it becomes a quotation. */
    partyId: uuid('party_id'),
    /** The site. */
    projectId: uuid('project_id'),
    title: text('title'),
    /** Added to litres; basis points (500 = 5 %). */
    wastageBps: integer('wastage_bps').notNull().default(500),
    note: text('note'),
    /** The quotation it became, and from which tier. */
    quotationId: uuid('quotation_id'),
    convertedTier: estimateTier('converted_tier'),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('estimates_organization_id_id_unique').on(table.organizationId, table.id),
    unique('estimates_organization_number_unique').on(table.organizationId, table.number),
    uniqueIndex('estimates_quotation_unique')
      .on(table.quotationId)
      .where(sql`${table.quotationId} is not null`),
    // Newest first (GET /estimates); NULLS FIRST matches ORDER BY ... DESC.
    index('estimates_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('estimates_party_idx')
      .on(table.organizationId, table.partyId)
      .where(sql`${table.partyId} is not null`),
    foreignKey({
      name: 'estimates_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'estimates_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'estimates_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'estimates_quotation_fk',
      columns: [table.organizationId, table.quotationId],
      foreignColumns: [quotations.organizationId, quotations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'estimates_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('estimates_number_format', sql`${table.number} ~ '^ES-[0-9]{6,}$'`),
    check('estimates_wastage_range', sql`${table.wastageBps} between 0 and 5000`),
    check(
      'estimates_converted',
      sql`(${table.status} = 'converted') = (${table.quotationId} is not null)
        and (${table.quotationId} is null) = (${table.convertedTier} is null)
        and (${table.quotationId} is null) = (${table.convertedAt} is null)`,
    ),
    check(
      'estimates_text_lengths',
      sql`char_length(${table.title}) between 1 and 120 and char_length(${table.note}) between 1 and 500`,
    ),
    pgPolicy('estimates_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A surface of an estimate: an area, or a length × height, less its openings
 * (doors, windows).
 */
export const estimateSurfaces = pgTable(
  'estimate_surfaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    estimateId: uuid('estimate_id').notNull(),
    /** 1, 2, 3… in the order entered. */
    position: integer('position').notNull(),
    room: text('room').notNull(),
    kind: surfaceKind('kind').notNull(),
    areaSqft: numeric('area_sqft', { precision: 10, scale: 2, mode: 'number' }),
    lengthFt: numeric('length_ft', { precision: 8, scale: 2, mode: 'number' }),
    heightFt: numeric('height_ft', { precision: 8, scale: 2, mode: 'number' }),
    openingsSqft: numeric('openings_sqft', { precision: 10, scale: 2, mode: 'number' })
      .notNull()
      .default(0),
    condition: surfaceCondition('condition').notNull(),
    /** Null: the product's default coats. */
    coats: integer('coats'),
    primer: boolean('primer').notNull(),
    putty: boolean('putty').notNull(),
  },
  (table) => [
    unique('estimate_surfaces_organization_id_id_unique').on(table.organizationId, table.id),
    unique('estimate_surfaces_estimate_position_unique').on(table.estimateId, table.position),
    foreignKey({
      name: 'estimate_surfaces_estimate_fk',
      columns: [table.organizationId, table.estimateId],
      foreignColumns: [estimates.organizationId, estimates.id],
    }).onDelete('cascade'),
    check('estimate_surfaces_position_positive', sql`${table.position} > 0`),
    check(
      'estimate_surfaces_room',
      sql`${table.room} = btrim(${table.room}) and char_length(${table.room}) between 1 and 60`,
    ),
    check(
      'estimate_surfaces_size',
      sql`(${table.areaSqft} is null) <> (${table.lengthFt} is null)
        and (${table.lengthFt} is null) = (${table.heightFt} is null)
        and ${table.areaSqft} > 0 and ${table.lengthFt} > 0 and ${table.heightFt} > 0`,
    ),
    check(
      'estimate_surfaces_openings',
      sql`${table.openingsSqft} >= 0
        and ${table.openingsSqft} <= coalesce(${table.areaSqft}, ${table.lengthFt} * ${table.heightFt})`,
    ),
    check('estimate_surfaces_coats_range', sql`${table.coats} between 1 and 5`),
    pgPolicy('estimate_surfaces_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * One tier of an estimate: the products, and what the estimator computed for
 * them (litres, pack mix and total; null until computed, all or none).
 */
export const estimateOptions = pgTable(
  'estimate_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    estimateId: uuid('estimate_id').notNull(),
    tier: estimateTier('tier').notNull(),
    /** The paint. */
    productId: uuid('product_id').notNull(),
    primerProductId: uuid('primer_product_id'),
    puttyProductId: uuid('putty_product_id'),
    litres: numeric('litres', { precision: 12, scale: 3, mode: 'number' }),
    /** The pack mix as priced: [{ purpose, variantId, sku, description, quantity, unitPricePaise, totalPaise }]. */
    lines: jsonb('lines').$type<
      {
        purpose: string;
        variantId: string;
        sku: string;
        description: string;
        quantity: number;
        unitPricePaise: number;
        totalPaise: number;
      }[]
    >(),
    totalPaise: bigint('total_paise', { mode: 'number' }),
    computedAt: timestamp('computed_at', { withTimezone: true }),
  },
  (table) => [
    unique('estimate_options_organization_id_id_unique').on(table.organizationId, table.id),
    unique('estimate_options_estimate_tier_unique').on(table.estimateId, table.tier),
    foreignKey({
      name: 'estimate_options_estimate_fk',
      columns: [table.organizationId, table.estimateId],
      foreignColumns: [estimates.organizationId, estimates.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'estimate_options_product_fk',
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'estimate_options_primer_product_fk',
      columns: [table.organizationId, table.primerProductId],
      foreignColumns: [products.organizationId, products.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'estimate_options_putty_product_fk',
      columns: [table.organizationId, table.puttyProductId],
      foreignColumns: [products.organizationId, products.id],
    }).onDelete('restrict'),
    check(
      'estimate_options_computed',
      sql`(${table.computedAt} is null) = (${table.litres} is null)
        and (${table.computedAt} is null) = (${table.lines} is null)
        and (${table.computedAt} is null) = (${table.totalPaise} is null)
        and ${table.litres} >= 0 and ${table.totalPaise} >= 0
        and jsonb_typeof(${table.lines}) = 'array'`,
    ),
    pgPolicy('estimate_options_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// Opening balances and reconciliation (MVP 2 round 6a; spec §4.6, §4.7, [PO-5]) --

/**
 * Opening balances imported from the old books (spec §4.7, [PO-5]), waiting
 * for the billing go-live, where each becomes its party's `opening` ledger
 * entry in place of the hand-entered exposure. Kept afterwards as the record
 * of what was imported; one row per party, replaced by a later import.
 */
export const goLiveOpenings = pgTable(
  'go_live_openings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    /** What the party owes at go-live; 0 = no opening entry. */
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    /** Since when part of it is overdue; overdue days are counted from it after go-live. */
    overdueSince: date('overdue_since', { mode: 'string' }),
    importedByMemberId: uuid('imported_by_member_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('go_live_openings_organization_id_id_unique').on(table.organizationId, table.id),
    unique('go_live_openings_party_unique').on(table.organizationId, table.partyId),
    foreignKey({
      name: 'go_live_openings_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'go_live_openings_imported_by_fk',
      columns: [table.organizationId, table.importedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('go_live_openings_amount_not_negative', sql`${table.amountPaise} >= 0`),
    check(
      'go_live_openings_overdue_needs_amount',
      sql`${table.overdueSince} is null or ${table.amountPaise} > 0`,
    ),
    pgPolicy('go_live_openings_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What started a reconciliation: the nightly job, or someone asking for it. */
export const reconciliationTrigger = pgEnum('reconciliation_trigger', ['scheduled', 'manual']);

/**
 * What a finding is about: stock on hand or reserved against its rows, a
 * party's balance against its ledger, or its allocations against its balance.
 */
export const reconciliationKind = pgEnum('reconciliation_kind', [
  'stock_on_hand',
  'stock_reserved',
  'party_balance',
  'allocation',
]);

/**
 * One reconciliation of a business's books (spec §3.3, §4.6): cached totals
 * checked against the rows they sum. At most one scheduled run per India day.
 * Append-only.
 */
export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    trigger: reconciliationTrigger('trigger').notNull(),
    /** The India date of the run, from the database clock. */
    runOn: date('run_on', { mode: 'string' })
      .notNull()
      .default(sql`(now() at time zone 'Asia/Kolkata')::date`),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who asked for a manual run; null for the nightly one. */
    requestedByMemberId: uuid('requested_by_member_id'),
    findingCount: integer('finding_count').notNull(),
  },
  (table) => [
    unique('reconciliation_runs_organization_id_id_unique').on(table.organizationId, table.id),
    // Several servers may run the nightly job: only one run a day is recorded.
    uniqueIndex('reconciliation_runs_scheduled_unique')
      .on(table.organizationId, table.runOn)
      .where(sql`${table.trigger} = 'scheduled'`),
    // Latest first; NULLS FIRST matches ORDER BY ... DESC.
    index('reconciliation_runs_latest_idx').on(
      table.organizationId,
      table.ranAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'reconciliation_runs_requested_by_fk',
      columns: [table.organizationId, table.requestedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'reconciliation_runs_requested_by',
      sql`(${table.trigger} = 'manual') = (${table.requestedByMemberId} is not null)`,
    ),
    check('reconciliation_runs_finding_count', sql`${table.findingCount} >= 0`),
    pgPolicy('reconciliation_runs_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * One disagreement a run found: what the cached figure says against what its
 * rows add up to. Stock findings name a store and variant (quantities); party
 * findings a party (paise), allocation findings also the advance held and the
 * money not allocated. Append-only.
 */
export const reconciliationFindings = pgTable(
  'reconciliation_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id').notNull(),
    kind: reconciliationKind('kind').notNull(),
    storeId: uuid('store_id'),
    variantId: uuid('variant_id'),
    partyId: uuid('party_id'),
    /** The cached figure: stock on hand or reserved, or the party's balance. */
    recorded: numeric('recorded', { precision: 20, scale: 3, mode: 'number' }).notNull(),
    /** What its rows add up to (for allocations: outstanding less unallocated). */
    expected: numeric('expected', { precision: 20, scale: 3, mode: 'number' }).notNull(),
    advancePaise: bigint('advance_paise', { mode: 'number' }),
    unallocatedPaise: bigint('unallocated_paise', { mode: 'number' }),
  },
  (table) => [
    unique('reconciliation_findings_organization_id_id_unique').on(table.organizationId, table.id),
    index('reconciliation_findings_run_idx').on(table.organizationId, table.runId),
    foreignKey({
      name: 'reconciliation_findings_run_fk',
      columns: [table.organizationId, table.runId],
      foreignColumns: [reconciliationRuns.organizationId, reconciliationRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reconciliation_findings_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reconciliation_findings_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reconciliation_findings_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    check(
      'reconciliation_findings_subject',
      sql`case
        when ${table.kind} in ('stock_on_hand', 'stock_reserved')
          then ${table.storeId} is not null and ${table.variantId} is not null and ${table.partyId} is null
        else ${table.partyId} is not null and ${table.storeId} is null and ${table.variantId} is null
      end`,
    ),
    check(
      'reconciliation_findings_allocation_figures',
      sql`(${table.kind} = 'allocation') = (${table.advancePaise} is not null)
        and (${table.advancePaise} is null) = (${table.unallocatedPaise} is null)`,
    ),
    pgPolicy('reconciliation_findings_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// Credit enforcement (MVP 3 round 1a, P2-M09; docs/mvp-3/credit-and-receivables.md §3.2) --------

/** A sale past the credit rules, or the release of a hold. */
export const creditApprovalKind = pgEnum('credit_approval_kind', ['sale', 'release']);

/** Who must approve a sale: a manager (credit:approve_sale) or the owner. */
export const creditApprovalLevel = pgEnum('credit_approval_level', ['manager', 'owner']);

export const creditApprovalStatus = pgEnum('credit_approval_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  /** An approved sale that went ahead. */
  'used',
]);

/**
 * A request to let a sale go past the credit rules (an order confirmed or an
 * invoice issued on credit) or to release a hold, decided by a manager or the
 * owner as checkCredit's result says (spec §4.3). It replaces MVP 2's
 * in-dialog override; approving in the dialog writes one already approved.
 */
export const creditApprovals = pgTable(
  'credit_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. AP-000004. */
    number: text('number').notNull(),
    kind: creditApprovalKind('kind').notNull(),
    partyId: uuid('party_id').notNull(),
    /** The site (project) of the sale, when it has one. */
    projectId: uuid('project_id'),
    /** The store selling; its managers approve a manager-level sale. */
    storeId: uuid('store_id'),
    salesOrderId: uuid('sales_order_id'),
    taxDocumentId: uuid('tax_document_id'),
    level: creditApprovalLevel('level'),
    /** The sale amount checked (0 for a release). */
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull().default(0),
    /** The credit view (checkCredit and position, party and site) when asked. */
    check: jsonb('check').$type<Record<string, unknown>>(),
    /** Why the requester asks. */
    reason: text('reason').notNull(),
    status: creditApprovalStatus('status').notNull().default('pending'),
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who approved, rejected or cancelled it. */
    decidedByMemberId: uuid('decided_by_member_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Required to reject. */
    decisionReason: text('decision_reason'),
    /** A release may waive the overdue block until this India date. */
    waiveOverdueUntil: date('waive_overdue_until', { mode: 'string' }),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('credit_approvals_organization_id_id_unique').on(table.organizationId, table.id),
    unique('credit_approvals_organization_number_unique').on(table.organizationId, table.number),
    uniqueIndex('credit_approvals_one_pending_per_order')
      .on(table.salesOrderId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('credit_approvals_one_pending_per_invoice')
      .on(table.taxDocumentId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('credit_approvals_one_pending_release')
      .on(table.partyId)
      .where(sql`${table.status} = 'pending' and ${table.kind} = 'release'`),
    index('credit_approvals_status_idx').on(table.organizationId, table.status, table.createdAt),
    index('credit_approvals_party_idx').on(table.organizationId, table.partyId),
    foreignKey({
      name: 'credit_approvals_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_approvals_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_approvals_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    // A discarded draft takes its approvals with it (the audit log keeps them).
    foreignKey({
      name: 'credit_approvals_sales_order_fk',
      columns: [table.organizationId, table.salesOrderId],
      foreignColumns: [salesOrders.organizationId, salesOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'credit_approvals_tax_document_fk',
      columns: [table.organizationId, table.taxDocumentId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'credit_approvals_requested_by_fk',
      columns: [table.organizationId, table.requestedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_approvals_decided_by_fk',
      columns: [table.organizationId, table.decidedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('credit_approvals_number_format', sql`${table.number} ~ '^AP-[0-9]{6,}$'`),
    check(
      'credit_approvals_subject',
      sql`case when ${table.kind} = 'sale'
        then num_nonnulls(${table.salesOrderId}, ${table.taxDocumentId}) = 1
          and ${table.level} is not null and ${table.check} is not null and ${table.storeId} is not null
          and ${table.waiveOverdueUntil} is null
        else ${table.salesOrderId} is null and ${table.taxDocumentId} is null
          and ${table.level} is null and ${table.projectId} is null and ${table.amountPaise} = 0
      end`,
    ),
    check('credit_approvals_amount_not_negative', sql`${table.amountPaise} >= 0`),
    check(
      'credit_approvals_decided',
      sql`(${table.status} = 'pending') = (${table.decidedAt} is null)
        and (${table.decidedAt} is null) = (${table.decidedByMemberId} is null)`,
    ),
    check(
      'credit_approvals_rejection_reason',
      sql`${table.status} <> 'rejected' or ${table.decisionReason} is not null`,
    ),
    check('credit_approvals_used', sql`(${table.status} = 'used') = (${table.usedAt} is not null)`),
    check(
      'credit_approvals_text_lengths',
      sql`char_length(${table.reason}) between 1 and 1000 and char_length(${table.decisionReason}) <= 1000`,
    ),
    pgPolicy('credit_approvals_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const siteAccountStatus = pgEnum('site_account_status', ['active', 'on_hold', 'closed']);

/**
 * A site (job) sub-account under a contractor (spec §3.3): its own limit and
 * status on one project, rolling up to the contractor's exposure. It holds no
 * ledger of its own: its figures come from the party's documents with that
 * project.
 */
export const siteCreditAccounts = pgTable(
  'site_credit_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    projectId: uuid('project_id').notNull(),
    limitPaise: bigint('limit_paise', { mode: 'number' }).notNull(),
    status: siteAccountStatus('status').notNull().default('active'),
    holdReason: text('hold_reason'),
    heldAt: timestamp('held_at', { withTimezone: true }),
    heldByMemberId: uuid('held_by_member_id'),
    notes: text('notes'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('site_credit_accounts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('site_credit_accounts_party_project_unique').on(
      table.organizationId,
      table.partyId,
      table.projectId,
    ),
    index('site_credit_accounts_project_idx').on(table.organizationId, table.projectId),
    foreignKey({
      name: 'site_credit_accounts_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'site_credit_accounts_project_fk',
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'site_credit_accounts_held_by_fk',
      columns: [table.organizationId, table.heldByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'site_credit_accounts_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('site_credit_accounts_limit_positive', sql`${table.limitPaise} > 0`),
    check(
      'site_credit_accounts_hold',
      sql`(${table.status} = 'on_hold') = (${table.holdReason} is not null)
        and (${table.holdReason} is null) = (${table.heldAt} is null)
        and (${table.heldAt} is null) = (${table.heldByMemberId} is null)`,
    ),
    check(
      'site_credit_accounts_text_lengths',
      sql`char_length(${table.holdReason}) <= 500 and char_length(${table.notes}) <= 4000`,
    ),
    pgPolicy('site_credit_accounts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** One nightly overdue check per business per India day (spec §4.4); append-only. */
export const creditHoldRuns = pgTable(
  'credit_hold_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    runOn: date('run_on', { mode: 'string' })
      .notNull()
      .default(sql`(now() at time zone 'Asia/Kolkata')::date`),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    /** Accounts put on hold by this run. */
    heldCount: integer('held_count').notNull(),
  },
  (table) => [
    unique('credit_hold_runs_organization_id_id_unique').on(table.organizationId, table.id),
    unique('credit_hold_runs_daily_unique').on(table.organizationId, table.runOn),
    foreignKey({
      name: 'credit_hold_runs_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    check('credit_hold_runs_held_count', sql`${table.heldCount} >= 0`),
    pgPolicy('credit_hold_runs_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// MVP 3 round 2a: collections (P2-M11), party messaging (P2-M32) and stored
// statement links (P2-M12); docs/mvp-3/credit-and-receivables.md §3.5.
// ---------------------------------------------------------------------------

/** Where a promise to pay stands: open until its date, then kept or broken. */
export const promiseStatus = pgEnum('promise_status', ['open', 'kept', 'broken', 'cancelled']);

/**
 * A customer's promise to pay an amount by a date (P2-M11). Kept when payments
 * received from the day it was made to its date, cheques not bounced, cover the
 * amount; otherwise the nightly collections job marks it broken and escalates.
 * One open promise per party. Moves forward only (trigger); audited.
 */
export const promisesToPay = pgTable(
  'promises_to_pay',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    /** India date the money was promised for. */
    promisedOn: date('promised_on', { mode: 'string' }).notNull(),
    /** India date the promise was made; payments from this day count. */
    madeOn: date('made_on', { mode: 'string' })
      .notNull()
      .default(sql`(now() at time zone 'Asia/Kolkata')::date`),
    status: promiseStatus('status').notNull().default('open'),
    note: text('note'),
    /** The `promise_to_pay` activity on the party's timeline. */
    activityId: uuid('activity_id'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Payments counted when it was settled (kept or broken). */
    paidPaise: bigint('paid_paise', { mode: 'number' }),
    /** When it was kept, broken or cancelled; null while open. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Who cancelled it; null for the job's kept / broken. */
    closedByMemberId: uuid('closed_by_member_id'),
    cancelReason: text('cancel_reason'),
  },
  (table) => [
    unique('promises_to_pay_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('promises_to_pay_one_open_per_party')
      .on(table.partyId)
      .where(sql`${table.status} = 'open'`),
    index('promises_to_pay_party_idx').on(table.organizationId, table.partyId, table.createdAt),
    index('promises_to_pay_open_due_idx')
      .on(table.organizationId, table.promisedOn)
      .where(sql`${table.status} = 'open'`),
    foreignKey({
      name: 'promises_to_pay_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'promises_to_pay_activity_fk',
      columns: [table.organizationId, table.activityId],
      foreignColumns: [activities.organizationId, activities.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'promises_to_pay_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'promises_to_pay_closed_by_fk',
      columns: [table.organizationId, table.closedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('promises_to_pay_amount_positive', sql`${table.amountPaise} > 0`),
    check('promises_to_pay_dates', sql`${table.promisedOn} >= ${table.madeOn}`),
    check(
      'promises_to_pay_closed',
      sql`(${table.status} = 'open') = (${table.closedAt} is null)
        and (${table.status} in ('kept', 'broken')) = (${table.paidPaise} is not null)
        and (${table.status} = 'cancelled') = (${table.cancelReason} is not null)
        and (${table.status} = 'cancelled') = (${table.closedByMemberId} is not null)
        and (${table.paidPaise} is null or ${table.paidPaise} >= 0)`,
    ),
    check(
      'promises_to_pay_text_lengths',
      sql`char_length(${table.note}) <= 1000 and char_length(${table.cancelReason}) between 1 and 500`,
    ),
    pgPolicy('promises_to_pay_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A broken promise raised to the people who can act (P2-M11): the party's
 * salesperson's branch managers and the party's store `credit:approve` holders.
 * One per promise. Never edited except to acknowledge it, once (trigger); audited.
 */
export const collectionEscalations = pgTable(
  'collection_escalations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    promiseId: uuid('promise_id').notNull(),
    /** India date it was raised. */
    raisedOn: date('raised_on', { mode: 'string' })
      .notNull()
      .default(sql`(now() at time zone 'Asia/Kolkata')::date`),
    /** Members told, for the record. */
    notifiedCount: integer('notified_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedByMemberId: uuid('acknowledged_by_member_id'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgeNote: text('acknowledge_note'),
  },
  (table) => [
    unique('collection_escalations_organization_id_id_unique').on(table.organizationId, table.id),
    unique('collection_escalations_promise_unique').on(table.promiseId),
    index('collection_escalations_open_idx')
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.acknowledgedAt} is null`),
    index('collection_escalations_party_idx').on(table.organizationId, table.partyId),
    foreignKey({
      name: 'collection_escalations_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_escalations_promise_fk',
      columns: [table.organizationId, table.promiseId],
      foreignColumns: [promisesToPay.organizationId, promisesToPay.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_escalations_acknowledged_by_fk',
      columns: [table.organizationId, table.acknowledgedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('collection_escalations_notified_count', sql`${table.notifiedCount} >= 0`),
    check(
      'collection_escalations_acknowledged',
      sql`(${table.acknowledgedAt} is null) = (${table.acknowledgedByMemberId} is null)
        and (${table.acknowledgeNote} is null or ${table.acknowledgedAt} is not null)
        and char_length(${table.acknowledgeNote}) between 1 and 1000`,
    ),
    pgPolicy('collection_escalations_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * One collections run per business per India day (P2-M11): promises settled,
 * escalations raised and reminders queued. Append-only, like credit_hold_runs.
 */
export const collectionRuns = pgTable(
  'collection_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    runOn: date('run_on', { mode: 'string' })
      .notNull()
      .default(sql`(now() at time zone 'Asia/Kolkata')::date`),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    keptCount: integer('kept_count').notNull(),
    brokenCount: integer('broken_count').notNull(),
    remindersQueued: integer('reminders_queued').notNull(),
  },
  (table) => [
    unique('collection_runs_organization_id_id_unique').on(table.organizationId, table.id),
    unique('collection_runs_daily_unique').on(table.organizationId, table.runOn),
    foreignKey({
      name: 'collection_runs_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    check(
      'collection_runs_counts',
      sql`${table.keptCount} >= 0 and ${table.brokenCount} >= 0 and ${table.remindersQueued} >= 0`,
    ),
    pgPolicy('collection_runs_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** How a message reaches a party. */
export const messageChannel = pgEnum('message_channel', ['whatsapp', 'sms', 'email']);

/** The languages messages and statements are written in. */
export const messageLanguage = pgEnum('message_language', ['en', 'hi', 'te']);

/**
 * When payment reminders go out (P2-M11): `offset_days` from a bill's due date
 * (negative = before it, 0 = on the day), on the channels listed. No rows = no
 * reminders. Audited.
 */
export const reminderSchedules = pgTable(
  'reminder_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    offsetDays: integer('offset_days').notNull(),
    channels: messageChannel('channels').array().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('reminder_schedules_organization_id_id_unique').on(table.organizationId, table.id),
    unique('reminder_schedules_offset_unique').on(table.organizationId, table.offsetDays),
    foreignKey({
      name: 'reminder_schedules_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'reminder_schedules_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('reminder_schedules_offset', sql`${table.offsetDays} between -30 and 90`),
    check(
      'reminder_schedules_channels',
      sql`cardinality(${table.channels}) between 1 and 3 and array_position(${table.channels}, null) is null`,
    ),
    pgPolicy('reminder_schedules_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const consentState = pgEnum('consent_state', ['granted', 'withdrawn']);

/** How consent was given or withdrawn (spec §6.2, after draft PR #51 CN-2). */
export const consentMethod = pgEnum('consent_method', [
  'counter_with_notice',
  'signed_form',
  'web_form',
  'whatsapp_reply',
]);

/**
 * A party's consent to messages on one channel at one address (P2-M32, [CA-3],
 * DPDP Act 2023 ss.5–7). Append-only: the current state is the latest row per
 * (party, channel); a message is sent only when that row is `granted` for the
 * address it goes to, checked when it is sent. Audited.
 */
export const messagingConsents = pgTable(
  'messaging_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    channel: messageChannel('channel').notNull(),
    /** E.164 mobile for WhatsApp and SMS, lowercase address for email. */
    address: text('address').notNull(),
    state: consentState('state').notNull(),
    method: consentMethod('method').notNull(),
    /** The notice shown, e.g. "2026-10"; and the language it was shown and messages go in. */
    noticeVersion: text('notice_version').notNull(),
    language: messageLanguage('language').notNull(),
    /** Null when the party withdrew by replying (STOP). */
    recordedByMemberId: uuid('recorded_by_member_id'),
    /** Clock time, so two records in one transaction keep their order. */
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('messaging_consents_organization_id_id_unique').on(table.organizationId, table.id),
    index('messaging_consents_party_idx').on(
      table.organizationId,
      table.partyId,
      table.channel,
      table.recordedAt,
    ),
    foreignKey({
      name: 'messaging_consents_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messaging_consents_recorded_by_fk',
      columns: [table.organizationId, table.recordedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'messaging_consents_address',
      sql`case ${table.channel} when 'email' then ${table.address} = lower(${table.address}) and ${table.address} ~ '^[^@[:space:]]+@[^@[:space:]]+$'
        else ${table.address} ~ '^\\+[1-9][0-9]{7,14}$' end`,
    ),
    check(
      'messaging_consents_member',
      sql`${table.recordedByMemberId} is not null or ${table.method} = 'whatsapp_reply'`,
    ),
    check(
      'messaging_consents_notice_version',
      sql`char_length(${table.noticeVersion}) between 1 and 40`,
    ),
    pgPolicy('messaging_consents_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** The messages the product sends parties (spec §6.2); bodies take `{{variable}}`s. */
export const messageTemplateKey = pgEnum('message_template_key', [
  'invoice_issued',
  'receipt_issued',
  'statement_ready',
  'payment_reminder_due',
  'payment_reminder_overdue',
  'promise_confirmed',
  'order_ready',
  'points_earned',
  'payment_request',
]);

/**
 * A business's own wording of a message for one channel and language (P2-M32).
 * No row = the product's default wording (@paint/shared). For WhatsApp the
 * wording must match the template the BSP approved, named by
 * `provider_template_name` ([PO-1]). Audited.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    key: messageTemplateKey('key').notNull(),
    channel: messageChannel('channel').notNull(),
    language: messageLanguage('language').notNull(),
    body: text('body').notNull(),
    providerTemplateName: text('provider_template_name'),
    isActive: boolean('is_active').notNull().default(true),
    updatedByMemberId: uuid('updated_by_member_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('message_templates_organization_id_id_unique').on(table.organizationId, table.id),
    unique('message_templates_key_unique').on(
      table.organizationId,
      table.key,
      table.channel,
      table.language,
    ),
    foreignKey({
      name: 'message_templates_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'message_templates_updated_by_fk',
      columns: [table.organizationId, table.updatedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('message_templates_body', sql`char_length(${table.body}) between 1 and 1000`),
    check(
      'message_templates_provider_name',
      sql`${table.providerTemplateName} ~ '^[a-z0-9_]{1,200}$'`,
    ),
    pgPolicy('message_templates_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * Where a message stands: queued until the worker tries it; sent (and later,
 * with a BSP, delivered and read); failed after its last attempt; skipped when
 * it may not go (no consent, no provider). Forward only (trigger).
 */
export const messageStatus = pgEnum('message_status', [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
]);

/**
 * Messages to parties waiting to be sent (P2-M32, the outbox pattern): written
 * in the business transaction, sent by the worker afterwards with retries;
 * the row id is the provider's idempotency key. `dedupe_key` makes a queued
 * message once-only (e.g. one reminder per party, channel and day).
 */
export const messageOutbox = pgTable(
  'message_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    channel: messageChannel('channel').notNull(),
    templateKey: messageTemplateKey('template_key').notNull(),
    language: messageLanguage('language').notNull(),
    /** E.164 mobile or email address, as consented. */
    toAddress: text('to_address').notNull(),
    /** The template's variables, all strings. */
    variables: jsonb('variables').$type<Record<string, string>>().notNull(),
    /** The text rendered from the template when queued (subject line first for email). */
    body: text('body').notNull(),
    /** What it is about, e.g. ('tax_document', id) or ('statement_link', id). */
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    dedupeKey: text('dedupe_key'),
    status: messageStatus('status').notNull().default('queued'),
    skipReason: text('skip_reason'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    /** The provider that sent it (log, a BSP) and its message id. */
    provider: text('provider'),
    providerRef: text('provider_ref'),
    /** Null when queued by the system (reminders, the collections job). */
    createdByMemberId: uuid('created_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    unique('message_outbox_organization_id_id_unique').on(table.organizationId, table.id),
    unique('message_outbox_dedupe_unique').on(table.organizationId, table.dedupeKey),
    index('message_outbox_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'queued'`),
    index('message_outbox_party_idx').on(table.organizationId, table.partyId, table.createdAt),
    foreignKey({
      name: 'message_outbox_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'message_outbox_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('message_outbox_attempts_not_negative', sql`${table.attempts} >= 0`),
    check('message_outbox_variables_object', sql`jsonb_typeof(${table.variables}) = 'object'`),
    check(
      'message_outbox_states',
      sql`(${table.status} in ('sent', 'delivered', 'read')) = (${table.sentAt} is not null)
        and (${table.status} in ('sent', 'delivered', 'read')) = (${table.providerRef} is not null)
        and (${table.status} = 'skipped') = (${table.skipReason} is not null)
        and (${table.referenceType} is null) = (${table.referenceId} is null)`,
    ),
    check(
      'message_outbox_text_lengths',
      sql`char_length(${table.body}) between 1 and 2000 and char_length(${table.toAddress}) <= 320
        and char_length(${table.skipReason}) <= 200 and char_length(${table.lastError}) <= 500
        and char_length(${table.dedupeKey}) <= 200 and char_length(${table.referenceType}) <= 40`,
    ),
    pgPolicy('message_outbox_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A stored, revocable link to a party's statement (P2-M12, spec §6.4): anyone
 * with the token may open the PDF until it expires or is revoked. Only the
 * SHA-256 of the token is kept. The PDF is rendered when opened, from the ledger
 * of that day. Audited (creation and revocation).
 */
export const statementLinks = pgTable(
  'statement_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    fromOn: date('from_on', { mode: 'string' }).notNull(),
    toOn: date('to_on', { mode: 'string' }).notNull(),
    language: messageLanguage('language').notNull(),
    /** Hex SHA-256 of the token in the link; unique across businesses. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByMemberId: uuid('revoked_by_member_id'),
    openedCount: integer('opened_count').notNull().default(0),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('statement_links_organization_id_id_unique').on(table.organizationId, table.id),
    unique('statement_links_token_hash_unique').on(table.tokenHash),
    index('statement_links_party_idx').on(table.organizationId, table.partyId, table.createdAt),
    foreignKey({
      name: 'statement_links_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'statement_links_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'statement_links_revoked_by_fk',
      columns: [table.organizationId, table.revokedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('statement_links_period', sql`${table.fromOn} <= ${table.toOn}`),
    check('statement_links_token_hash', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('statement_links_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'statement_links_revoked',
      sql`(${table.revokedAt} is null) = (${table.revokedByMemberId} is null)`,
    ),
    check(
      'statement_links_opened',
      sql`${table.openedCount} >= 0 and (${table.openedCount} = 0) = (${table.lastOpenedAt} is null)`,
    ),
    pgPolicy('statement_links_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// SaaS subscriptions (roadmap P2-M08; docs/mvp-3/subscriptions.md): what each
// business pays the platform. The current plan stays on organizations.plan; these
// tables hold how it is paid. Tenants read their own rows; every write is made by
// the platform (the API, after checking the owner), never in tenant scope.

export const subscriptionStatus = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'expired',
]);
export const billingInterval = pgEnum('billing_interval', ['monthly', 'annual']);
/**
 * How a subscription is collected: `manual` (our invoices, paid by bank transfer or
 * UPI and recorded by a platform operator), or a gateway: `razorpay`, or `fake` for
 * tests. Gateway webhooks name their gateway too. `log` is the payment-link provider
 * of development and demos (P2-M32); subscriptions never use it.
 */
export const paymentGateway = pgEnum('payment_gateway', ['manual', 'fake', 'razorpay', 'log']);
export const planChangeSource = pgEnum('plan_change_source', [
  'signup',
  'owner',
  'operator',
  'gateway',
]);
export const checkoutStatus = pgEnum('subscription_checkout_status', ['open', 'paid']);

const tenantReads = (name: string, organizationId: AnyColumn) =>
  pgPolicy(name, {
    for: 'select',
    to: tenantRole,
    using: sql`${organizationId} = ${currentOrganizationId}`,
  });

/** One per business: its trial, or the paid plan's billing and current period. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    status: subscriptionStatus('status').notNull(),
    /** Set for a paid plan; null on a trial. */
    billingInterval: billingInterval('billing_interval'),
    /** Stores billed each period. */
    storeQuantity: integer('store_quantity'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** When a renewal failed; the grace period runs from here. */
    pastDueSince: timestamp('past_due_since', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /**
     * Who collects: null for a trial or a plan the platform set by hand; `manual` for
     * our own invoices, where current_period_end is the end of the last period paid.
     */
    gateway: paymentGateway('gateway'),
    gatewaySubscriptionId: text('gateway_subscription_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('subscriptions_gateway_subscription_unique').on(
      table.gateway,
      table.gatewaySubscriptionId,
    ),
    check(
      'subscriptions_trial_end',
      sql`${table.status} <> 'trialing' or ${table.trialEndsAt} is not null`,
    ),
    check(
      'subscriptions_past_due_since',
      sql`(${table.status} = 'past_due') = (${table.pastDueSince} is not null)`,
    ),
    check(
      'subscriptions_gateway_id',
      sql`(${table.gateway} is null or ${table.gateway} = 'manual') = (${table.gatewaySubscriptionId} is null)`,
    ),
    check(
      'subscriptions_paid_billing',
      sql`(${table.gateway} is null) or (${table.billingInterval} is not null and ${table.storeQuantity} > 0 and ${table.currentPeriodEnd} is not null)`,
    ),
    check(
      'subscriptions_period_order',
      sql`${table.currentPeriodStart} is null or ${table.currentPeriodEnd} > ${table.currentPeriodStart}`,
    ),
    tenantReads('subscriptions_tenant_read', table.organizationId),
  ],
).enableRLS();

/** Every change of a business's plan, oldest first; never edited. */
export const subscriptionPlanChanges = pgTable(
  'subscription_plan_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null for the plan a business started on. */
    fromPlan: plan('from_plan'),
    toPlan: plan('to_plan').notNull(),
    billingInterval: billingInterval('billing_interval'),
    source: planChangeSource('source').notNull(),
    /** The owner who made it (source `owner`). */
    changedByMemberId: uuid('changed_by_member_id'),
    /** The platform operator who made it (source `operator`). */
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('subscription_plan_changes_organization_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'subscription_plan_changes_member_fk',
      columns: [table.organizationId, table.changedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'subscription_plan_changes_who',
      sql`(${table.source} = 'owner') = (${table.changedByMemberId} is not null)
        and (${table.source} = 'operator') = (${table.changedByUserId} is not null)`,
    ),
    tenantReads('subscription_plan_changes_tenant_read', table.organizationId),
  ],
).enableRLS();

/** A payment started at the gateway for a new paid plan; the plan changes once it is paid. */
export const subscriptionCheckouts = pgTable(
  'subscription_checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    plan: plan('plan').notNull(),
    billingInterval: billingInterval('billing_interval').notNull(),
    storeQuantity: integer('store_quantity').notNull(),
    /** Collected each period, GST included. */
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    gateway: paymentGateway('gateway').notNull(),
    gatewaySubscriptionId: text('gateway_subscription_id').notNull(),
    checkoutUrl: text('checkout_url').notNull(),
    status: checkoutStatus('status').notNull().default('open'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('subscription_checkouts_gateway_unique').on(
      table.gateway,
      table.gatewaySubscriptionId,
    ),
    index('subscription_checkouts_organization_idx').on(table.organizationId, table.createdAt),
    foreignKey({
      name: 'subscription_checkouts_member_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('subscription_checkouts_plan_paid', sql`${table.plan} <> 'trial'`),
    check('subscription_checkouts_quantity', sql`${table.storeQuantity} > 0`),
    check('subscription_checkouts_total', sql`${table.totalPaise} > 0`),
    check(
      'subscription_checkouts_paid_at',
      sql`(${table.status} = 'paid') = (${table.paidAt} is not null)`,
    ),
    tenantReads('subscription_checkouts_tenant_read', table.organizationId),
  ],
).enableRLS();

/** A party block printed on our invoice, as it stood when issued. */
export interface SubscriptionInvoiceParty {
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly gstin: string | null;
  readonly addressLines: readonly string[];
  readonly city: string | null;
  readonly pincode: string | null;
  /** GST state code; null when the business has given none. */
  readonly stateCode: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * Our GST tax invoices to subscribing businesses, numbered in the platform's own
 * series (gap-free per financial year). Never edited; the amounts are a copy of
 * what the GST engine computed, which reprints identically from the inputs here.
 */
export const subscriptionInvoices = pgTable(
  'subscription_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    number: text('number').notNull().unique(),
    financialYear: text('financial_year').notNull(),
    serial: integer('serial').notNull(),
    /** India date of issue. */
    issuedOn: date('issued_on', { mode: 'string' }).notNull(),
    plan: plan('plan').notNull(),
    billingInterval: billingInterval('billing_interval').notNull(),
    storeQuantity: integer('store_quantity').notNull(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    sacCode: text('sac_code').notNull(),
    rateBps: integer('rate_bps').notNull(),
    placeOfSupply: text('place_of_supply').notNull(),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull(),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull(),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull(),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    supplier: jsonb('supplier').$type<SubscriptionInvoiceParty>().notNull(),
    buyer: jsonb('buyer').$type<SubscriptionInvoiceParty>().notNull(),
    /** India date it is payable by; the day of issue when a gateway took the money. */
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    /** `manual`: raised by us, paid by transfer (subscription_payments); else paid at the gateway. */
    gateway: paymentGateway('gateway').notNull(),
    /** The gateway's payment; null for a `manual` invoice. */
    gatewayPaymentId: text('gateway_payment_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('subscription_invoices_serial_unique').on(table.financialYear, table.serial),
    unique('subscription_invoices_organization_id_unique').on(table.organizationId, table.id),
    // One manual invoice per period: the renewal job raises each once.
    uniqueIndex('subscription_invoices_manual_period_unique')
      .on(table.organizationId, table.periodStart)
      .where(sql`${table.gateway} = 'manual'`),
    check(
      'subscription_invoices_gateway_payment',
      sql`(${table.gateway} = 'manual') = (${table.gatewayPaymentId} is null)`,
    ),
    check('subscription_invoices_due', sql`${table.dueOn} >= ${table.issuedOn}`),
    // One invoice per payment, however often the gateway reports it.
    uniqueIndex('subscription_invoices_payment_unique').on(table.gateway, table.gatewayPaymentId),
    index('subscription_invoices_organization_idx').on(
      table.organizationId,
      table.issuedOn.desc().nullsFirst(),
      table.serial.desc().nullsFirst(),
    ),
    check('subscription_invoices_plan_paid', sql`${table.plan} <> 'trial'`),
    check('subscription_invoices_quantity', sql`${table.storeQuantity} > 0`),
    check(
      'subscription_invoices_total',
      sql`${table.totalPaise} = ${table.taxablePaise} + ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise}`,
    ),
    check('subscription_invoices_period', sql`${table.periodEnd} >= ${table.periodStart}`),
    tenantReads('subscription_invoices_tenant_read', table.organizationId),
  ],
).enableRLS();

export const subscriptionPaymentMode = pgEnum('subscription_payment_mode', [
  'bank_transfer',
  'upi',
  'cheque',
  'other',
]);

/**
 * A payment a platform operator recorded against one of our manual invoices: it
 * settles the invoice (one per invoice) and pays for the invoice's period. Never
 * edited.
 */
export const subscriptionPayments = pgTable(
  'subscription_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').notNull().unique(),
    /** What arrived; less than the invoice when the business deducted TDS ([CA-8]). */
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    /** India date the money arrived. */
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    mode: subscriptionPaymentMode('mode').notNull(),
    /** The bank's UTR, the UPI reference or the cheque number. */
    reference: text('reference').notNull(),
    recordedByUserId: uuid('recorded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'subscription_payments_invoice_fk',
      columns: [table.organizationId, table.invoiceId],
      foreignColumns: [subscriptionInvoices.organizationId, subscriptionInvoices.id],
    }).onDelete('restrict'),
    check('subscription_payments_amount', sql`${table.amountPaise} > 0`),
    check(
      'subscription_payments_reference',
      sql`length(btrim(${table.reference})) between 1 and 100`,
    ),
    tenantReads('subscription_payments_tenant_read', table.organizationId),
  ],
).enableRLS();

export const planRequestStatus = pgEnum('subscription_plan_request_status', [
  'open',
  'applied',
  'cancelled',
]);

/**
 * With manual invoicing, the owner asks for a plan and a platform operator applies
 * it (docs/mvp-3/subscriptions.md §3.2). At most one open request per business; a
 * newer one cancels it. Decided once.
 */
export const subscriptionPlanRequests = pgTable(
  'subscription_plan_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    plan: plan('plan').notNull(),
    billingInterval: billingInterval('billing_interval').notNull(),
    status: planRequestStatus('status').notNull().default('open'),
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The operator who applied or declined it; null when a newer request replaced it. */
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('subscription_plan_requests_open_unique')
      .on(table.organizationId)
      .where(sql`${table.status} = 'open'`),
    index('subscription_plan_requests_organization_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'subscription_plan_requests_member_fk',
      columns: [table.organizationId, table.requestedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('subscription_plan_requests_plan_paid', sql`${table.plan} <> 'trial'`),
    check(
      'subscription_plan_requests_decided',
      sql`(${table.status} = 'open') = (${table.decidedAt} is null)
        and (${table.status} <> 'applied' or ${table.decidedByUserId} is not null)`,
    ),
    tenantReads('subscription_plan_requests_tenant_read', table.organizationId),
  ],
).enableRLS();

/** The platform invoice series' last number per financial year. Platform only. */
export const subscriptionInvoiceSequences = pgTable('subscription_invoice_sequences', {
  financialYear: text('financial_year').primaryKey(),
  lastValue: integer('last_value').notNull(),
  // Row-level security with no tenant policy: tenants can never see a row.
}).enableRLS();

/**
 * Every webhook event a payment gateway sent, kept so each is applied once, whatever
 * it is about (a SaaS subscription now, a payment link with P2-M32). Platform only.
 */
export const paymentGatewayEvents = pgTable(
  'payment_gateway_events',
  {
    gateway: paymentGateway('gateway').notNull(),
    eventId: text('event_id').notNull(),
    /** The gateway's own name for the event. */
    type: text('type').notNull(),
    /** The gateway's id of what the event is about (a subscription, a payment link). */
    objectId: text('object_id'),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.gateway, table.eventId] })],
).enableRLS();

// ---------------------------------------------------------------------------
// UPI payment links (roadmap P2-M32, MVP 3 round 4a; docs/mvp-3/credit-and-receivables.md
// §6.2): a request to a party for money, paid through a gateway whose webhook records
// and allocates the payment by itself.

/** What a link asks the party to pay. */
export const paymentLinkPurpose = pgEnum('payment_link_purpose', [
  /** One invoice, bill of supply or debit note. */
  'invoice',
  /** The party's bills past their due date. */
  'overdue',
  /** Everything the party owes (a statement's balance). */
  'outstanding',
  /** The bills a reminder named. */
  'bills',
  /** Money ahead of any bill: allocated to nothing. */
  'advance',
]);
/** Who made the link: a member, the reminder run, or a statement share. */
export const paymentLinkOrigin = pgEnum('payment_link_origin', ['staff', 'reminder', 'statement']);
export const paymentLinkStatus = pgEnum('payment_link_status', [
  'created',
  'paid',
  'expired',
  'cancelled',
]);

/**
 * A payment link (P2-M32): an amount asked of a party for some documents, created at a
 * gateway (`provider`, `gateway_reference`, `url`). Payments the gateway reports are
 * recorded in `payments` (`payment_link_id`) at the link's store. Only its status and
 * what was paid change, forward only (trigger, migration 0080).
 */
export const paymentLinks = pgTable(
  'payment_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** PL-000001, gap-free per business; sent to the gateway as our reference. */
    number: text('number').notNull(),
    /** Where its payments are recorded: the invoice's store, else the party's home store. */
    storeId: uuid('store_id').notNull(),
    partyId: uuid('party_id').notNull(),
    purpose: paymentLinkPurpose('purpose').notNull(),
    origin: paymentLinkOrigin('origin').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    /** What the customer sees at the gateway. */
    description: text('description').notNull(),
    provider: paymentGateway('provider').notNull(),
    /** The gateway's id of the link; its webhooks name it. */
    gatewayReference: text('gateway_reference').notNull(),
    url: text('url').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: paymentLinkStatus('status').notNull().default('created'),
    /** Σ payments the gateway reported for it; may pass the amount (the rest is an advance). */
    paidPaise: bigint('paid_paise', { mode: 'number' }).notNull().default(0),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Null when the gateway cancelled it. */
    cancelledByMemberId: uuid('cancelled_by_member_id'),
    /** Null when the system made it (a reminder). */
    createdByMemberId: uuid('created_by_member_id'),
    ...timestamps,
  },
  (table) => [
    unique('payment_links_organization_id_id_unique').on(table.organizationId, table.id),
    // Payments and documents name the link's own party.
    unique('payment_links_organization_id_party_unique').on(
      table.organizationId,
      table.id,
      table.partyId,
    ),
    unique('payment_links_number_unique').on(table.organizationId, table.number),
    unique('payment_links_gateway_reference_unique').on(table.provider, table.gatewayReference),
    index('payment_links_party_idx').on(
      table.organizationId,
      table.partyId,
      table.createdAt.desc().nullsFirst(),
    ),
    index('payment_links_organization_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'payment_links_store_fk',
      columns: [table.organizationId, table.storeId],
      foreignColumns: [stores.organizationId, stores.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_links_party_fk',
      columns: [table.organizationId, table.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_links_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_links_cancelled_by_fk',
      columns: [table.organizationId, table.cancelledByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('payment_links_number_format', sql`${table.number} ~ '^PL-[0-9]{6,}$'`),
    check('payment_links_amount_positive', sql`${table.amountPaise} > 0`),
    check('payment_links_paid', sql`${table.paidPaise} >= 0`),
    check('payment_links_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'payment_links_status',
      sql`(${table.status} = 'paid') = (${table.paidAt} is not null)
        and (${table.status} <> 'cancelled' or ${table.cancelledAt} is not null)
        and (${table.cancelledAt} is null or ${table.status} in ('cancelled', 'paid'))
        and (${table.cancelledByMemberId} is null or ${table.cancelledAt} is not null)`,
    ),
    check(
      'payment_links_text_lengths',
      sql`char_length(${table.description}) between 1 and 200
        and char_length(${table.gatewayReference}) between 1 and 200
        and char_length(${table.url}) between 1 and 500`,
    ),
    pgPolicy('payment_links_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * The documents a link pays, oldest first (`position`): an invoice, bill of supply or
 * debit note, or an opening balance or charge in the party ledger, all of the link's
 * party. Written with the link, never changed (migration 0080).
 */
export const paymentLinkDocuments = pgTable(
  'payment_link_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    linkId: uuid('link_id').notNull(),
    partyId: uuid('party_id').notNull(),
    documentId: uuid('document_id'),
    partyLedgerId: uuid('party_ledger_id'),
    position: integer('position').notNull(),
    /** What was owed on it when the link was made. */
    outstandingPaise: bigint('outstanding_paise', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('payment_link_documents_position_unique').on(table.linkId, table.position),
    unique('payment_link_documents_document_unique').on(table.linkId, table.documentId),
    unique('payment_link_documents_ledger_unique').on(table.linkId, table.partyLedgerId),
    index('payment_link_documents_document_idx')
      .on(table.documentId)
      .where(sql`${table.documentId} is not null`),
    foreignKey({
      name: 'payment_link_documents_link_fk',
      columns: [table.organizationId, table.linkId, table.partyId],
      foreignColumns: [paymentLinks.organizationId, paymentLinks.id, paymentLinks.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_link_documents_document_fk',
      columns: [table.organizationId, table.documentId, table.partyId],
      foreignColumns: [taxDocuments.organizationId, taxDocuments.id, taxDocuments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_link_documents_party_ledger_fk',
      columns: [table.organizationId, table.partyLedgerId, table.partyId],
      foreignColumns: [partyLedger.organizationId, partyLedger.id, partyLedger.partyId],
    }).onDelete('restrict'),
    check(
      'payment_link_documents_one_target',
      sql`num_nonnulls(${table.documentId}, ${table.partyLedgerId}) = 1`,
    ),
    check(
      'payment_link_documents_amounts',
      sql`${table.position} >= 0 and ${table.outstandingPaise} > 0`,
    ),
    pgPolicy('payment_link_documents_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Each business's own payment gateway account and gateway refunds (P2-M32, MVP 3
// round 4c; docs/mvp-3/payment-links.md): [PO-40] money goes straight to the shop,
// [PO-44] money a link took that nothing was owed for goes back through the gateway.

/**
 * A business's connection to its own gateway account (Razorpay). The key id, key
 * secret and webhook secret are sealed together with envelope encryption (a fresh data
 * key per sealing, wrapped by GATEWAY_CREDENTIALS_KEY; apps/api/src/payment-links/
 * credential-vault.ts); only hints (last four characters) are kept in the clear.
 * `webhook_ref` names the business in its webhook URL and survives reconnecting.
 * Disconnecting clears the credentials but keeps the row. Never deleted (0082).
 */
export const paymentGatewayAccounts = pgTable(
  'payment_gateway_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    gateway: paymentGateway('gateway').notNull(),
    /** Random, URL-safe: /webhooks/payment-links/razorpay/<webhook_ref>. */
    webhookRef: text('webhook_ref').notNull(),
    /** The last four characters of each, for the settings screen. */
    keyIdHint: text('key_id_hint'),
    keySecretHint: text('key_secret_hint'),
    webhookSecretHint: text('webhook_secret_hint'),
    /** Live keys (rzp_live_…) take real money; test keys (rzp_test_…) do not. */
    live: boolean('live'),
    /** `v1:<master key id>:<wrapped data key>:<sealed credentials>`: never leaves the API. */
    credentialsSealed: text('credentials_sealed'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    connectedByMemberId: uuid('connected_by_member_id'),
    /** The last time the keys answered a test call. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('payment_gateway_accounts_organization_unique').on(table.organizationId),
    unique('payment_gateway_accounts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('payment_gateway_accounts_webhook_ref_unique').on(table.webhookRef),
    foreignKey({
      name: 'payment_gateway_accounts_connected_by_fk',
      columns: [table.organizationId, table.connectedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('payment_gateway_accounts_gateway', sql`${table.gateway}::text = 'razorpay'`),
    check('payment_gateway_accounts_webhook_ref', sql`${table.webhookRef} ~ '^[A-Za-z0-9_-]{22}$'`),
    check(
      'payment_gateway_accounts_connected',
      sql`num_nonnulls(${table.keyIdHint}, ${table.keySecretHint}, ${table.webhookSecretHint},
          ${table.live}, ${table.credentialsSealed}, ${table.connectedAt}) in (0, 6)
        and (${table.connectedByMemberId} is null or ${table.connectedAt} is not null)
        and (${table.verifiedAt} is null or ${table.connectedAt} is not null)`,
    ),
    check(
      'payment_gateway_accounts_hints',
      sql`char_length(${table.keyIdHint}) = 4 and char_length(${table.keySecretHint}) = 4
        and char_length(${table.webhookSecretHint}) = 4
        and ${table.credentialsSealed} ~ '^v1:' and char_length(${table.credentialsSealed}) <= 4000`,
    ),
    pgPolicy('payment_gateway_accounts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** Why money a link took goes back. */
export const paymentLinkRefundReason = pgEnum('payment_link_refund_reason', [
  /** The link's bills were settled some other way before the money came. */
  'settled',
  /** More came than the link's bills still owed. */
  'overpaid',
]);
/**
 * `pending`: to be asked of the gateway (again, after a failed try); `refunded`: the
 * gateway took it and it is in the books; `failed`: it gave up after its tries, the money
 * stays an advance; `dropped`: staff used or refunded the money meanwhile; `returned`:
 * the gateway took it but failed it later, so the money came back as an advance.
 */
export const paymentLinkRefundStatus = pgEnum('payment_link_refund_status', [
  'pending',
  'refunded',
  'failed',
  'dropped',
  'returned',
]);

/**
 * A refund through the gateway of money a link payment left over ([PO-44]): booked as
 * MVP 2 refunds are (a refund payment out of the link payment, party ledger, refund
 * voucher) once the gateway takes it. Idempotent: the row id is the gateway's refund
 * receipt. Its amount and what it refunds never change; the status moves forward only
 * (trigger, 0082).
 */
export const paymentLinkRefunds = pgTable(
  'payment_link_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    linkId: uuid('link_id').notNull(),
    partyId: uuid('party_id').notNull(),
    /** The money in it pays back part of. */
    paymentId: uuid('payment_id').notNull(),
    /** The gateway's id of the payment the money came in by. */
    gatewayPaymentId: text('gateway_payment_id').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    reason: paymentLinkRefundReason('reason').notNull(),
    provider: paymentGateway('provider').notNull(),
    status: paymentLinkRefundStatus('status').notNull().default('pending'),
    gatewayRefundId: text('gateway_refund_id'),
    /** pending / processed / failed, as the gateway last said. */
    gatewayStatus: text('gateway_status'),
    /** The refund payment (RF-…) once booked. */
    refundPaymentId: uuid('refund_payment_id'),
    /** The money back in when the gateway failed the refund after taking it. */
    returnedPaymentId: uuid('returned_payment_id'),
    /** The refund this one tries again, after the gateway returned it. */
    retryOfId: uuid('retry_of_id'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** Why the last try failed: the gateway's error code, never a key. */
    lastError: text('last_error'),
    /** When staff were told it failed (once). */
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('payment_link_refunds_organization_id_id_unique').on(table.organizationId, table.id),
    unique('payment_link_refunds_gateway_unique').on(table.provider, table.gatewayRefundId),
    index('payment_link_refunds_link_idx').on(table.linkId),
    index('payment_link_refunds_payment_idx').on(table.paymentId),
    index('payment_link_refunds_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: 'payment_link_refunds_link_fk',
      columns: [table.organizationId, table.linkId, table.partyId],
      foreignColumns: [paymentLinks.organizationId, paymentLinks.id, paymentLinks.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_link_refunds_payment_fk',
      columns: [table.organizationId, table.paymentId, table.partyId],
      foreignColumns: [payments.organizationId, payments.id, payments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_link_refunds_refund_payment_fk',
      columns: [table.organizationId, table.refundPaymentId, table.partyId],
      foreignColumns: [payments.organizationId, payments.id, payments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_link_refunds_returned_payment_fk',
      columns: [table.organizationId, table.returnedPaymentId, table.partyId],
      foreignColumns: [payments.organizationId, payments.id, payments.partyId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_link_refunds_retry_of_fk',
      columns: [table.organizationId, table.retryOfId],
      foreignColumns: [table.organizationId, table.id],
    }).onDelete('restrict'),
    check('payment_link_refunds_amount_positive', sql`${table.amountPaise} > 0`),
    check('payment_link_refunds_attempts', sql`${table.attempts} >= 0`),
    check(
      'payment_link_refunds_status',
      sql`(${table.status} in ('refunded', 'returned')) = (${table.refundPaymentId} is not null)
        and (${table.refundPaymentId} is null or ${table.gatewayRefundId} is not null)
        and (${table.status} in ('refunded', 'returned')) = (${table.refundedAt} is not null)
        and (${table.status} = 'returned') = (${table.returnedPaymentId} is not null)`,
    ),
    check(
      'payment_link_refunds_text_lengths',
      sql`char_length(${table.gatewayPaymentId}) between 1 and 200
        and char_length(${table.gatewayRefundId}) between 1 and 200
        and char_length(${table.gatewayStatus}) <= 40 and char_length(${table.lastError}) <= 200`,
    ),
    pgPolicy('payment_link_refunds_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Brand schemes, targets and rebates (roadmap P2-M33, MVP 3 round 5a;
// docs/mvp-3/credit-and-receivables.md §3.8 and §6.3): a brand's slab scheme over a
// period, what each slab gives, what the brand has issued against it, and the claims
// filed with the brand. Progress and expected benefits are computed by the pure
// engines in @paint/shared (`schemeProgress`, `schemeClaim`) from the brand's GRNs.

/** What slab targets count: purchase value at cost (paise) or paint (millilitres). */
export const brandSchemeMeasure = pgEnum('brand_scheme_measure', ['value', 'litres']);
/** `retro`: the slab reached pays on everything; `incremental`: each slab on its band ([PO-30]). */
export const brandSchemeMode = pgEnum('brand_scheme_mode', ['retro', 'incremental']);
/** Which day puts a GRN in a scheme's period ([CA-21]): the GRN's own, or the supplier invoice's. */
export const brandSchemeDateBasis = pgEnum('brand_scheme_date_basis', ['grn_date', 'invoice_date']);
/**
 * `draft`: being entered, not counted anywhere; `active`: counted (progress, claims,
 * dashboard, profitability); `closed`: nothing more is expected from the brand (what
 * is still owed is written off); `cancelled`: the brand withdrew it. Forward only:
 * draft → active / cancelled, active → closed / cancelled (trigger, 0084).
 */
export const brandSchemeStatus = pgEnum('brand_scheme_status', [
  'draft',
  'active',
  'closed',
  'cancelled',
]);

/**
 * A brand's scheme (P2-M33): a period (both days included), what it counts (value or
 * litres, retro or incremental), the products or categories it covers
 * (`brand_scheme_items`; none = every product of the brand), its slabs, and the days
 * after the period the brand settles in (null = 45, [PO-32]). The brand never changes;
 * a closed or cancelled scheme never changes again (trigger, 0084). Audited.
 */
export const brandSchemes = pgTable(
  'brand_schemes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    /** The brand's own code or circular number for the scheme. */
    brandReference: text('brand_reference'),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    measure: brandSchemeMeasure('measure').notNull(),
    mode: brandSchemeMode('mode').notNull().default('retro'),
    /** Days after `ends_on` the brand settles in; null = 45 ([PO-32]). */
    settlementDays: integer('settlement_days'),
    dateBasis: brandSchemeDateBasis('date_basis').notNull().default('grn_date'),
    status: brandSchemeStatus('status').notNull().default('draft'),
    note: text('note'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    /** When it was closed or cancelled, by whom and why. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByMemberId: uuid('ended_by_member_id'),
    endNote: text('end_note'),
    ...timestamps,
  },
  (table) => [
    unique('brand_schemes_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('brand_schemes_brand_name_unique').on(
      table.organizationId,
      table.brandId,
      sql`lower(${table.name})`,
    ),
    index('brand_schemes_brand_period_idx').on(
      table.organizationId,
      table.brandId,
      table.startsOn,
      table.endsOn,
    ),
    foreignKey({
      name: 'brand_schemes_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'brand_schemes_brand_fk',
      columns: [table.organizationId, table.brandId],
      foreignColumns: [brands.organizationId, brands.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_schemes_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_schemes_ended_by_fk',
      columns: [table.organizationId, table.endedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'brand_schemes_text',
      sql`${table.name} = btrim(${table.name}) and char_length(${table.name}) between 1 and 120
        and char_length(${table.brandReference}) between 1 and 60
        and char_length(${table.note}) <= 500 and char_length(${table.endNote}) <= 500`,
    ),
    check(
      'brand_schemes_period',
      sql`${table.endsOn} >= ${table.startsOn} and ${table.endsOn} - ${table.startsOn} < 731`,
    ),
    check('brand_schemes_settlement_days', sql`${table.settlementDays} between 0 and 365`),
    check(
      'brand_schemes_ended',
      sql`(${table.status} in ('closed', 'cancelled')) = (${table.endedAt} is not null)
        and (${table.endedByMemberId} is null or ${table.endedAt} is not null)
        and (${table.endNote} is null or ${table.endedAt} is not null)`,
    ),
    pgPolicy('brand_schemes_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A product or category a scheme covers (exactly one of the two). A scheme with no
 * items covers every product of its brand; with items, a GRN line counts when its
 * product or its product's category is named.
 */
export const brandSchemeItems = pgTable(
  'brand_scheme_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    productId: uuid('product_id'),
    categoryId: uuid('category_id'),
  },
  (table) => [
    uniqueIndex('brand_scheme_items_product_unique')
      .on(table.schemeId, table.productId)
      .where(sql`${table.productId} is not null`),
    uniqueIndex('brand_scheme_items_category_unique')
      .on(table.schemeId, table.categoryId)
      .where(sql`${table.categoryId} is not null`),
    foreignKey({
      name: 'brand_scheme_items_scheme_fk',
      columns: [table.organizationId, table.schemeId],
      foreignColumns: [brandSchemes.organizationId, brandSchemes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'brand_scheme_items_product_fk',
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_scheme_items_category_fk',
      columns: [table.organizationId, table.categoryId],
      foreignColumns: [categories.organizationId, categories.id],
    }).onDelete('restrict'),
    check('brand_scheme_items_one', sql`num_nonnulls(${table.productId}, ${table.categoryId}) = 1`),
    pgPolicy('brand_scheme_items_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * A slab of a scheme: its target in the scheme's measure (paise or millilitres),
 * 1-based `position`, targets rising with position (checked by the API with the
 * engine's `assertScheme`). Audited (insert and delete: editing replaces them).
 */
export const brandSchemeSlabs = pgTable(
  'brand_scheme_slabs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    position: integer('position').notNull(),
    /** Paise for a value scheme, millilitres for a litres one. */
    target: bigint('target', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('brand_scheme_slabs_organization_id_id_unique').on(table.organizationId, table.id),
    unique('brand_scheme_slabs_scheme_id_unique').on(
      table.organizationId,
      table.id,
      table.schemeId,
    ),
    unique('brand_scheme_slabs_position_unique').on(table.schemeId, table.position),
    unique('brand_scheme_slabs_target_unique').on(table.schemeId, table.target),
    foreignKey({
      name: 'brand_scheme_slabs_scheme_fk',
      columns: [table.organizationId, table.schemeId],
      foreignColumns: [brandSchemes.organizationId, brandSchemes.id],
    }).onDelete('cascade'),
    check('brand_scheme_slabs_position', sql`${table.position} between 1 and 20`),
    check(
      'brand_scheme_slabs_target',
      sql`${table.target} > 0 and ${table.target} <= 9007199254740991`,
    ),
    pgPolicy('brand_scheme_slabs_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What a slab gives (the engine's `SlabBenefit`). */
export const brandSchemeBenefitKind = pgEnum('brand_scheme_benefit_kind', [
  /** `basis_points` of the purchase value. */
  'rebate',
  /** `paise_per_litre` of the litres. */
  'per_litre',
  /** `units` of `variant_id`, once, or per whole `per_millilitres` when set. */
  'free_goods',
  /** `points` gift or trip points under `label`, once. */
  'points',
]);

/**
 * One benefit of a slab, with exactly the columns its kind needs. An incremental
 * scheme refuses a benefit on the other basis than its target ([PO-31]): the API
 * checks that with the engine. Audited (insert and delete).
 */
export const brandSchemeBenefits = pgTable(
  'brand_scheme_benefits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    slabId: uuid('slab_id').notNull(),
    position: integer('position').notNull(),
    kind: brandSchemeBenefitKind('kind').notNull(),
    basisPoints: integer('basis_points'),
    paisePerLitre: integer('paise_per_litre'),
    variantId: uuid('variant_id'),
    units: integer('units'),
    perMillilitres: bigint('per_millilitres', { mode: 'number' }),
    label: text('label'),
    points: integer('points'),
  },
  (table) => [
    unique('brand_scheme_benefits_position_unique').on(table.slabId, table.position),
    index('brand_scheme_benefits_scheme_idx').on(table.organizationId, table.schemeId),
    foreignKey({
      name: 'brand_scheme_benefits_slab_fk',
      columns: [table.organizationId, table.slabId, table.schemeId],
      foreignColumns: [
        brandSchemeSlabs.organizationId,
        brandSchemeSlabs.id,
        brandSchemeSlabs.schemeId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'brand_scheme_benefits_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    check('brand_scheme_benefits_position', sql`${table.position} between 1 and 10`),
    check(
      'brand_scheme_benefits_kind',
      sql`(${table.kind} = 'rebate') = (${table.basisPoints} is not null)
        and (${table.kind} = 'per_litre') = (${table.paisePerLitre} is not null)
        and (${table.kind} = 'free_goods') = (${table.variantId} is not null)
        and (${table.kind} = 'free_goods') = (${table.units} is not null)
        and (${table.perMillilitres} is null or ${table.kind} = 'free_goods')
        and (${table.kind} = 'points') = (${table.label} is not null)
        and (${table.kind} = 'points') = (${table.points} is not null)`,
    ),
    check(
      'brand_scheme_benefits_amounts',
      sql`${table.basisPoints} between 1 and 10000 and ${table.paisePerLitre} between 1 and 100000000
        and ${table.units} between 1 and 1000000 and ${table.perMillilitres} > 0
        and ${table.points} between 1 and 100000000
        and ${table.label} = btrim(${table.label}) and char_length(${table.label}) between 1 and 60`,
    ),
    pgPolicy('brand_scheme_benefits_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** `filed` → `acknowledged` → `settled` / `rejected`; `filed` or `acknowledged` → `withdrawn`. */
export const brandClaimStatus = pgEnum('brand_claim_status', [
  'filed',
  'acknowledged',
  'settled',
  'rejected',
  'withdrawn',
]);

/**
 * A claim filed with the brand for a scheme's benefits (SC-000001): the money claimed
 * and the brand's reference, followed up to settled, rejected or withdrawn. What is
 * still owed and its age come from the engine (`schemeClaim`); this row is the
 * follow-up. Amount and scheme fixed, status forward only (trigger, 0084). Audited.
 */
export const brandClaims = pgTable(
  'brand_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    /** SC-000001, gap-free per business. */
    number: text('number').notNull(),
    filedOn: date('filed_on', { mode: 'string' }).notNull(),
    claimedPaise: bigint('claimed_paise', { mode: 'number' }).notNull(),
    /** The brand's own claim or ticket number. */
    brandReference: text('brand_reference'),
    note: text('note'),
    status: brandClaimStatus('status').notNull().default('filed'),
    filedByMemberId: uuid('filed_by_member_id').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByMemberId: uuid('resolved_by_member_id'),
    resolutionNote: text('resolution_note'),
    ...timestamps,
  },
  (table) => [
    unique('brand_claims_organization_id_id_unique').on(table.organizationId, table.id),
    unique('brand_claims_scheme_id_unique').on(table.organizationId, table.id, table.schemeId),
    unique('brand_claims_number_unique').on(table.organizationId, table.number),
    index('brand_claims_scheme_idx').on(table.organizationId, table.schemeId),
    foreignKey({
      name: 'brand_claims_scheme_fk',
      columns: [table.organizationId, table.schemeId],
      foreignColumns: [brandSchemes.organizationId, brandSchemes.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_claims_filed_by_fk',
      columns: [table.organizationId, table.filedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_claims_resolved_by_fk',
      columns: [table.organizationId, table.resolvedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('brand_claims_number_format', sql`${table.number} ~ '^SC-[0-9]{6,}$'`),
    check('brand_claims_claimed', sql`${table.claimedPaise} >= 0`),
    check(
      'brand_claims_resolved',
      sql`(${table.status} in ('settled', 'rejected', 'withdrawn')) = (${table.resolvedAt} is not null)
        and (${table.resolvedByMemberId} is null or ${table.resolvedAt} is not null)
        and (${table.resolutionNote} is null or ${table.resolvedAt} is not null)`,
    ),
    check(
      'brand_claims_text',
      sql`char_length(${table.brandReference}) between 1 and 60
        and char_length(${table.note}) <= 500 and char_length(${table.resolutionNote}) <= 500`,
    ),
    pgPolicy('brand_claims_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What the brand issued: money (credit note or payment), free goods, or points. */
export const brandBenefitReceiptKind = pgEnum('brand_benefit_receipt_kind', [
  'money',
  'free_goods',
  'points',
]);
/** How scheme money came ([CA-6]): a credit note against our purchases, or a payment. */
export const brandBenefitMoneyForm = pgEnum('brand_benefit_money_form', ['credit_note', 'payment']);

/**
 * Something the brand issued against a scheme (the engine's `ReceivedBenefit`): a
 * credit note or payment in paise, free units of a variant (perhaps on a GRN), or
 * points under a label, dated and with the brand's reference. A negative amount,
 * units or points reverses an earlier entry. Append-only (trigger, 0084); never on a
 * draft or cancelled scheme. Audited.
 */
export const brandBenefitReceipts = pgTable(
  'brand_benefit_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    /** The claim it answers, if any (of the same scheme). */
    claimId: uuid('claim_id'),
    kind: brandBenefitReceiptKind('kind').notNull(),
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }),
    moneyForm: brandBenefitMoneyForm('money_form'),
    variantId: uuid('variant_id'),
    units: integer('units'),
    /** The GRN the free goods came in on. */
    goodsReceiptId: uuid('goods_receipt_id'),
    label: text('label'),
    points: integer('points'),
    /** The brand's credit note, letter or GRN number. */
    reference: text('reference'),
    note: text('note'),
    recordedByMemberId: uuid('recorded_by_member_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('brand_benefit_receipts_organization_id_id_unique').on(table.organizationId, table.id),
    index('brand_benefit_receipts_scheme_idx').on(
      table.organizationId,
      table.schemeId,
      table.receivedOn,
    ),
    foreignKey({
      name: 'brand_benefit_receipts_scheme_fk',
      columns: [table.organizationId, table.schemeId],
      foreignColumns: [brandSchemes.organizationId, brandSchemes.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_benefit_receipts_claim_fk',
      columns: [table.organizationId, table.claimId, table.schemeId],
      foreignColumns: [brandClaims.organizationId, brandClaims.id, brandClaims.schemeId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_benefit_receipts_variant_fk',
      columns: [table.organizationId, table.variantId],
      foreignColumns: [productVariants.organizationId, productVariants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_benefit_receipts_goods_receipt_fk',
      columns: [table.organizationId, table.goodsReceiptId],
      foreignColumns: [goodsReceipts.organizationId, goodsReceipts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_benefit_receipts_recorded_by_fk',
      columns: [table.organizationId, table.recordedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'brand_benefit_receipts_kind',
      sql`(${table.kind} = 'money') = (${table.amountPaise} is not null)
        and (${table.kind} = 'money') = (${table.moneyForm} is not null)
        and (${table.kind} = 'free_goods') = (${table.variantId} is not null)
        and (${table.kind} = 'free_goods') = (${table.units} is not null)
        and (${table.goodsReceiptId} is null or ${table.kind} = 'free_goods')
        and (${table.kind} = 'points') = (${table.label} is not null)
        and (${table.kind} = 'points') = (${table.points} is not null)`,
    ),
    check(
      'brand_benefit_receipts_amounts',
      sql`${table.amountPaise} <> 0 and abs(${table.amountPaise}) <= 100000000000
        and ${table.units} <> 0 and abs(${table.units}) <= 1000000
        and ${table.points} <> 0 and abs(${table.points}) <= 100000000`,
    ),
    check(
      'brand_benefit_receipts_text',
      sql`${table.label} = btrim(${table.label}) and char_length(${table.label}) between 1 and 60
        and char_length(${table.reference}) between 1 and 60 and char_length(${table.note}) <= 500`,
    ),
    pgPolicy('brand_benefit_receipts_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

// Brand statement reconciliation (MVP 3 round 6a, P2-M34; spec §3.9) ---------------------

/** How a statement shows amounts: separate debit and credit columns, or one signed column. */
export const brandStatementAmountMode = pgEnum('brand_statement_amount_mode', [
  'debit_credit',
  'signed',
]);

/** In a signed column, which sign is a debit (the brand billing us). */
export const brandStatementSignConvention = pgEnum('brand_statement_sign_convention', [
  'debit_positive',
  'credit_positive',
]);

/** How the statement writes its dates. */
export const brandStatementDateFormat = pgEnum('brand_statement_date_format', [
  'dd-mm-yyyy',
  'mm-dd-yyyy',
  'yyyy-mm-dd',
  'dd-mon-yyyy',
]);

/** What a GRN is compared at: with GST (as the brand bills it) or its taxable value. */
export const brandStatementGrnBasis = pgEnum('brand_statement_grn_basis', ['with_gst', 'taxable']);

/**
 * How a brand's (or distributor's) statement is laid out (P2-M34): which column holds
 * what, the date format and sign convention, and how close a match must be. Made once
 * in the screens and reused for every month's statement.
 */
export const brandStatementTemplates = pgTable(
  'brand_statement_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    /** Whose statement it is: the supplier we buy from, whose GRNs it is matched with. */
    supplierPartyId: uuid('supplier_party_id').notNull(),
    /** The brand whose scheme credit notes it carries; null for none. */
    brandId: uuid('brand_id'),
    /** Rows above the header row (a title, the address); 0 when the header is the first row. */
    headerRowsToSkip: integer('header_rows_to_skip').notNull().default(0),
    /** Columns are named by their header text, matched without regard to case or spaces. */
    dateColumn: text('date_column').notNull(),
    documentColumn: text('document_column').notNull(),
    typeColumn: text('type_column'),
    referenceColumn: text('reference_column'),
    descriptionColumn: text('description_column'),
    amountMode: brandStatementAmountMode('amount_mode').notNull(),
    debitColumn: text('debit_column'),
    creditColumn: text('credit_column'),
    amountColumn: text('amount_column'),
    signConvention: brandStatementSignConvention('sign_convention')
      .notNull()
      .default('debit_positive'),
    dateFormat: brandStatementDateFormat('date_format').notNull().default('dd-mm-yyyy'),
    /** Words in the type column for each kind of line, e.g. {"credit_note": ["CN"]}. */
    typeRules: jsonb('type_rules')
      .$type<Partial<Record<string, string[]>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** How many days apart a line and a GRN may be dated and still match. */
    dateWindowDays: integer('date_window_days').notNull().default(7),
    /** How far apart the amounts may be and still count as matched. */
    amountTolerancePaise: bigint('amount_tolerance_paise', { mode: 'number' })
      .notNull()
      .default(100),
    grnAmountBasis: brandStatementGrnBasis('grn_amount_basis').notNull().default('with_gst'),
    isActive: boolean('is_active').notNull().default(true),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('brand_statement_templates_organization_id_id_unique').on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex('brand_statement_templates_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    foreignKey({
      name: 'brand_statement_templates_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'brand_statement_templates_supplier_fk',
      columns: [table.organizationId, table.supplierPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statement_templates_brand_fk',
      columns: [table.organizationId, table.brandId],
      foreignColumns: [brands.organizationId, brands.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statement_templates_created_by_fk',
      columns: [table.organizationId, table.createdByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'brand_statement_templates_text',
      sql`${table.name} = btrim(${table.name}) and char_length(${table.name}) between 1 and 80
        and char_length(${table.dateColumn}) between 1 and 60
        and char_length(${table.documentColumn}) between 1 and 60
        and (${table.typeColumn} is null or char_length(${table.typeColumn}) between 1 and 60)
        and (${table.referenceColumn} is null or char_length(${table.referenceColumn}) between 1 and 60)
        and (${table.descriptionColumn} is null or char_length(${table.descriptionColumn}) between 1 and 60)
        and (${table.debitColumn} is null or char_length(${table.debitColumn}) between 1 and 60)
        and (${table.creditColumn} is null or char_length(${table.creditColumn}) between 1 and 60)
        and (${table.amountColumn} is null or char_length(${table.amountColumn}) between 1 and 60)`,
    ),
    check(
      'brand_statement_templates_amount_columns',
      sql`(${table.amountMode} = 'debit_credit') = (${table.debitColumn} is not null)
        and (${table.amountMode} = 'debit_credit') = (${table.creditColumn} is not null)
        and (${table.amountMode} = 'signed') = (${table.amountColumn} is not null)`,
    ),
    check(
      'brand_statement_templates_ranges',
      sql`${table.headerRowsToSkip} between 0 and 50
        and ${table.dateWindowDays} between 0 and 60
        and ${table.amountTolerancePaise} between 0 and 100000
        and jsonb_typeof(${table.typeRules}) = 'object'`,
    ),
    pgPolicy('brand_statement_templates_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

export const brandStatementStatus = pgEnum('brand_statement_status', ['active', 'discarded']);

/**
 * A brand statement imported for a period (P2-M34). The original file is kept in
 * document storage after a clean virus scan (`storage_key`), else only its lines.
 * While active, one statement per supplier and period, and a file is imported once.
 */
export const brandStatements = pgTable(
  'brand_statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    /** Gap-free, e.g. BS-000003. */
    number: text('number').notNull(),
    templateId: uuid('template_id').notNull(),
    supplierPartyId: uuid('supplier_party_id').notNull(),
    brandId: uuid('brand_id'),
    periodFrom: date('period_from', { mode: 'string' }).notNull(),
    periodTo: date('period_to', { mode: 'string' }).notNull(),
    /** As printed on the statement: entered, or read from an opening line. */
    openingBalancePaise: bigint('opening_balance_paise', { mode: 'number' }),
    closingBalancePaise: bigint('closing_balance_paise', { mode: 'number' }),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    /** Where the scanned original is kept; null when it was not kept. */
    storageKey: text('storage_key'),
    status: brandStatementStatus('status').notNull().default('active'),
    /** When the lines were last matched. */
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    uploadedByMemberId: uuid('uploaded_by_member_id').notNull(),
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    discardedByMemberId: uuid('discarded_by_member_id'),
    ...timestamps,
  },
  (table) => [
    unique('brand_statements_organization_id_id_unique').on(table.organizationId, table.id),
    unique('brand_statements_number_unique').on(table.organizationId, table.number),
    unique('brand_statements_storage_key_unique').on(table.storageKey),
    uniqueIndex('brand_statements_file_unique')
      .on(table.organizationId, table.supplierPartyId, table.sha256)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('brand_statements_period_unique')
      .on(table.organizationId, table.supplierPartyId, table.periodFrom, table.periodTo)
      .where(sql`${table.status} = 'active'`),
    index('brand_statements_supplier_idx').on(
      table.organizationId,
      table.supplierPartyId,
      table.periodFrom,
    ),
    foreignKey({
      name: 'brand_statements_organization_fk',
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'brand_statements_template_fk',
      columns: [table.organizationId, table.templateId],
      foreignColumns: [brandStatementTemplates.organizationId, brandStatementTemplates.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statements_supplier_fk',
      columns: [table.organizationId, table.supplierPartyId],
      foreignColumns: [parties.organizationId, parties.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statements_brand_fk',
      columns: [table.organizationId, table.brandId],
      foreignColumns: [brands.organizationId, brands.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statements_uploaded_by_fk',
      columns: [table.organizationId, table.uploadedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statements_discarded_by_fk',
      columns: [table.organizationId, table.discardedByMemberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check('brand_statements_number_format', sql`${table.number} ~ '^BS-[0-9]{6,}$'`),
    check(
      'brand_statements_period',
      sql`${table.periodTo} >= ${table.periodFrom} and ${table.periodTo} - ${table.periodFrom} < 366`,
    ),
    check(
      'brand_statements_file',
      sql`${table.sizeBytes} > 0 and ${table.sha256} ~ '^[0-9a-f]{64}$'
        and char_length(${table.fileName}) between 1 and 120`,
    ),
    check(
      'brand_statements_discarded',
      sql`(${table.status} = 'discarded') = (${table.discardedAt} is not null)
        and (${table.discardedAt} is null) = (${table.discardedByMemberId} is null)`,
    ),
    pgPolicy('brand_statements_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/** What a statement line is, from its type column (or its sign when it has none). */
export const brandStatementLineKind = pgEnum('brand_statement_line_kind', [
  'opening',
  'invoice',
  'credit_note',
  'debit_note',
  'payment',
  'other',
]);

/**
 * One line of an imported statement, as read with its template: never changed. The
 * amount is signed from the brand's books: positive is a debit (the brand billed us),
 * negative a credit (a credit note, our payment).
 */
export const brandStatementLines = pgTable(
  'brand_statement_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    statementId: uuid('statement_id').notNull(),
    /** The spreadsheet row it came from (1 = the file's first row). */
    rowNumber: integer('row_number').notNull(),
    lineDate: date('line_date', { mode: 'string' }).notNull(),
    kind: brandStatementLineKind('kind').notNull(),
    documentNumber: text('document_number'),
    typeText: text('type_text'),
    reference: text('reference'),
    description: text('description'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('brand_statement_lines_organization_id_id_unique').on(table.organizationId, table.id),
    unique('brand_statement_lines_statement_id_unique').on(
      table.organizationId,
      table.id,
      table.statementId,
    ),
    unique('brand_statement_lines_row_unique').on(table.statementId, table.rowNumber),
    foreignKey({
      name: 'brand_statement_lines_statement_fk',
      columns: [table.organizationId, table.statementId],
      foreignColumns: [brandStatements.organizationId, brandStatements.id],
    }).onDelete('cascade'),
    check(
      'brand_statement_lines_values',
      sql`${table.rowNumber} >= 1 and abs(${table.amountPaise}) <= 100000000000
        and (${table.amountPaise} <> 0 or ${table.kind} = 'opening')
        and (${table.documentNumber} is null or char_length(${table.documentNumber}) between 1 and 60)
        and (${table.typeText} is null or char_length(${table.typeText}) between 1 and 60)
        and (${table.reference} is null or char_length(${table.reference}) between 1 and 120)
        and (${table.description} is null or char_length(${table.description}) between 1 and 300)`,
    ),
    pgPolicy('brand_statement_lines_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();

/**
 * How a line was settled: matched by the matching run (`auto`) or by a member
 * (`manual`), to a GRN or a recorded scheme receipt; `explained` with a note; or a
 * pair a member unmatched (`rejected`), which the run never proposes again.
 */
export const brandStatementMatchSource = pgEnum('brand_statement_match_source', [
  'auto',
  'manual',
  'explained',
  'rejected',
]);

export const brandStatementMatches = pgTable(
  'brand_statement_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    statementId: uuid('statement_id').notNull(),
    lineId: uuid('line_id').notNull(),
    source: brandStatementMatchSource('source').notNull(),
    goodsReceiptId: uuid('goods_receipt_id'),
    benefitReceiptId: uuid('benefit_receipt_id'),
    /** Line amount − our amount, when matched. */
    differencePaise: bigint('difference_paise', { mode: 'number' }),
    note: text('note'),
    /** Who matched, explained or unmatched it; null for the matching run. */
    memberId: uuid('member_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One settlement per line; a GRN or a receipt settles one line, across statements.
    uniqueIndex('brand_statement_matches_line_unique')
      .on(table.lineId)
      .where(sql`${table.source} <> 'rejected'`),
    uniqueIndex('brand_statement_matches_grn_unique')
      .on(table.organizationId, table.goodsReceiptId)
      .where(sql`${table.source} <> 'rejected' and ${table.goodsReceiptId} is not null`),
    uniqueIndex('brand_statement_matches_receipt_unique')
      .on(table.organizationId, table.benefitReceiptId)
      .where(sql`${table.source} <> 'rejected' and ${table.benefitReceiptId} is not null`),
    index('brand_statement_matches_statement_idx').on(table.organizationId, table.statementId),
    foreignKey({
      name: 'brand_statement_matches_line_fk',
      columns: [table.organizationId, table.lineId, table.statementId],
      foreignColumns: [
        brandStatementLines.organizationId,
        brandStatementLines.id,
        brandStatementLines.statementId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'brand_statement_matches_goods_receipt_fk',
      columns: [table.organizationId, table.goodsReceiptId],
      foreignColumns: [goodsReceipts.organizationId, goodsReceipts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statement_matches_benefit_receipt_fk',
      columns: [table.organizationId, table.benefitReceiptId],
      foreignColumns: [brandBenefitReceipts.organizationId, brandBenefitReceipts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'brand_statement_matches_member_fk',
      columns: [table.organizationId, table.memberId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.id],
    }).onDelete('restrict'),
    check(
      'brand_statement_matches_target',
      sql`num_nonnulls(${table.goodsReceiptId}, ${table.benefitReceiptId})
          = case when ${table.source} = 'explained' then 0 else 1 end
        and (${table.differencePaise} is null) = (${table.source} in ('explained', 'rejected'))
        and (${table.source} <> 'explained' or ${table.note} is not null)
        and (${table.note} is null or char_length(${table.note}) between 1 and 500)
        and (${table.source} = 'auto') = (${table.memberId} is null)`,
    ),
    pgPolicy('brand_statement_matches_tenant_isolation', {
      for: 'all',
      to: tenantRole,
      using: sql`${table.organizationId} = ${currentOrganizationId}`,
      withCheck: sql`${table.organizationId} = ${currentOrganizationId}`,
    }),
  ],
).enableRLS();
