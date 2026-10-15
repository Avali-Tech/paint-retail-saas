import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import {
  PLANS,
  resolveFeatures,
  subscriptionState,
  type FeatureFlag,
  type PlanKey,
  type TenantSubscriptionView,
} from '@paint/shared';
import { and, count, desc, eq, ilike, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { setUpOrganization } from '../auth/organization-setup.js';
import { only } from '../common/only.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import {
  subscriptionRecord,
  SubscriptionsService,
} from '../subscriptions/subscriptions.service.js';
import {
  SUBSCRIPTION_SETTINGS,
  type SubscriptionSettings,
} from '../subscriptions/subscriptions.tokens.js';
import { PLATFORM_SETTINGS, type PlatformSettings } from './platform-auth.service.js';
import type { CreateTenantInput, ListTenantsQuery, UpdateTenantInput } from './platform.schemas.js';

const { organizationMembers, organizations, roles, sessions, subscriptions, users } = schema;

export interface PlanView {
  readonly key: PlanKey;
  readonly name: string;
  readonly maxStores: number | null;
  readonly maxMembers: number | null;
}

export interface TenantUsage {
  readonly stores: number;
  readonly members: number;
  readonly products: number;
  readonly parties: number;
  readonly documents: number;
  readonly documentBytes: number;
  readonly lastSignInAt: string | null;
}

export interface TenantView {
  readonly id: string;
  readonly name: string;
  readonly plan: PlanView;
  readonly status: 'active' | 'suspended';
  readonly suspendedAt: string | null;
  readonly suspendReason: string | null;
  /** The plan's features with this business's overrides applied. */
  readonly features: Record<FeatureFlag, boolean>;
  readonly featureOverrides: Partial<Record<FeatureFlag, boolean>>;
  readonly usage: TenantUsage;
  readonly subscription: TenantSubscriptionView;
  readonly createdAt: string;
}

export interface TenantDetail extends TenantView {
  readonly owners: {
    readonly fullName: string;
    readonly phone: string | null;
    readonly email: string | null;
  }[];
}

const planView = (key: PlanKey): PlanView => ({ key, ...PLANS[key] });

// Written with explicit aliases: Drizzle leaves single-table columns
// unqualified, which inside a subquery would point at the subquery's table.
const usageColumns = {
  stores: sql<number>`(select count(*)::int from stores s where s.organization_id = organizations.id and s.is_active)`,
  members: sql<number>`(select count(*)::int from organization_members m where m.organization_id = organizations.id and m.is_active and not m.is_support)`,
  products: sql<number>`(select count(*)::int from product_variants v where v.organization_id = organizations.id)`,
  parties: sql<number>`(select count(*)::int from parties p where p.organization_id = organizations.id)`,
  documents: sql<number>`(select count(*)::int from documents d where d.organization_id = organizations.id and d.deleted_at is null)`,
  documentBytes: sql<string>`(select coalesce(sum(d.size_bytes), 0) from documents d where d.organization_id = organizations.id and d.deleted_at is null)`,
  lastSignInAt: sql<Date | null>`(select max(u.last_login_at) from organization_members m join users u on u.id = m.user_id where m.organization_id = organizations.id and not m.is_support)`,
};

