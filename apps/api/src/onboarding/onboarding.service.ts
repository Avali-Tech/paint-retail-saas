import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';

const { organizationMembers, partyRoles, productVariants, reorderRules, stockLedger, stores } =
  schema;

export interface OnboardingStep {
  readonly key: string;
  readonly title: string;
  readonly done: boolean;
  readonly count: number;
  /** The import that completes this step, if there is one. */
  readonly importKind: string | null;
}

export interface Onboarding {
  readonly steps: OnboardingStep[];
  readonly completed: number;
  readonly total: number;
}

/** A new business's first steps, in the order to do them; `needed` is the count that marks one done. */
const STEPS = [
  { key: 'stores', title: 'Add your stores', needed: 1, importKind: null },
  { key: 'team', title: 'Invite your team', needed: 2, importKind: null },
  { key: 'products', title: 'Import your products', needed: 1, importKind: 'products' },
  { key: 'suppliers', title: 'Add your suppliers', needed: 1, importKind: 'parties' },
  {
    key: 'customers',
    title: 'Add customers, contractors and painters',
    needed: 1,
    importKind: 'parties',
  },
  { key: 'opening_stock', title: 'Enter opening stock', needed: 1, importKind: 'opening-stock' },
  { key: 'reorder_rules', title: 'Set reorder levels', needed: 1, importKind: null },
] as const;

@Injectable()
export class OnboardingService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Counts across the whole business, so every member sees the same progress. */
  get(auth: AuthContext): Promise<Onboarding> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const result = await tx.execute<Record<(typeof STEPS)[number]['key'], number>>(sql`
        select
          (select count(*)::int from ${stores} where ${stores.isActive}) as stores,
          (select count(*)::int from ${organizationMembers} where ${organizationMembers.isActive}) as team,
          (select count(*)::int from ${productVariants}) as products,
          (select count(distinct ${partyRoles.partyId})::int from ${partyRoles}
            where ${partyRoles.role} = 'supplier') as suppliers,
          (select count(distinct ${partyRoles.partyId})::int from ${partyRoles}
            where ${partyRoles.role} in ('customer', 'contractor', 'painter')) as customers,
          (select count(*)::int from ${stockLedger}
            where ${stockLedger.movementType} = 'opening') as opening_stock,
          (select count(*)::int from ${reorderRules}) as reorder_rules
      `);
      const [counts] = result.rows;
      const steps = STEPS.map(({ key, title, needed, importKind }) => {
        const found = Number(counts?.[key]);
        return { key, title, done: found >= needed, count: found, importKind };
      });
      return {
        steps,
        completed: steps.filter((step) => step.done).length,
        total: steps.length,
      };
    });
  }
}
