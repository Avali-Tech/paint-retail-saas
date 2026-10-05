import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  enterTenantScope,
  isUniqueViolation,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { isPermission, type MemberView, type Permission } from '@paint/shared';
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { hashPassword } from '../auth/credentials.js';
import { DATABASE } from '../database/database.module.js';
import { requireRoomFor } from '../platform/plan-limits.js';
import { SUPPORT_ROLE_KEY } from '../platform/support-role.js';
import { canSeeMember, grantProblem, manageProblem } from './access-rules.js';
import type { CreateMemberInput, UpdateMemberInput } from './members.schemas.js';

const {
  memberStores,
  organizationMembers,
  rolePermissions,
  roles,
  sessions,
  stores,
  userTotp,
  users,
} = schema;

export type { MemberView };

interface MemberRecord extends Omit<MemberView, 'twoFactorEnabled'> {
  readonly rolePermissions: Permission[];
}

interface ResolvedRole {
  readonly id: string;
  readonly key: string;
  readonly permissions: Permission[];
}

const toView = (
  { rolePermissions, ...member }: MemberRecord,
  enrolled: ReadonlySet<string>,
): MemberView => ({ ...member, twoFactorEnabled: enrolled.has(member.user.id) });

@Injectable()
export class MembersService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Members the manager can see, ordered by name. */
  async list(auth: AuthContext): Promise<MemberView[]> {
    const members = await withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.loadMembers(tx),
    );
    return this.toViews(members.filter((member) => this.visible(auth, member)));
  }

  async get(auth: AuthContext, memberId: string): Promise<MemberView> {
    const member = await withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.loadMember(tx, memberId),
    );
    if (!this.visible(auth, member)) throw new NotFoundException('Member not found');
    return this.toView(member);
  }

  /**
   * Adds a person to the business. If they already have an account (for
   * example at another business) they are linked, keeping their own name and
   * password. Creating the account and the membership commit together.
   */
  async create(auth: AuthContext, input: CreateMemberInput): Promise<MemberView> {
    const organizationId = auth.organization.id;
    try {
      const record = await this.connection.db.transaction(async (tx) => {
        // Platform scope: accounts are global, so look up or create the person first.
        const existing = await this.findExistingUser(tx, input);
        if (existing && input.password) {
          throw new ConflictException(
            'This person already has an account and keeps their own password. Leave the password empty.',
          );
        }
        const userId = existing?.id ?? (await this.createUser(tx, input));

        await enterTenantScope(tx, organizationId);
        await requireRoomFor(tx, organizationId, 'members');
        const role = await this.findRole(tx, input.roleId);
        await this.assertStoresExist(tx, input.storeIds);
        const problem = grantProblem(auth, {
          roleKey: role.key,
          rolePermissions: role.permissions,
          allStores: input.allStores,
          storeIds: input.storeIds,
        });
        if (problem) throw new ForbiddenException(problem);

        const memberId = randomUUID();
        await tx.insert(organizationMembers).values({
          id: memberId,
          organizationId,
          userId,
          roleId: role.id,
          allStores: input.allStores,
        });
        await this.replaceStores(tx, organizationId, memberId, input.storeIds);
        return this.loadMember(tx, memberId);
      });
      return await this.toView(record);
    } catch (error) {
      if (isUniqueViolation(error, ['organization_members_organization_user_unique'])) {
        throw new ConflictException('This person is already a member of your business');
      }
      throw error;
    }
  }

  /** Changes a member's role, stores or active status. Takes effect on their next request. */
  async update(auth: AuthContext, memberId: string, input: UpdateMemberInput): Promise<MemberView> {
    const organizationId = auth.organization.id;
    const record = await withTenant(this.connection.db, organizationId, async (tx) => {
      const target = await this.loadMember(tx, memberId);
      if (!this.visible(auth, target)) throw new NotFoundException('Member not found');

      const manageIssue = manageProblem(auth, {
        userId: target.user.id,
        roleKey: target.role.key,
        rolePermissions: target.rolePermissions,
        allStores: target.allStores,
        storeIds: target.storeIds,
      });
      if (manageIssue) throw new ForbiddenException(manageIssue);

      const role: ResolvedRole = input.roleId
        ? await this.findRole(tx, input.roleId)
        : { id: target.role.id, key: target.role.key, permissions: target.rolePermissions };
      const allStores = input.allStores ?? target.allStores;
      const storeIds = input.storeIds ?? target.storeIds;
      if (input.storeIds) await this.assertStoresExist(tx, input.storeIds);
      const grantIssue = grantProblem(auth, {
        roleKey: role.key,
        rolePermissions: role.permissions,
        allStores,
        storeIds,
      });
      if (grantIssue) throw new ForbiddenException(grantIssue);
      if (input.isActive === true && !target.isActive) {
        await requireRoomFor(tx, organizationId, 'members');
      }

      await tx
        .update(organizationMembers)
        .set({
          roleId: role.id,
          allStores,
          isActive: input.isActive ?? target.isActive,
          updatedAt: sql`now()`,
        })
        .where(eq(organizationMembers.id, memberId));
      if (input.storeIds) await this.replaceStores(tx, organizationId, memberId, input.storeIds);
      if (input.isActive === false) {
        // Sign them out everywhere in this business.
        await tx
          .update(sessions)
          .set({ revokedAt: sql`now()` })
          .where(and(eq(sessions.userId, target.user.id), isNull(sessions.revokedAt)));
      }
      return this.loadMember(tx, memberId);
    });
    return this.toView(record);
  }

  private async toView(member: MemberRecord): Promise<MemberView> {
    return toView(member, await this.enrolled([member.user.id]));
  }

  private async toViews(members: MemberRecord[]): Promise<MemberView[]> {
    const enrolled = await this.enrolled(members.map((member) => member.user.id));
    return members.map((member) => toView(member, enrolled));
  }

  /**
   * Which of these people have a confirmed authenticator app. Platform scope:
   * tenants cannot read authenticator secrets, so this runs outside withTenant
   * and reads only whether one exists, for people already known to be members.
   */
  private async enrolled(userIds: string[]): Promise<ReadonlySet<string>> {
    const rows = await this.connection.db
      .select({ userId: userTotp.userId })
      .from(userTotp)
      .where(and(inArray(userTotp.userId, userIds), isNotNull(userTotp.confirmedAt)));
    return new Set(rows.map((row) => row.userId));
  }

  private visible(auth: AuthContext, member: MemberRecord): boolean {
    return canSeeMember(auth, { userId: member.user.id, storeIds: member.storeIds });
  }

  private async loadMember(tx: Transaction, memberId: string): Promise<MemberRecord> {
    const [member] = await this.loadMembers(tx, memberId);
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  /** Members with role, permissions and stores. Businesses have tens of members, so this loads them whole. */
  private async loadMembers(tx: Transaction, memberId?: string): Promise<MemberRecord[]> {
    const rows = await tx
      .select({
        id: organizationMembers.id,
        userId: users.id,
        fullName: users.fullName,
        phone: users.phone,
        email: users.email,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        allStores: organizationMembers.allStores,
        isActive: organizationMembers.isActive,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      // Platform support staff are not part of the team.
      .where(
        and(
          eq(organizationMembers.isSupport, false),
          memberId ? eq(organizationMembers.id, memberId) : undefined,
        ),
      )
      .orderBy(users.fullName, organizationMembers.id);
    const storeRows = await tx.select().from(memberStores);
    const permissionRows = await tx.select().from(rolePermissions);
    return rows.map((row) => ({
      id: row.id,
      user: { id: row.userId, fullName: row.fullName, phone: row.phone, email: row.email },
      role: { id: row.roleId, key: row.roleKey, name: row.roleName },
      allStores: row.allStores,
      storeIds: storeRows
        .filter((store) => store.memberId === row.id)
        .map((store) => store.storeId)
        .sort(),
      isActive: row.isActive,
      rolePermissions: permissionRows
        .filter((permission) => permission.roleId === row.roleId)
        .map((permission) => permission.permission)
        .filter(isPermission),
    }));
  }

  private async findExistingUser(tx: Transaction, input: CreateMemberInput) {
    const matches = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          input.phone ? eq(users.phone, input.phone) : undefined,
          input.email ? eq(users.email, input.email) : undefined,
        ),
      );
    if (matches.length > 1) {
      throw new ConflictException('This mobile number and email belong to two different people');
    }
    return matches[0];
  }

  private async createUser(tx: Transaction, input: CreateMemberInput): Promise<string> {
    const id = randomUUID();
    await tx.insert(users).values({
      id,
      fullName: input.fullName,
      phone: input.phone ?? null,
      email: input.email ?? null,
      passwordHash: input.password ? await hashPassword(input.password) : null,
    });
    return id;
  }

  private async findRole(tx: Transaction, roleId: string): Promise<ResolvedRole> {
    const [role] = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      // Only the platform gives anyone the support role.
      .where(and(eq(roles.id, roleId), ne(roles.key, SUPPORT_ROLE_KEY)));
    if (!role) throw new BadRequestException('Unknown role');
    const permissionRows = await tx
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, role.id));
    return {
      ...role,
      permissions: permissionRows.map((row) => row.permission).filter(isPermission),
    };
  }

  private async assertStoresExist(tx: Transaction, storeIds: readonly string[]): Promise<void> {
    if (storeIds.length === 0) return;
    const found = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(inArray(stores.id, [...storeIds]));
    if (found.length !== storeIds.length) throw new BadRequestException('Unknown store');
  }

  private async replaceStores(
    tx: Transaction,
    organizationId: string,
    memberId: string,
    storeIds: readonly string[],
  ): Promise<void> {
    // Only the difference, so the audit log shows exactly which stores changed.
    await tx
      .delete(memberStores)
      .where(
        and(eq(memberStores.memberId, memberId), notInArray(memberStores.storeId, [...storeIds])),
      );
    if (storeIds.length > 0) {
      await tx
        .insert(memberStores)
        .values(storeIds.map((storeId) => ({ organizationId, memberId, storeId })))
        .onConflictDoNothing();
    }
  }
}