/** The platform's view of every business (roadmap P1-M23). Platform scope. */
@Injectable()
export class TenantsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PLATFORM_SETTINGS) private readonly settings: PlatformSettings,
    @Inject(SUBSCRIPTION_SETTINGS) private readonly subscriptionSettings: SubscriptionSettings,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
  ) {}

  async list(query: ListTenantsQuery): Promise<{ items: TenantView[]; total: number }> {
    const where = and(
      query.q ? ilike(organizations.name, containsPattern(query.q)) : undefined,
      query.status === 'suspended'
        ? isNotNull(organizations.suspendedAt)
        : query.status === 'active'
          ? isNull(organizations.suspendedAt)
          : undefined,
    );
    const rows = await this.rows()
      .where(where)
      .orderBy(desc(organizations.createdAt), desc(organizations.id))
      .limit(query.limit)
      .offset(query.offset);
    const [totals] = await this.connection.db
      .select({ total: count() })
      .from(organizations)
      .where(where);
    return { items: rows.map((row) => this.toView(row)), total: Number(totals?.total) };
  }

  async get(tenantId: string): Promise<TenantDetail> {
    const row = only(await this.rows().where(eq(organizations.id, tenantId)), 'Business');
    const owners = await this.connection.db
      .select({ fullName: users.fullName, phone: users.phone, email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.organizationId, tenantId),
          eq(roles.key, 'owner'),
          eq(organizationMembers.isActive, true),
        ),
      )
      .orderBy(users.fullName);
    return { ...this.toView(row), owners };
  }

  /**
   * Onboards a business: creates it with the standard roles and its owner,
   * who signs in with a one-time code sent to their mobile number. An existing
   * account with that number simply becomes the owner of the new business too.
   */
  async create(input: CreateTenantInput): Promise<TenantDetail> {
    const organizationId = randomUUID();
    await this.connection.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.phone, input.owner.phone));
      const ownerUserId = existing ? existing.id : await this.newOwner(tx, input.owner);
      await setUpOrganization(tx, {
        organizationId,
        name: input.organizationName,
        ownerUserId,
        plan: input.plan,
        trialDays: this.settings.trialDays,
      });
    });
    return this.get(organizationId);
  }

  /** A new account for the owner; refused if their email belongs to someone else. */
  private async newOwner(
    tx: Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0],
    owner: CreateTenantInput['owner'],
  ): Promise<string> {
    const [created] = await tx
      .insert(users)
      .values({ fullName: owner.fullName, phone: owner.phone, email: owner.email ?? null })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!created) throw new ConflictException('That email address belongs to another account');
    return created.id;
  }

  async update(
    tenantId: string,
    input: UpdateTenantInput,
    operatorUserId: string,
  ): Promise<TenantDetail> {
    const current = await this.get(tenantId);
    // null drops an override, so the plan's default applies again.
    const overrides = Object.fromEntries(
      Object.entries({ ...current.featureOverrides, ...input.featureFlags }).filter(
        ([, value]) => value !== null,
      ),
    );
    await this.connection.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.plan ? { plan: input.plan } : {}),
          featureFlags: overrides,
          updatedAt: sql`now()`,
        })
        .where(eq(organizations.id, tenantId));
      if (input.plan && input.plan !== current.plan.key) {
        await this.subscriptions.recordOperatorChange(tx, {
          organizationId: tenantId,
          from: current.plan.key,
          to: input.plan,
          operatorUserId,
        });
      }
    });
    return this.get(tenantId);
  }

  /** More days of free trial, also after it ended (support for a business deciding). */
  async extendTrial(tenantId: string, days: number): Promise<TenantDetail> {
    await this.get(tenantId);
    await this.subscriptions.extendTrial(tenantId, days);
    return this.get(tenantId);
  }

  /** Stops a business from signing in, and signs everyone out now. */
  async suspend(tenantId: string, reason: string): Promise<TenantDetail> {
    const current = await this.get(tenantId);
    if (current.status === 'suspended')
      throw new ConflictException('This business is already suspended');
    await this.connection.db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({ suspendedAt: sql`now()`, suspendReason: reason, updatedAt: sql`now()` })
        .where(eq(organizations.id, tenantId));
      await tx
        .update(sessions)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(sessions.organizationId, tenantId),
            isNull(sessions.revokedAt),
            // Platform support may still need to look in.
            isNull(sessions.supportGrantId),
          ),
        );
    });
    return this.get(tenantId);
  }

  async reactivate(tenantId: string): Promise<TenantDetail> {
    const current = await this.get(tenantId);
    if (current.status === 'active') throw new ConflictException('This business is not suspended');
    await this.connection.db
      .update(organizations)
      .set({ suspendedAt: null, suspendReason: null, updatedAt: sql`now()` })
      .where(eq(organizations.id, tenantId));
    return this.get(tenantId);
  }

  /** For a signed-in member: their business's plan, limits, usage and features. */
  features(auth: AuthContext) {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const business = only(
        await tx
          .select({
            plan: organizations.plan,
            featureFlags: organizations.featureFlags,
            ...usageColumns,
          })
          .from(organizations)
          .where(eq(organizations.id, auth.organization.id)),
        'Business',
      );
      return {
        plan: planView(business.plan),
        usage: { stores: business.stores, members: business.members },
        features: resolveFeatures(
          business.plan,
          business.featureFlags as Partial<Record<FeatureFlag, boolean>>,
        ),
      };
    });
  }

  private rows() {
    return this.connection.db
      .select({
        organization: organizations,
        ...usageColumns,
        subscription: subscriptions,
        now: sql<number>`(extract(epoch from now()) * 1000)::float8`.mapWith(Number),
      })
      .from(organizations)
      .innerJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
      .$dynamic();
  }

  private toView(row: Awaited<ReturnType<TenantsService['rows']>>[number]): TenantView {
    const { organization, subscription } = row;
    const state = subscriptionState(
      subscriptionRecord(subscription),
      new Date(row.now),
      this.subscriptionSettings.graceDays,
    );
    const overrides = organization.featureFlags as Partial<Record<FeatureFlag, boolean>>;
    return {
      id: organization.id,
      name: organization.name,
      plan: planView(organization.plan),
      status: organization.suspendedAt ? 'suspended' : 'active',
      suspendedAt: organization.suspendedAt ? organization.suspendedAt.toISOString() : null,
      suspendReason: organization.suspendReason,
      features: resolveFeatures(organization.plan, overrides),
      featureOverrides: overrides,
      usage: {
        stores: row.stores,
        members: row.members,
        products: row.products,
        parties: row.parties,
        documents: row.documents,
        documentBytes: Number(row.documentBytes),
        lastSignInAt: row.lastSignInAt ? new Date(row.lastSignInAt).toISOString() : null,
      },
      subscription: {
        status: state.status,
        readOnly: state.readOnly,
        trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        interval: subscription.billingInterval,
        gateway: subscription.gateway,
      },
      createdAt: organization.createdAt.toISOString(),
    };
  }
}
