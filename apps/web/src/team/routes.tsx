import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Team members, roles and permissions. Each screen is its own chunk, loaded when first opened.
const TeamPage = lazy(() =>
  import('./TeamPage.js').then((module) => ({ default: module.TeamPage })),
);
const NewMemberPage = lazy(() =>
  import('./NewMemberPage.js').then((module) => ({ default: module.NewMemberPage })),
);
const MemberPage = lazy(() =>
  import('./MemberPage.js').then((module) => ({ default: module.MemberPage })),
);
const RolesPage = lazy(() =>
  import('../roles/RolesPage.js').then((module) => ({ default: module.RolesPage })),
);
const NewRolePage = lazy(() =>
  import('../roles/RolePage.js').then((module) => ({ default: module.NewRolePage })),
);
const RolePage = lazy(() =>
  import('../roles/RolePage.js').then((module) => ({ default: module.RolePage })),
);

/** The team and roles screens, inside the signed-in shell. */
export function teamRoutes() {
  return (
    <>
      <Route path="team" element={guarded('members:read', TeamPage)} />
      <Route path="team/new" element={guarded('members:manage', NewMemberPage)} />
      <Route path="team/roles" element={guarded('members:read', RolesPage)} />
      <Route path="team/roles/new" element={guarded('roles:manage', NewRolePage)} />
      <Route path="team/roles/:id" element={guarded('members:read', RolePage)} />
      <Route path="team/:id" element={guarded('members:read', MemberPage)} />
    </>
  );
}
