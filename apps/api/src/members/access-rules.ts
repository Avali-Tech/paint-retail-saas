import { canAccessStore, type Permission } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';

/** The access a member has, or would have after a change. */
export interface AccessGrant {
  readonly roleKey: string;
  readonly rolePermissions: readonly Permission[];
  readonly allStores: boolean;
  readonly storeIds: readonly string[];
}

/**
 * Why `manager` may not give `grant` to someone, or null if they may.
 * Nobody can hand out more than they hold themselves.
 */
export function grantProblem(manager: AuthContext, grant: AccessGrant): string | null {
  if (grant.roleKey === 'owner' && manager.role.key !== 'owner') {
    return 'Only an owner can make someone an owner';
  }
  if (!grant.rolePermissions.every((permission) => manager.permissions.has(permission))) {
    return 'You cannot give permissions you do not have';
  }
  if (grant.allStores && !manager.allStores) {
    return 'You cannot give access to all stores';
  }
  if (!grant.storeIds.every((storeId) => canAccessStore(manager, storeId))) {
    return 'You cannot give access to stores you cannot access';
  }
  return null;
}

/**
 * Why `manager` may not change `target`'s access, or null if they may.
 * Blocking changes to your own access also guarantees a business always keeps
 * an active owner: only owners can change owners, and never themselves.
 */
export function manageProblem(
  manager: AuthContext,
  target: AccessGrant & { readonly userId: string },
): string | null {
  if (target.userId === manager.user.id) return 'You cannot change your own access';
  return grantProblem(manager, target) === null
    ? null
    : 'This member has access you are not allowed to manage';
}

/** True when `manager` can see `member`: managers see people who work in their stores. */
export function canSeeMember(
  manager: AuthContext,
  member: { readonly userId: string; readonly storeIds: readonly string[] },
): boolean {
  return (
    manager.allStores ||
    member.userId === manager.user.id ||
    member.storeIds.some((storeId) => manager.storeIds.has(storeId))
  );
}
