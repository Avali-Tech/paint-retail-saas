import type { Permission } from '@paint/shared';
import type { ComponentType, LazyExoticComponent } from 'react';
import { RequirePermission } from '../shell/guards.js';

/** A (lazily loaded) screen behind a permission. */
export const guarded = (permission: Permission, Page: LazyExoticComponent<ComponentType>) => (
  <RequirePermission permission={permission}>
    <Page />
  </RequirePermission>
);
