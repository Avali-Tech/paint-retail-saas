import 'reflect-metadata';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { generateSessionToken, hashSessionToken } from '../auth/credentials.js';
import { only } from '../common/only.js';
import { DATABASE } from '../database/database.module.js';
import { Notifier } from '../notifications/notifier.js';
import { grantStatus, type GrantStatus } from './grant-status.js';
import type { Operator } from './platform-auth.service.js';
import { SUPPORT_PERMISSIONS, SUPPORT_ROLE_KEY, SUPPORT_ROLE_NAME } from './support-role.js';

const {
  organizationMembers,
  organizations,
  rolePermissions,
  roles,
  sessions,
  supportAccessLog,
  supportGrants,
} = schema;

type GrantRow = typeof supportGrants.$inferSelect;

export interface GrantView {
  readonly id: string;
  readonly organization: { readonly id: string; readonly name: string };
  readonly requestedBy: string;
  readonly reason: string;
  readonly minutes: number;
  readonly status: GrantStatus;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly declinedAt: string | null;
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
}

export interface AccessLogEntry {
  readonly at: string;
  readonly method: string;
  readonly path: string;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/**
 * Support access (roadmap P1-M23): the platform asks, the business decides,
 * access is time-limited and read-only, and every request is logged.
 */
@Injectable()
export class SupportService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  // Platform side -----------------------------------------------------------

