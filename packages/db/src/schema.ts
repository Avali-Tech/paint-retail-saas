import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
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
