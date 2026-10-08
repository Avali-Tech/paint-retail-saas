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
export const plan = pgEnum('plan', ['trial', 'standard', 'enterprise']);

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
      sql`case
        when ${table.movementType} in ('opening', 'purchase_receipt', 'transfer_in', 'sale_return') then ${table.quantity} > 0
        when ${table.movementType} in ('purchase_return', 'transfer_out', 'sale', 'damage') then ${table.quantity} < 0
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
    heldByMemberId: uuid('held_by_member_id'),
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
      sql`(${table.holdReason} is null) = (${table.heldAt} is null) and (${table.heldAt} is null) = (${table.heldByMemberId} is null)`,
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'loyalty_settings_earn_positive',
      sql`${table.earnPoints} > 0 and ${table.earnPerPaise} > 0`,
    ),
    check('loyalty_settings_expiry_positive', sql`${table.expiryDays} > 0`),
    check('loyalty_settings_min_redemption', sql`${table.minRedemptionPoints} >= 0`),
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
 * manual or campaign award, a redemption, an adjustment with a reason, or
 * expiry of unused points.
 */
export const loyaltyEntryKind = pgEnum('loyalty_entry_kind', [
  'purchase',
  'award',
  'campaign',
  'redeem',
  'adjust',
  'expire',
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
    check(
      'loyalty_ledger_purchase',
      sql`(${table.kind} <> 'purchase' or num_nonnulls(${table.manualPurchasePaise}, ${table.taxDocumentId}) = 1)
        and (${table.manualPurchasePaise} is null or (${table.kind} = 'purchase' and ${table.manualPurchasePaise} > 0))
        and (${table.taxDocumentId} is null or ${table.kind} in ('purchase', 'adjust'))`,
    ),
    // One purchase entry per invoice: issuing never earns twice.
    uniqueIndex('loyalty_ledger_invoice_purchase_unique')
      .on(table.taxDocumentId)
      .where(sql`${table.kind} = 'purchase' and ${table.taxDocumentId} is not null`),
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
      sql`${table.kind} not in ('purchase', 'campaign') or ${table.reference} is not null`,
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
    /** Cash is taken only into an open register session ([PO-11]: yes for cash). */
    cashNeedsRegister: boolean('cash_needs_register').notNull().default(true),
    /** A register closing further off than this tells the branch managers (spec §5.5). */
    registerVarianceAlertPaise: bigint('register_variance_alert_paise', { mode: 'number' })
      .notNull()
      .default(0),
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
  (table) => [
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
    /** A payment gateway's id, for matching (2.1). */
    gatewayReference: text('gateway_reference'),
    note: text('note'),
    /**
     * The GST receipt voucher (an advance, Rule 50) or refund voucher (Rule
     * 51) number, from the store's series, and the registration that issued it.
     */
    voucherNumber: text('voucher_number'),
    voucherFy: text('voucher_fy'),
    voucherSeriesId: uuid('voucher_series_id'),
    supplierGstin: text('supplier_gstin'),
    createdByMemberId: uuid('created_by_member_id').notNull(),
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
]);
export const taxNature = pgEnum('tax_nature', ['taxable', 'nil_rated', 'exempt', 'non_gst']);

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
