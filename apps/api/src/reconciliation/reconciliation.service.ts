import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  RECONCILIATION_KINDS,
  variantName,
  type LatestReconciliation,
  type ReconciliationKind,
  type ReconciliationRunPage,
  type ReconciliationRunSummary,
  type ReconciliationRunView,
} from '@paint/shared';
import { asc, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { Notifier } from '../notifications/notifier.js';
import { reconcile } from './reconciler.js';
import type { ListRunsQuery } from './reconciliation.schemas.js';

const {
  organizationMembers,
  parties,
  productVariants,
  products,
  reconciliationFindings,
  reconciliationRuns,
  stores,
  users,
} = schema;

/** Reconciliations of the books (spec §3.3, §4.6): the latest, the history, and "Run now". */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  latest(auth: AuthContext): Promise<LatestReconciliation> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [run] = await this.summaries(tx, undefined, 1, 0);
      return { run: run ? await this.withFindings(tx, run) : null };
    });
  }

  list(auth: AuthContext, query: ListRunsQuery): Promise<ReconciliationRunPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [total] = await tx.select({ value: count() }).from(reconciliationRuns);
      return {
        items: await this.summaries(tx, undefined, query.limit, query.offset),
        total: Number(total?.value),
      };
    });
  }

  get(auth: AuthContext, id: string): Promise<ReconciliationRunView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.view(tx, id));
  }

  /** Reconciles the books now, as the nightly job does, and returns what it found. */
  run(auth: AuthContext): Promise<ReconciliationRunView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      // A manual run is never a duplicate of the nightly one.
      const id = String(
        await reconcile(tx, this.notifier, {
          organizationId: auth.organization.id,
          trigger: 'manual',
          memberId: auth.memberId,
        }),
      );
      return this.view(tx, id);
    });
  }

  // Helpers -----------------------------------------------------------------

  private async view(tx: Transaction, id: string): Promise<ReconciliationRunView> {
    const [run] = await this.summaries(tx, eq(reconciliationRuns.id, id), 1, 0);
    if (!run) throw new NotFoundException('Reconciliation not found');
    return this.withFindings(tx, run);
  }

  /** Runs newest first, with their findings counted by kind. */
  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
    offset: number,
  ): Promise<ReconciliationRunSummary[]> {
    const runs = await tx
      .select({
        id: reconciliationRuns.id,
        trigger: reconciliationRuns.trigger,
        runOn: reconciliationRuns.runOn,
        ranAt: reconciliationRuns.ranAt,
        findingCount: reconciliationRuns.findingCount,
        memberId: reconciliationRuns.requestedByMemberId,
        memberName: users.fullName,
      })
      .from(reconciliationRuns)
      .leftJoin(
        organizationMembers,
        eq(organizationMembers.id, reconciliationRuns.requestedByMemberId),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(where)
      .orderBy(desc(reconciliationRuns.ranAt), desc(reconciliationRuns.id))
      .limit(limit)
      .offset(offset);
    const counts = await tx
      .select({
        runId: reconciliationFindings.runId,
        kind: reconciliationFindings.kind,
        value: count(),
      })
      .from(reconciliationFindings)
      .where(
        inArray(
          reconciliationFindings.runId,
          runs.map((run) => run.id),
        ),
      )
      .groupBy(reconciliationFindings.runId, reconciliationFindings.kind);
    return runs.map(({ memberId, memberName, ranAt, ...run }) => {
      const byKind = Object.fromEntries(
        RECONCILIATION_KINDS.map((kind) => [
          kind,
          counts.find((c) => c.runId === run.id && c.kind === kind)?.value ?? 0,
        ]),
      ) as Record<ReconciliationKind, number>;
      return {
        ...run,
        ranAt: ranAt.toISOString(),
        requestedBy: memberId === null ? null : { memberId, name: String(memberName) },
        counts: byKind,
      };
    });
  }

  private async withFindings(
    tx: Transaction,
    run: ReconciliationRunSummary,
  ): Promise<ReconciliationRunView> {
    const rows = await tx
      .select({
        id: reconciliationFindings.id,
        kind: reconciliationFindings.kind,
        storeId: reconciliationFindings.storeId,
        storeName: stores.name,
        variantId: reconciliationFindings.variantId,
        sku: productVariants.sku,
        productName: products.name,
        packSize: productVariants.packSize,
        unit: productVariants.unit,
        label: productVariants.label,
        partyId: reconciliationFindings.partyId,
        partyName: parties.displayName,
        recorded: reconciliationFindings.recorded,
        expected: reconciliationFindings.expected,
        advancePaise: reconciliationFindings.advancePaise,
        unallocatedPaise: reconciliationFindings.unallocatedPaise,
      })
      .from(reconciliationFindings)
      .leftJoin(stores, eq(stores.id, reconciliationFindings.storeId))
      .leftJoin(productVariants, eq(productVariants.id, reconciliationFindings.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(parties, eq(parties.id, reconciliationFindings.partyId))
      .where(eq(reconciliationFindings.runId, run.id))
      .orderBy(
        asc(reconciliationFindings.kind),
        asc(stores.name),
        asc(productVariants.sku),
        asc(parties.displayName),
        asc(reconciliationFindings.id),
      );
    return {
      ...run,
      findings: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        store: row.storeId === null ? null : { id: row.storeId, name: String(row.storeName) },
        variant:
          row.variantId === null
            ? null
            : {
                id: row.variantId,
                sku: String(row.sku),
                name: `${String(row.productName)} ${variantName({
                  packSize: Number(row.packSize),
                  unit: String(row.unit),
                  label: row.label,
                })}`,
              },
        party: row.partyId === null ? null : { id: row.partyId, name: String(row.partyName) },
        recorded: row.recorded,
        expected: row.expected,
        difference: Math.round((row.recorded - row.expected) * 1000) / 1000,
        advancePaise: row.advancePaise,
        unallocatedPaise: row.unallocatedPaise,
      })),
    };
  }
}
