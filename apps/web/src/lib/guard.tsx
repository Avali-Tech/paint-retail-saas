import type { Permission } from '@paint/shared';
import type { ReactNode } from 'react';
import { usePermissions } from '../auth/session.js';
import { RequirePermission } from '../shell/guards.js';

/** Permissions of which a member needs at least one. */
export type AnyOf = readonly [Permission, ...Permission[]];

/** A page for members holding any of `permissions`; others are told why they cannot see it. */
export function RequireAnyPermission({
  permissions,
  children,
}: {
  readonly permissions: AnyOf;
  readonly children: ReactNode;
}) {
  const can = usePermissions();
  return (
    <RequirePermission permission={permissions.find(can) ?? permissions[0]}>
      {children}
    </RequirePermission>
  );
}
