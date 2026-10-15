import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  ageReceivables,
  emptyTotals,
  sumTotals,
  type AgeingPage,
  type AgeingResult,
  type MemberAccess,
  type ReceivablesSummaryView,
} from '@paint/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import { DATABASE } from '../database/database.module.js';
import { storeScope } from '../leads/crm-lookups.js';
import { loadAgeing, type AgeingScope } from './ageing-data.js';
import {
  ageingRows,
  receivablesSummary,
  type AgeingLookups,
  type PartyInfo,
  type StoreInfo,
} from './ageing-rows.js';
import type { AgeingQueryInput, ReceivablesQueryInput } from './receivables.schemas.js';

const { creditProfiles, customerProfiles, organizationMembers, parties, stores, users } = schema;

const salespeople = alias(organizationMembers, 'salesperson');
const salespersonUsers = alias(users, 'salesperson_user');

/** The scope's store filter, refused (404) for a store the member does not work at. */
function checkedScope(auth: MemberAccess, scope: AgeingScope): AgeingScope {
  if (scope.storeId !== undefined) storeScope(auth, stores.id, scope.storeId);
  return scope;
}

/** The ageing of every party in scope (store access checked), as of `scope.asOf`. */
export async function ageBooks(
  tx: Transaction,
  auth: MemberAccess,
  scope: AgeingScope,
): Promise<AgeingResult> {
  const input = await loadAgeing(tx, auth, checkedScope(auth, scope));
  return ageReceivables({ asOf: scope.asOf, ...input });
}

/**
 * Names, mobiles, salespeople and credit limits of the result's parties and of every
 * credit customer in scope, and the result's stores.
 */
export async function ageingLookups(
  tx: Transaction,
  auth: AuthContext,
  result: AgeingResult,
  creditCustomers: readonly string[] = [],
): Promise<AgeingLookups> {
  const partyIds = [
    ...new Set([
      ...result.receivables.map((r) => r.partyId),
      ...result.credits.map((c) => c.partyId),
      ...creditCustomers,
    ]),
  ];
  const storeIds = [
    ...new Set(
      [...result.receivables, ...result.credits].flatMap((item) =>
        item.storeId === null ? [] : [item.storeId],
      ),
    ),
  ];
  const partyRows =
    partyIds.length === 0
      ? []
      : await tx
          .select({
            id: parties.id,
            name: parties.displayName,
            phone: parties.phone,
            salespersonId: customerProfiles.assignedMemberId,
            salespersonName: salespersonUsers.fullName,
            limit: sql<
              string | null
            >`case when ${creditProfiles.status} <> 'none' then ${creditProfiles.limitPaise} end`,
          })
          .from(parties)
          .leftJoin(customerProfiles, eq(customerProfiles.partyId, parties.id))
          .leftJoin(salespeople, eq(salespeople.id, customerProfiles.assignedMemberId))
          .leftJoin(salespersonUsers, eq(salespersonUsers.id, salespeople.userId))
          .leftJoin(creditProfiles, eq(creditProfiles.partyId, parties.id))
          .where(inArray(parties.id, partyIds));
  const storeRows =
    storeIds.length === 0
      ? []
      : await tx
          .select({ id: stores.id, name: stores.name, code: stores.code })
          .from(stores)
          .where(inArray(stores.id, storeIds));
  return {
    parties: new Map<string, PartyInfo>(
      partyRows.map(({ id, limit, ...party }) => [
        id,
        { ...party, limitPaise: limit === null ? null : Number(limit) },
      ]),
    ),
    stores: new Map<string, StoreInfo>(storeRows.map(({ id, ...store }) => [id, store])),
  };
}

/** Receivables and their ageing (roadmap P2-M10): the dashboard and the ageing tables. */
@Injectable()
export class ReceivablesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  summary(auth: AuthContext, query: ReceivablesQueryInput): Promise<ReceivablesSummaryView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const scope = { ...query, asOf: query.asOf ?? (await indiaToday(tx)) };
      const result = await ageBooks(tx, auth, scope);
      // Every credit customer in scope counts towards the limit given, owing or not.
      const credit = await loadAgeingCreditCustomers(tx, auth, scope);
      return receivablesSummary(result, await ageingLookups(tx, auth, result, credit));
    });
  }

  ageing(auth: AuthContext, query: AgeingQueryInput): Promise<AgeingPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const { groupBy, overdueOnly, limit, offset, ...filters } = query;
      const asOf = filters.asOf ?? (await indiaToday(tx));
      const result = await ageBooks(tx, auth, { ...filters, asOf });
      const rows = ageingRows(result, groupBy, await ageingLookups(tx, auth, result)).filter(
        (row) => !overdueOnly || (row.maxDaysPastDue ?? 0) > 0,
      );
      return {
        asOf,
        groupBy,
        rows: rows.slice(offset, offset + limit),
        totals: rows.reduce((sum, row) => sumTotals(sum, row.totals), emptyTotals()),
        total: rows.length,
      };
    });
  }
}

/** Credit customers (credit given, a limit above zero) the scope covers. */
async function loadAgeingCreditCustomers(
  tx: Transaction,
  auth: AuthContext,
  scope: AgeingScope,
): Promise<string[]> {
  const rows = await tx
    .select({ partyId: creditProfiles.partyId })
    .from(creditProfiles)
    .innerJoin(parties, eq(parties.id, creditProfiles.partyId))
    .leftJoin(customerProfiles, eq(customerProfiles.partyId, parties.id))
    .where(
      and(
        ne(creditProfiles.status, 'none'),
        auth.allStores
          ? undefined
          : sql`(${parties.homeStoreId} is null or ${inArray(parties.homeStoreId, [...auth.storeIds])})`,
        scope.salespersonId === undefined
          ? undefined
          : scope.salespersonId === 'none'
            ? sql`${customerProfiles.assignedMemberId} is null`
            : eq(customerProfiles.assignedMemberId, scope.salespersonId),
      ),
    );
  return rows.map((row) => row.partyId);
}
