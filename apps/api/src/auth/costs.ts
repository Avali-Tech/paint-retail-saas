import type { MemberAccess } from '@paint/shared';

/**
 * A cost, or a value at cost, as a member may see it: null without costs:read,
 * as for stock that has no cost yet (screens show it as not known).
 */
export function costFor(access: MemberAccess, value: number | null): number | null {
  return access.permissions.has('costs:read') ? value : null;
}