  /** Asks a business for access, and tells its owners and admins. */
  async request(
    operator: Operator,
    tenantId: string,
    input: { reason: string; minutes: number },
  ): Promise<GrantView> {
    const business = only(
      await this.connection.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, tenantId)),
      'Business',
    );
    const [grant] = await this.connection.db
      .insert(supportGrants)
      .values({
        organizationId: business.id,
        platformUserId: operator.userId,
        requestedByName: operator.fullName,
        ...input,
      })
      .returning({ id: supportGrants.id });
    const grantId = String(grant?.id);
    await withTenant(this.connection.db, business.id, async (tx) => {
      const deciders = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .innerJoin(
          rolePermissions,
          and(
            eq(rolePermissions.roleId, organizationMembers.roleId),
            eq(rolePermissions.permission, 'organization:manage'),
          ),
        )
        .where(
          and(eq(organizationMembers.isActive, true), eq(organizationMembers.isSupport, false)),
        );
      await this.notifier.notify(tx, {
        organizationId: business.id,
        event: 'support_access_requested',
        to: { memberIds: deciders.map((member) => member.id) },
        title: 'Platform support asks to access your business',
        body: `${operator.fullName} asks for ${String(input.minutes)} minutes of read-only access: ${input.reason}. Approve or decline it under Settings → Support access.`,
        link: `/settings/support/${grantId}`,
      });
    });
    return this.view(grantId);
  }

  async listForPlatform(tenantId?: string): Promise<GrantView[]> {
    const rows = await this.rows()
      .where(tenantId ? eq(supportGrants.organizationId, tenantId) : undefined)
      .orderBy(desc(supportGrants.requestedAt));
    return rows.map((row) => this.toView(row));
  }

  /** A session inside the business, for the operator who asked, while the grant runs. */
  async startSession(
    operator: Operator,
    grantId: string,
  ): Promise<{ token: string; expiresAt: string; organizationId: string }> {
    const grant = await this.grant(grantId);
    if (grant.platformUserId !== operator.userId) {
      throw new ForbiddenException('Only the operator who asked can use this access');
    }
    const status = grantStatus(grant);
    if (status !== 'active') throw new ConflictException(`This support access is ${status}`);
    const organizationId = grant.organizationId;
    return this.connection.db.transaction(async (tx) => {
      const roleId = await this.supportRole(tx, organizationId);
      const [membership] = await tx
        .select({ id: organizationMembers.id, isSupport: organizationMembers.isSupport })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, operator.userId),
          ),
        );
      if (membership && !membership.isSupport) {
        throw new ConflictException('You work at this business; sign in to it normally');
      }
      if (membership) {
        await tx
          .update(organizationMembers)
          .set({ isActive: true, roleId, allStores: true })
          .where(eq(organizationMembers.id, membership.id));
      } else {
        await tx.insert(organizationMembers).values({
          organizationId,
          userId: operator.userId,
          roleId,
          allStores: true,
          isSupport: true,
        });
      }
      const token = generateSessionToken();
      // Ends with the grant, which is running, so it has an expiry.
      const expiresAt = new Date(Number(grant.expiresAt));
      await tx.insert(sessions).values({
        tokenHash: hashSessionToken(token),
        userId: operator.userId,
        organizationId,
        expiresAt,
        supportGrantId: grant.id,
      });
      return { token, expiresAt: expiresAt.toISOString(), organizationId };
    });
  }

  /** The platform ends access early. */
  async endForPlatform(grantId: string): Promise<GrantView> {
    const grant = await this.grant(grantId);
    await this.end(grant);
    return this.view(grantId);
  }

  // Business side -----------------------------------------------------------

  listForBusiness(auth: AuthContext): Promise<GrantView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows = await this.rows(tx).orderBy(desc(supportGrants.requestedAt));
      return rows.map((row) => this.toView(row));
    });
  }

  approve(auth: AuthContext, grantId: string): Promise<GrantView> {
    return this.decide(auth, grantId, (grant) => ({
      approvedAt: sql`now()`,
      expiresAt: sql`now() + make_interval(mins => ${grant.minutes})`,
    }));
  }

  decline(auth: AuthContext, grantId: string): Promise<GrantView> {
    return this.decide(auth, grantId, () => ({ declinedAt: sql`now()` }));
  }

  /** The business ends access early. */
  async endForBusiness(auth: AuthContext, grantId: string): Promise<GrantView> {
    const grant = await withTenant(this.connection.db, auth.organization.id, async (tx) =>
      only(
        await tx.select().from(supportGrants).where(eq(supportGrants.id, grantId)),
        'Support request',
      ),
    );
    await this.end(grant, auth.memberId);
    return this.view(grantId);
  }

  /** Every request made with this access, oldest first. */
  activity(auth: AuthContext, grantId: string): Promise<AccessLogEntry[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      only(
        await tx
          .select({ id: supportGrants.id })
          .from(supportGrants)
          .where(eq(supportGrants.id, grantId)),
        'Support request',
      );
      const rows = await tx
        .select()
        .from(supportAccessLog)
        .where(eq(supportAccessLog.grantId, grantId))
        .orderBy(supportAccessLog.id);
      return rows.map((row) => ({
        at: row.occurredAt.toISOString(),
        method: row.method,
        path: row.path,
      }));
    });
  }

  // Helpers -----------------------------------------------------------------

  private decide(
    auth: AuthContext,
    grantId: string,
    changes: (grant: GrantRow) => PgUpdateSetSource<typeof supportGrants>,
  ): Promise<GrantView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const grant = only(
        await tx.select().from(supportGrants).where(eq(supportGrants.id, grantId)).for('update'),
        'Support request',
      );
      const status = grantStatus(grant);
      if (status !== 'pending') throw new ConflictException(`This support request is ${status}`);
      await tx
        .update(supportGrants)
        .set({ ...changes(grant), decidedByMemberId: auth.memberId })
        .where(eq(supportGrants.id, grantId));
      return this.toView(
        only(await this.rows(tx).where(eq(supportGrants.id, grantId)), 'Support request'),
      );
    });
  }

  /** Ends a running grant and signs its sessions out; by a member, or by the platform. */
  private async end(grant: GrantRow, memberId?: string): Promise<void> {
    const status = grantStatus(grant);
    if (status !== 'active') throw new ConflictException(`This support access is ${status}`);
    const work = async (tx: Transaction) => {
      await tx
        .update(supportGrants)
        .set({ endedAt: sql`now()` })
        .where(eq(supportGrants.id, grant.id));
      await tx
        .update(sessions)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(sessions.supportGrantId, grant.id), isNull(sessions.revokedAt)));
    };
    // A member's ending is recorded as theirs in the audit log; the platform's as system.
    await (memberId
      ? withTenant(this.connection.db, grant.organizationId, work)
      : this.connection.db.transaction(work));
  }

  /** The business's support role, created the first time support is let in. */
  private async supportRole(tx: Transaction, organizationId: string): Promise<string> {
    const [existing] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), eq(roles.key, SUPPORT_ROLE_KEY)));
    if (existing) return existing.id;
    const [created] = await tx
      .insert(roles)
      .values({ organizationId, key: SUPPORT_ROLE_KEY, name: SUPPORT_ROLE_NAME, isSystem: true })
      .returning({ id: roles.id });
    const roleId = String(created?.id);
    await tx
      .insert(rolePermissions)
      .values(SUPPORT_PERMISSIONS.map((permission) => ({ organizationId, roleId, permission })));
    return roleId;
  }

  private async grant(grantId: string): Promise<GrantRow> {
    return only(
      await this.connection.db.select().from(supportGrants).where(eq(supportGrants.id, grantId)),
      'Support request',
    );
  }

  private rows(tx: Transaction | DatabaseConnection['db'] = this.connection.db) {
    return tx
      .select({ grant: supportGrants, organizationName: organizations.name })
      .from(supportGrants)
      .innerJoin(organizations, eq(organizations.id, supportGrants.organizationId))
      .$dynamic();
  }

  private async view(grantId: string): Promise<GrantView> {
    return this.toView(
      only(await this.rows().where(eq(supportGrants.id, grantId)), 'Support request'),
    );
  }

  private toView(row: { grant: GrantRow; organizationName: string }): GrantView {
    const { grant } = row;
    return {
      id: grant.id,
      organization: { id: grant.organizationId, name: row.organizationName },
      requestedBy: grant.requestedByName,
      reason: grant.reason,
      minutes: grant.minutes,
      status: grantStatus(grant),
      requestedAt: grant.requestedAt.toISOString(),
      approvedAt: iso(grant.approvedAt),
      declinedAt: iso(grant.declinedAt),
      expiresAt: iso(grant.expiresAt),
      endedAt: iso(grant.endedAt),
    };
  }
}
