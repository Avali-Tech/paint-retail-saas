import { sql } from 'drizzle-orm';
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
    /** Set by the platform (roadmap P1-M23); limits come from @paint/shared PLANS. */
    plan: plan('plan').notNull().default('trial'),
    /** Per-business overrides of the plan's features, e.g. {"loyalty": true}. */
    featureFlags: jsonb('feature_flags').notNull().default({}),
    /** A suspended business cannot sign in. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendReason: text('suspend_reason'),
    ...timestamps,
  },
  (table) => [
    check(
      'organizations_suspend_reason',
      sql`(${table.suspendedAt} is null) = (${table.suspendReason} is null)`,
    ),
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
    /** The platform's support staff, here for an approved support grant; hidden from member lists. */
    isSupport: boolean('is_support').notNull().default(false),
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
    /** Store the party mainly deals with; null = business-wide (e.g. a supplier). */
    homeStoreId: uuid('home_store_id'),
    notes: text('notes'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isActive: boolean('is_active').notNull().default(true),
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
    /** GST rate in basis points: 1800 = 18%. */
    gstRateBps: integer('gst_rate_bps').notNull(),
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
    /** Maximum retail price printed on the pack, in paise. */
    mrpPaise: bigint('mrp_paise', { mode: 'number' }),
    /** Default selling price, in paise. Never above the MRP. */
    sellingPricePaise: bigint('selling_price_paise', { mode: 'number' }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('product_variants_organization_sku_unique').on(table.organizationId, table.sku),
    unique('product_variants_product_pack_unique').on(table.productId, table.packSize, table.unit),
    unique('product_variants_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'product_variants_product_fk',
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
    }).onDelete('cascade'),
    check('product_variants_sku_format', sql`${table.sku} ~ '^[A-Z0-9][A-Z0-9._/-]{1,39}$'`),
    check('product_variants_pack_size_positive', sql`${table.packSize} > 0`),
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
    index('documents_record_idx')
      .on(table.organizationId, table.recordType, table.recordId)
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
