import { ForbiddenException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { PLANS } from '@paint/shared';
import { and, count, eq } from 'drizzle-orm';

const { organizationMembers, organizations, stores } = schema;

/** Refuses to add a store or member beyond the business's plan. Runs in tenant scope. */
export async function requireRoomFor(
  tx: Transaction,
  organizationId: string,
  what: 'stores' | 'members',
): Promise<void> {
  const plans = (
    await tx
      .select({ plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
  ).map((business) => PLANS[business.plan]);
  for (const plan of plans) {
    const limit = what === 'stores' ? plan.maxStores : plan.maxMembers;
    if (limit === null) return;
    const [used] =
      what === 'stores'
        ? await tx.select({ n: count() }).from(stores).where(eq(stores.isActive, true))
        : await tx
            .select({ n: count() })
            .from(organizationMembers)
            .where(
              and(eq(organizationMembers.isActive, true), eq(organizationMembers.isSupport, false)),
            );
    if (Number(used?.n) >= limit) {
      throw new ForbiddenException(
        `The ${plan.name} plan allows ${String(limit)} ${what === 'stores' ? 'active stores' : 'active team members'}. The owner can upgrade the plan under Billing.`,
      );
    }
  }
}
