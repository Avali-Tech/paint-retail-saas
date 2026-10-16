import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import { salesOverview, salesOverviewStart, type SalesOverview } from '@paint/shared';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import { DATABASE } from '../database/database.module.js';
import { storeScope } from '../leads/crm-lookups.js';
import { SALE_KINDS, saleSign } from '../reports/sales-basis.js';

export type { SalesOverview };

const { taxDocuments } = schema;

const isBill = sql`${taxDocuments.kind} in ('invoice', 'bill_of_supply')`;

/**
 * The dashboard's sales tile (MVP 3 round 7b): net sales today, this week and this month
 * against the period before, and the last 14 days, at the member's stores or one of them.
 * The same sales as the sales reports (reports/sales-basis.ts), read from the documents'
 * totals, which equal the sum of their lines: one query of one row per day.
 */
@Injectable()
export class SalesOverviewService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  get(auth: AuthContext, storeId?: string): Promise<SalesOverview> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const today = await indiaToday(tx);
      const days = await tx
        .select({
          day: sql<string>`${taxDocuments.issuedOn}::text`,
          billsTaxablePaise:
            sql<number>`coalesce(sum(${taxDocuments.taxablePaise}) filter (where ${isBill}), 0)`.mapWith(
              Number,
            ),
          taxablePaise: sql<number>`sum(${saleSign} * ${taxDocuments.taxablePaise})`.mapWith(
            Number,
          ),
          taxPaise:
            sql<number>`sum(${saleSign} * (${taxDocuments.cgstPaise} + ${taxDocuments.sgstPaise} + ${taxDocuments.igstPaise} + ${taxDocuments.cessPaise}))`.mapWith(
              Number,
            ),
          bills: sql<number>`(count(*) filter (where ${isBill}))::int`,
          creditNotes: sql<number>`(count(*) filter (where ${taxDocuments.kind} = 'credit_note'))::int`,
        })
        .from(taxDocuments)
        .where(
          and(
            eq(taxDocuments.status, 'issued'),
            inArray(taxDocuments.kind, [...SALE_KINDS]),
            storeScope(auth, taxDocuments.storeId, storeId),
            gte(taxDocuments.issuedOn, salesOverviewStart(today)),
            lte(taxDocuments.issuedOn, today),
          ),
        )
        .groupBy(taxDocuments.issuedOn);
      return salesOverview(today, days, new Date().toISOString());
    });
  }
}
