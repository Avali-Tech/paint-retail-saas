import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { canAccessStore } from '@paint/shared';
import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import { countFollowUps, followUpScope } from '../activities/activities.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import type { Dashboard, StorePosition } from '@paint/shared';

export type { Dashboard, StorePosition };

const {
  leads,
  opportunities,
  productVariants,
  projects,
  purchaseOrderLines,
  purchaseOrders,
  reorderRules,
  stockBalances,
  stores,
  transfers,
} = schema;

const OPEN_TRANSFER_STATUSES = ['requested', 'approved', 'in_transit'] as const;
const OPEN_PO_STATUSES = ['open', 'partially_received'] as const;

/** The owner's view of every store's position on one screen (roadmap P1-M22). */
@Injectable()
export class DashboardService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  get(auth: AuthContext, storeId?: string): Promise<Dashboard> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (storeId && !canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
      const shown = await tx
        .select({ id: stores.id, code: stores.code, name: stores.name })
        .from(stores)
        .where(
          and(
            eq(stores.isActive, true),
            storeId
              ? eq(stores.id, storeId)
              : auth.allStores
                ? undefined
                : inArray(stores.id, [...auth.storeIds]),
          ),
        )
        .orderBy(asc(stores.code));
      const ids = shown.map((store) => store.id);
      const can = (permission: Parameters<typeof auth.permissions.has>[0]) =>
        auth.permissions.has(permission);
      const stock = can('inventory:read') ? await this.stock(tx, ids) : null;
      const low = can('inventory:read') ? await this.lowStock(tx, ids) : null;
      const moving = can('inventory:read') ? await this.transfers(tx, ids) : null;
      const buying = can('purchasing:read') ? await this.purchaseOrders(tx, ids) : null;

      /** One entry per store shown, zeros where it has nothing; null without permission. */
      const perStore = <T>(found: Map<string, T> | null, empty: T): T[] | null =>
        found && shown.map((store) => found.get(store.id) ?? empty);
      const stockList = perStore(stock, { valuePaise: 0, units: 0, skus: 0, uncostedSkus: 0 });
      const lowList = perStore(low, { outOfStock: 0, belowMinimum: 0, reorder: 0 });
      const transferList = perStore(moving, { awaitingApproval: 0, toDispatch: 0, incoming: 0 });
      const orderList = perStore(buying, { open: 0, dueValuePaise: 0 });

      return {
        generatedAt: new Date().toISOString(),
        stores: shown.map((store, index) => ({
          store,
          stock: stockList?.[index] ?? null,
          lowStock: lowList?.[index] ?? null,
          transfers: transferList?.[index] ?? null,
          purchaseOrders: orderList?.[index] ?? null,
        })),
        totals: {
          stock: stockList && sumEach(stockList),
          lowStock: lowList && sumEach(lowList),
          transfers: transferList && sumEach(transferList),
          purchaseOrders: orderList && sumEach(orderList),
        },
        leads: can('leads:read') ? await this.leadStages(tx, ids) : null,
        opportunities: can('leads:read') ? await this.opportunityStages(tx, ids) : null,
        projects: can('projects:read') ? await this.projectStages(tx, ids) : null,
        followUps: await this.followUps(tx, auth, storeId),
      };
    });
  }

  // Per-store figures -------------------------------------------------------

  private async stock(tx: Transaction, ids: string[]) {
    const rows = await tx
      .select({
        storeId: stockBalances.storeId,
        valuePaise: sql<string>`coalesce(sum(round(${stockBalances.onHand} * ${stockBalances.avgCostPaise})), 0)`,
        units: sql<string>`coalesce(sum(${stockBalances.onHand}), 0)`,
        skus: sql<number>`count(*) filter (where ${stockBalances.onHand} > 0)::int`,
        uncostedSkus: sql<number>`count(*) filter (where ${stockBalances.onHand} > 0 and ${stockBalances.avgCostPaise} is null)::int`,
      })
      .from(stockBalances)
      .where(inArray(stockBalances.storeId, ids))
      .groupBy(stockBalances.storeId);
    return new Map(
      rows.map((row) => [
        row.storeId,
        {
          valuePaise: Number(row.valuePaise),
          units: Math.round(Number(row.units) * 1000) / 1000,
          skus: row.skus,
          uncostedSkus: row.uncostedSkus,
        },
      ]),
    );
  }

  private async lowStock(tx: Transaction, ids: string[]) {
    const available = sql`coalesce(${stockBalances.onHand}, 0) - coalesce(${stockBalances.reserved}, 0)`;
    const rows = await tx
      .select({
        storeId: reorderRules.storeId,
        outOfStock: sql<number>`count(*) filter (where ${available} <= 0)::int`,
        belowMinimum: sql<number>`count(*) filter (where ${available} > 0 and ${available} < ${reorderRules.minQuantity})::int`,
        reorder: sql<number>`count(*) filter (where ${available} >= ${reorderRules.minQuantity} and ${available} > 0 and ${available} <= ${reorderRules.reorderLevel})::int`,
      })
      .from(reorderRules)
      .innerJoin(productVariants, eq(productVariants.id, reorderRules.variantId))
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.storeId, reorderRules.storeId),
          eq(stockBalances.variantId, reorderRules.variantId),
        ),
      )
      .where(and(inArray(reorderRules.storeId, ids), eq(productVariants.isActive, true)))
      .groupBy(reorderRules.storeId);
    return new Map(rows.map(({ storeId, ...counts }) => [storeId, counts]));
  }

  private async transfers(tx: Transaction, ids: string[]) {
    const rows = await tx
      .select({
        fromStoreId: transfers.fromStoreId,
        toStoreId: transfers.toStoreId,
        status: transfers.status,
        count: count(),
      })
      .from(transfers)
      .where(
        and(
          inArray(transfers.status, [...OPEN_TRANSFER_STATUSES]),
          or(inArray(transfers.fromStoreId, ids), inArray(transfers.toStoreId, ids)),
        ),
      )
      .groupBy(transfers.fromStoreId, transfers.toStoreId, transfers.status);
    const tally = (status: string, side: 'fromStoreId' | 'toStoreId') => {
      const totals = new Map<string, number>();
      for (const row of rows.filter((r) => r.status === status)) {
        totals.set(row[side], (totals.get(row[side]) ?? 0) + row.count);
      }
      return totals;
    };
    const awaitingApproval = tally('requested', 'fromStoreId');
    const toDispatch = tally('approved', 'fromStoreId');
    const incoming = tally('in_transit', 'toStoreId');
    return new Map(
      ids.map((id) => [
        id,
        {
          awaitingApproval: awaitingApproval.get(id) ?? 0,
          toDispatch: toDispatch.get(id) ?? 0,
          incoming: incoming.get(id) ?? 0,
        },
      ]),
    );
  }

  private async purchaseOrders(tx: Transaction, ids: string[]) {
    const rows = await tx
      .select({
        storeId: purchaseOrders.storeId,
        open: sql<number>`count(distinct ${purchaseOrders.id})::int`,
        dueValuePaise: sql<string>`coalesce(sum(round((${purchaseOrderLines.orderedQuantity} - ${purchaseOrderLines.receivedQuantity}) * ${purchaseOrderLines.unitCostPaise})), 0)`,
      })
      .from(purchaseOrders)
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
      .where(
        and(
          inArray(purchaseOrders.storeId, ids),
          inArray(purchaseOrders.status, [...OPEN_PO_STATUSES]),
        ),
      )
      .groupBy(purchaseOrders.storeId);
    return new Map(
      rows.map((row) => [
        row.storeId,
        { open: row.open, dueValuePaise: Number(row.dueValuePaise) },
      ]),
    );
  }

  // Pipelines ---------------------------------------------------------------

  private async leadStages(tx: Transaction, ids: string[]) {
    const rows = await tx
      .select({
        stage: leads.stage,
        count: count(),
        valuePaise: sql<string>`coalesce(sum(${leads.estimatedValuePaise}), 0)`,
      })
      .from(leads)
      .where(inArray(leads.storeId, ids))
      .groupBy(leads.stage);
    return byStage(
      schema.leadStage.enumValues,
      rows,
      (row) => ({
        count: row.count,
        valuePaise: Number(row.valuePaise),
      }),
      { count: 0, valuePaise: 0 },
    );
  }

  private async opportunityStages(tx: Transaction, ids: string[]) {
    const rows = await tx
      .select({
        stage: opportunities.stage,
        count: count(),
        valuePaise: sql<string>`sum(${opportunities.expectedValuePaise})`,
        weightedValuePaise: sql<string>`sum(round(${opportunities.expectedValuePaise} * ${opportunities.probability} / 100.0))`,
      })
      .from(opportunities)
      .where(inArray(opportunities.storeId, ids))
      .groupBy(opportunities.stage);
    return byStage(
      schema.opportunityStage.enumValues,
      rows,
      (row) => ({
        count: row.count,
        valuePaise: Number(row.valuePaise),
        weightedValuePaise: Number(row.weightedValuePaise),
      }),
      { count: 0, valuePaise: 0, weightedValuePaise: 0 },
    );
  }

  private async projectStages(tx: Transaction, ids: string[]) {
    const rows = await tx
      .select({
        stage: projects.stage,
        count: count(),
        valuePaise: sql<string>`coalesce(sum(${projects.expectedOrderValuePaise}), 0)`,
      })
      .from(projects)
      .where(inArray(projects.storeId, ids))
      .groupBy(projects.stage);
    return byStage(
      schema.projectStage.enumValues,
      rows,
      (row) => ({
        count: row.count,
        valuePaise: Number(row.valuePaise),
      }),
      { count: 0, valuePaise: 0 },
    );
  }

  /** Counted exactly as /follow-ups lists them: the team's for managers, else the member's own. */
  private async followUps(tx: Transaction, auth: AuthContext, storeId: string | undefined) {
    const team = auth.permissions.has('members:read');
    const { overdue, today } = await countFollowUps(
      tx,
      followUpScope(auth, team ? null : auth.memberId, storeId),
    );
    return { scope: team ? ('team' as const) : ('mine' as const), overdue, today };
  }
}

/** Every stage in order, with zeros for stages that have nothing. */
function byStage<S extends string, R extends { stage: S }, T>(
  stages: readonly S[],
  rows: R[],
  toTotals: (row: R) => T,
  empty: T,
): ({ stage: S } & T)[] {
  const found = new Map(rows.map((row) => [row.stage, toTotals(row)]));
  return stages.map((stage) => ({ stage, ...(found.get(stage) ?? empty) }));
}

/** Adds up objects of numbers field by field. */
function sumEach<T extends Record<string, number>>(items: T[]): T {
  const totals: Record<string, number> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      totals[key] = Math.round(((totals[key] ?? 0) + value) * 1000) / 1000;
    }
  }
  return totals as T;
}
