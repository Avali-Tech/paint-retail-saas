import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import { SETUP_STEP_KEYS, type SetupChecklistView, type SetupStepKey } from '@paint/shared';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';

const {
  creditRules,
  organizationLogos,
  organizationMembers,
  partyRoles,
  paymentGatewayAccounts,
  productVariants,
  salesSettings,
  stockLedger,
  stores,
} = schema;

/** How many of each a step needs to be done; stores and GST also need no store without it. */
const NEEDED: Readonly<Record<SetupStepKey, number>> = {
  stores_gst: 1,
  products: 1,
  customers: 1,
  opening_stock: 1,
  team: 2,
  credit_rules: 1,
  billing_live: 1,
  invoice_print: 1,
  payment_links: 1,
};

type Counts = Record<SetupStepKey | 'stores_without_gst', number>;

/**
 * A new business's "Getting started" checklist (docs/mvp-3/navigation-ux.md §6 step 3),
 * worked out from its own records every time: nothing is stored, so a step undone
 * (a store added without its GST) shows as not done again.
 */
@Injectable()
export class OnboardingService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Counts across the whole business, so every member sees the same progress. */
  get(auth: AuthContext): Promise<SetupChecklistView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const settings = sql`(select * from ${salesSettings} limit 1)`;
      const result = await tx.execute<Counts>(sql`
        select
          (select count(*)::int from ${stores}
            where ${stores.isActive} and ${stores.type} = 'store' and ${stores.stateCode} is not null) as stores_gst,
          (select count(*)::int from ${stores}
            where ${stores.isActive} and ${stores.type} = 'store' and ${stores.stateCode} is null) as stores_without_gst,
          (select count(*)::int from ${productVariants}) as products,
          (select count(distinct ${partyRoles.partyId})::int from ${partyRoles}
            where ${partyRoles.role} in ('customer', 'contractor', 'painter')
              and ${partyRoles.partyId} is distinct from (select s.walk_in_party_id from ${settings} s)) as customers,
          (select count(*)::int from ${stockLedger}
            where ${stockLedger.movementType} = 'opening') as opening_stock,
          (select count(*)::int from ${organizationMembers} where ${organizationMembers.isActive}) as team,
          (select count(*)::int from ${creditRules}) as credit_rules,
          (select count(*)::int from ${settings} s where s.billing_live_on is not null) as billing_live,
          (select
            coalesce((select (s.bank_name is not null)::int + (coalesce(cardinality(s.invoice_terms), 0) > 0)::int
              from ${settings} s), 0)
            + (select count(*)::int from ${organizationLogos})) as invoice_print,
          (select count(*)::int from ${paymentGatewayAccounts}
            where ${paymentGatewayAccounts.connectedAt} is not null) as payment_links
      `);
      const [counts] = result.rows as [Counts];
      const steps = SETUP_STEP_KEYS.map((key) => {
        const count = counts[key];
        const done =
          count >= NEEDED[key] && (key !== 'stores_gst' || counts.stores_without_gst === 0);
        return { key, done, count };
      });
      return {
        steps,
        completed: steps.filter((step) => step.done).length,
        total: steps.length,
      };
    });
  }
}
