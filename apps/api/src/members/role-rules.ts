import type { Permission } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';

/** Why `manager` may not put `permissions` in a role, or null if they may. */
export function rolePermissionsProblem(
  manager: AuthContext,
  permissions: readonly Permission[],
): string | null {
  return permissions.every((permission) => manager.permissions.has(permission))
    ? null
    : 'You cannot give permissions you do not have';
}

/**
 * Why `manager` may not change `role` (to `permissions`, when given), or null
 * if they may. System roles are fixed; nobody changes the role they hold
 * themselves, or a role that grants more than they have.
 */
export function roleChangeProblem(
  manager: AuthContext,
  role: {
    readonly key: string;
    readonly isSystem: boolean;
    readonly permissions: readonly Permission[];
  },
  permissions: readonly Permission[] | undefined,
): string | null {
  if (role.isSystem) return 'System roles cannot be changed';
  if (role.key === manager.role.key) return 'You cannot change your own role';
  if (rolePermissionsProblem(manager, role.permissions) !== null) {
    return 'This role has permissions you are not allowed to manage';
  }
  return permissions === undefined ? null : rolePermissionsProblem(manager, permissions);
}
