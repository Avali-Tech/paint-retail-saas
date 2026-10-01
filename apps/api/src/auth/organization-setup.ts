import { randomUUID } from 'node:crypto';
import { schema, type Transaction } from '@paint/db';
import { SYSTEM_ROLES, type PlanKey } from '@paint/shared';

const { organizationMembers, organizations, rolePermissions, roles } = schema;

/**
 * Creates a business with the standard roles and makes `ownerUserId` its
 * owner. Used by self sign-up and by the platform console; platform scope.
 */
export async function setUpOrganization(
  tx: Transaction,
  setup: { organizationId: string; name: string; ownerUserId: string; plan?: PlanKey },
): Promise<void> {
  const { organizationId } = setup;
  const systemRoles = SYSTEM_ROLES.map((role) => ({ ...role, id: randomUUID() }));
  await tx.insert(organizations).values({ id: organizationId, name: setup.name, plan: setup.plan });
  await tx.insert(roles).values(
    systemRoles.map((role) => ({
      id: role.id,
      organizationId,
      key: role.key,
      name: role.name,
      isSystem: true,
    })),
  );
  await tx
    .insert(rolePermissions)
    .values(
      systemRoles.flatMap((role) =>
        role.permissions.map((permission) => ({ organizationId, roleId: role.id, permission })),
      ),
    );
  await tx.insert(organizationMembers).values({
    organizationId,
    userId: setup.ownerUserId,
    // SYSTEM_ROLES always includes the owner.
    roleId: String(systemRoles.find((role) => role.key === 'owner')?.id),
    allStores: true,
  });
}
