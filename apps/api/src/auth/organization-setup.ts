import { randomUUID } from 'node:crypto';
import { schema, type Transaction } from '@paint/db';
import { SYSTEM_ROLES, type PlanKey } from '@paint/shared';
import { sql } from 'drizzle-orm';

const {
  organizationMembers,
  organizations,
  rolePermissions,
  roles,
  subscriptionPlanChanges,
  subscriptions,
} = schema;

/**
 * Creates a business with the standard roles and makes `ownerUserId` its
 * owner. Used by self sign-up and by the platform console; platform scope.
 * A business on the trial gets `trialDays` of it; one started on a paid plan
 * by the platform is active, invoiced outside the product until it pays online.
 */
export async function setUpOrganization(
  tx: Transaction,
  setup: {
    organizationId: string;
    name: string;
    ownerUserId: string;
    plan: PlanKey;
    trialDays: number;
  },
): Promise<void> {
  const { organizationId, plan } = setup;
  const systemRoles = SYSTEM_ROLES.map((role) => ({ ...role, id: randomUUID() }));
  await tx.insert(organizations).values({ id: organizationId, name: setup.name, plan });
  await tx.insert(subscriptions).values(
    plan === 'trial'
      ? {
          organizationId,
          status: 'trialing',
          trialEndsAt: sql`now() + make_interval(days => ${setup.trialDays})`,
        }
      : { organizationId, status: 'active' },
  );
  await tx
    .insert(subscriptionPlanChanges)
    .values({ organizationId, fromPlan: null, toPlan: plan, source: 'signup' });
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
