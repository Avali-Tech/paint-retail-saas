import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isUniqueViolation,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { isPermission, type RoleView } from '@paint/shared';
import { and, count, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { SUPPORT_ROLE_KEY } from '../platform/support-role.js';
import { roleChangeProblem, rolePermissionsProblem } from './role-rules.js';
import type { CreateRoleInput, UpdateRoleInput } from './roles.schemas.js';

const { organizationMembers, rolePermissions, roles } = schema;

/**
 * The business's roles: the standard ones (fixed) and its own custom roles,
 * which owners and admins (roles:manage) create and change. Permission changes
 * reach the role's members on their next request. Audited by triggers.
 */
@Injectable()
export class RolesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Every role with its permissions and how many active members hold it, by name. */
  list(auth: AuthContext): Promise<RoleView[]> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.views(tx));
  }

  async create(auth: AuthContext, input: CreateRoleInput): Promise<RoleView> {
    const problem = rolePermissionsProblem(auth, input.permissions);
    if (problem) throw new ForbiddenException(problem);
    const organizationId = auth.organization.id;
    try {
      return await withTenant(this.connection.db, organizationId, async (tx) => {
        await this.assertNameFree(tx, input.name);
        const [role] = await tx
          .insert(roles)
          .values({
            organizationId,
            // Never one of the standard keys, which have no prefix.
            key: `custom_${randomBytes(4).toString('hex')}`,
            name: input.name,
          })
          .returning({ id: roles.id });
        const roleId = String(role?.id);
        await tx
          .insert(rolePermissions)
          .values(input.permissions.map((permission) => ({ organizationId, roleId, permission })));
        return this.view(tx, roleId);
      });
    } catch (error) {
      if (isUniqueViolation(error, ['roles_organization_key_unique'])) {
        throw new ConflictException('Could not save the role just now; please try again');
      }
      throw error;
    }
  }

  /** Renames a custom role or replaces its permissions (only what changed is written). */
  update(auth: AuthContext, roleId: string, input: UpdateRoleInput): Promise<RoleView> {
    const organizationId = auth.organization.id;
    return withTenant(this.connection.db, organizationId, async (tx) => {
      const current = await this.view(tx, roleId);
      const problem = roleChangeProblem(auth, current, input.permissions);
      if (problem) throw new ForbiddenException(problem);
      if (input.name !== undefined) {
        await this.assertNameFree(tx, input.name, roleId);
        await tx
          .update(roles)
          .set({ name: input.name, updatedAt: sql`now()` })
          .where(eq(roles.id, roleId));
      }
      if (input.permissions !== undefined) {
        await tx
          .delete(rolePermissions)
          .where(
            and(
              eq(rolePermissions.roleId, roleId),
              notInArray(rolePermissions.permission, input.permissions),
            ),
          );
        await tx
          .insert(rolePermissions)
          .values(input.permissions.map((permission) => ({ organizationId, roleId, permission })))
          .onConflictDoNothing();
      }
      return this.view(tx, roleId);
    });
  }

  /** 409 when another role already has this name, ignoring case. */
  private async assertNameFree(tx: Transaction, name: string, exceptId?: string): Promise<void> {
    const [taken] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          sql`lower(${roles.name}) = lower(${name})`,
          exceptId === undefined ? undefined : ne(roles.id, exceptId),
        ),
      );
    if (taken) throw new ConflictException('A role with this name already exists');
  }

  private async view(tx: Transaction, roleId: string): Promise<RoleView> {
    const [role] = await this.views(tx, roleId);
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private async views(tx: Transaction, roleId?: string): Promise<RoleView[]> {
    const roleRows = await tx
      .select({ id: roles.id, key: roles.key, name: roles.name, isSystem: roles.isSystem })
      .from(roles)
      // Only the platform uses the support role.
      .where(and(ne(roles.key, SUPPORT_ROLE_KEY), roleId ? eq(roles.id, roleId) : undefined))
      .orderBy(roles.name);
    const ids = roleRows.map((role) => role.id);
    const permissionRows = await tx
      .select()
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, ids));
    const holders = await tx
      .select({ roleId: organizationMembers.roleId, members: count() })
      .from(organizationMembers)
      .where(
        and(
          inArray(organizationMembers.roleId, ids),
          eq(organizationMembers.isActive, true),
          eq(organizationMembers.isSupport, false),
        ),
      )
      .groupBy(organizationMembers.roleId);
    return roleRows.map((role) => ({
      ...role,
      permissions: permissionRows
        .filter((row) => row.roleId === role.id)
        .map((row) => row.permission)
        .filter(isPermission)
        .sort(),
      memberCount: holders.find((row) => row.roleId === role.id)?.members ?? 0,
    }));
  }
}
