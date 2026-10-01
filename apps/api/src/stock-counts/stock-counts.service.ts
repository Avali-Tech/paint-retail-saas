import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InsufficientStockError,
  isCheckViolation,
  nextDocumentNumber,
  postStockMovements,
  schema,
  uniqueViolationConstraint,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { canAccessStore, formatDocumentNumber } from '@paint/shared';
import { and, count, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { Notifier } from '../notifications/notifier.js';
import type {
  ApproveCountInput,
  COUNT_STATUSES,
  ListCountsQuery,
  RecordCountsInput,
  StartCountInput,
  VARIANCE_REASONS,
} from './stock-counts.schemas.js';

const {
  brands,
  categories,
  productBarcodes,
  productVariants,
  products,
  stockBalances,
  stockCountLines,
  stockCounts,
  stores,
} = schema;

type CountStatus = (typeof COUNT_STATUSES)[number];
type VarianceReason = (typeof VARIANCE_REASONS)[number];
type CountRow = typeof stockCounts.$inferSelect;
type CountChanges = PgUpdateSetSource<typeof stockCounts>;

export interface CountLineView {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly expectedQuantity: number;
  readonly countedQuantity: number | null;
  /** counted - expected; null until counted. */
  readonly variance: number | null;
  /** variance × the store's average cost, in paise; null without a cost. */
  readonly varianceValuePaise: number | null;
  readonly reason: VarianceReason | null;
}

export interface CountSummary {
  readonly totalLines: number;
  readonly countedLines: number;
  readonly uncountedLines: number;
  readonly matchingLines: number;
  /** Share of counted products whose count matched the books; null before any count. */
  readonly accuracyPercent: number | null;
  readonly netVarianceValuePaise: number;
  readonly absoluteVarianceValuePaise: number;
}

export interface CountView {
  readonly id: string;
  readonly number: string;
  readonly status: CountStatus;
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly scope: CountRow['scope'];
  readonly scopeId: string | null;
  readonly note: string | null;
  readonly closingReason: string | null;
  readonly startedAt: string;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly closedAt: string | null;
  readonly summary: CountSummary;
  readonly lines: CountLineView[];
}

export interface CountListItem {
  readonly id: string;
  readonly number: string;
  readonly status: CountStatus;
  readonly store: { readonly id: string; readonly code: string };
  readonly scope: CountRow['scope'];
  readonly startedAt: string;
}

export interface StoreAccuracy {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  /** The most recent approved count, or null if the store was never counted. */
  readonly lastCount: {
    readonly number: string;
    readonly approvedAt: string;
    readonly accuracyPercent: number | null;
    readonly countedLines: number;
  } | null;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);
const round3 = (value: number) => Math.round(value * 1000) / 1000;

@Injectable()
export class StockCountsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  /** Starts a count, recording the books for every product in scope that the store holds. */
  async start(auth: AuthContext, input: StartCountInput): Promise<CountView> {
    const organizationId = auth.organization.id;
    try {
      return await withTenant(this.connection.db, organizationId, async (tx) => {
        await this.assertStore(tx, auth, input.storeId);
        const id = crypto.randomUUID();
        const number = formatDocumentNumber(
          'SC',
          await nextDocumentNumber(tx, organizationId, 'stock_count'),
        );
        await tx.insert(stockCounts).values({
          id,
          organizationId,
          number,
          storeId: input.storeId,
          scope: input.scope,
          scopeId: input.scopeId ?? null,
          note: input.note,
          startedByMemberId: auth.memberId,
        });
        const scopeFilter = await this.scopeFilter(tx, input.scope, input.scopeId ?? null);
        const held = await tx
          .select({ variantId: stockBalances.variantId, onHand: stockBalances.onHand })
          .from(stockBalances)
          .innerJoin(productVariants, eq(productVariants.id, stockBalances.variantId))
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(and(eq(stockBalances.storeId, input.storeId), scopeFilter));
        if (held.length > 0) {
          await tx.insert(stockCountLines).values(
            held.map((row) => ({
              organizationId,
              countId: id,
              variantId: row.variantId,
              expectedQuantity: row.onHand,
            })),
          );
        }
        return this.view(tx, auth, id);
      });
    } catch (error) {
      if (uniqueViolationConstraint(error) === 'stock_counts_one_open_per_store') {
        throw new ConflictException(
          'A count is already open at this store; finish or cancel it first',
        );
      }
      throw error;
    }
  }

  /** Records counted quantities, adding products found on the shelf that were not listed. */
  record(auth: AuthContext, countId: string, input: RecordCountsInput): Promise<CountView> {
    return this.act(auth, countId, ['counting'], 'counting', async (tx, stockCount) => {
      const scopeFilter = await this.scopeFilter(tx, stockCount.scope, stockCount.scopeId);
      for (const entry of input.entries) {
        const variantId = await this.resolveVariant(tx, entry.variantId, entry.code);
        const [inScope] = await tx
          .select({ id: productVariants.id })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(and(eq(productVariants.id, variantId), scopeFilter));
        if (!inScope)
          throw new BadRequestException(`${entry.code ?? variantId} is not part of this count`);

        await tx
          .insert(stockCountLines)
          .values({
            organizationId: auth.organization.id,
            countId,
            variantId,
            expectedQuantity: sql`coalesce((
              select ${stockBalances.onHand} from ${stockBalances}
              where ${stockBalances.storeId} = ${stockCount.storeId} and ${stockBalances.variantId} = ${variantId}
            ), 0)`,
          })
          .onConflictDoNothing();
        try {
          await tx
            .update(stockCountLines)
            .set({
              countedQuantity:
                entry.mode === 'set'
                  ? entry.quantity
                  : sql`coalesce(${stockCountLines.countedQuantity}, 0) + ${entry.quantity}`,
              countedByMemberId: auth.memberId,
              countedAt: sql`now()`,
            })
            .where(
              and(eq(stockCountLines.countId, countId), eq(stockCountLines.variantId, variantId)),
            );
        } catch (error) {
          if (isCheckViolation(error, ['stock_count_lines_counted_not_negative'])) {
            throw new BadRequestException('A counted quantity cannot go below zero');
          }
          throw error;
        }
      }
      return {};
    });
  }

  submit(auth: AuthContext, countId: string, uncountedAsZero: boolean): Promise<CountView> {
    return this.act(auth, countId, ['counting'], 'submitted', async (tx, stockCount) => {
      const uncounted = await tx
        .select({ sku: productVariants.sku })
        .from(stockCountLines)
        .innerJoin(productVariants, eq(productVariants.id, stockCountLines.variantId))
        .where(
          and(eq(stockCountLines.countId, stockCount.id), isNull(stockCountLines.countedQuantity)),
        )
        .orderBy(productVariants.sku);
      if (uncounted.length > 0 && !uncountedAsZero) {
        throw new BadRequestException(
          `${String(uncounted.length)} product(s) not counted yet: ${uncounted.map((row) => row.sku).join(', ')}. ` +
            'Count them, or submit with uncountedAsZero if they are not on the shelf.',
        );
      }
      await tx
        .update(stockCountLines)
        .set({ countedQuantity: 0, countedByMemberId: auth.memberId, countedAt: sql`now()` })
        .where(
          and(eq(stockCountLines.countId, stockCount.id), isNull(stockCountLines.countedQuantity)),
        );
      const { store, lines } = await this.view(tx, auth, stockCount.id);
      await this.notifier.notify(tx, {
        organizationId: auth.organization.id,
        event: 'stock_count_awaiting_approval',
        storeId: stockCount.storeId,
        permission: 'inventory:manage',
        actorMemberId: auth.memberId,
        title: `Stock count ${stockCount.number} needs your approval`,
        body: `${auth.user.fullName} has counted ${String(lines.length)} product(s) at ${store.name}. Check the differences and approve.`,
        link: `/stock-counts/${stockCount.id}`,
      });
      return { submittedByMemberId: auth.memberId, submittedAt: sql`now()` };
    });
  }

  /** Sends a submitted count back for recounting. */
  reopen(auth: AuthContext, countId: string): Promise<CountView> {
    return this.act(auth, countId, ['submitted'], 'counting', () =>
      Promise.resolve({ submittedByMemberId: null, submittedAt: null }),
    );
  }

  /** Approves the count and posts a correction for every difference. */
  approve(auth: AuthContext, countId: string, input: ApproveCountInput): Promise<CountView> {
    return this.act(auth, countId, ['submitted'], 'approved', async (tx, stockCount) => {
      if (stockCount.submittedByMemberId === auth.memberId && !auth.allStores) {
        throw new ForbiddenException('Someone else must approve a count you submitted');
      }
      for (const { variantId, reason } of input.reasons) {
        const updated = await tx
          .update(stockCountLines)
          .set({ reason })
          .where(
            and(
              eq(stockCountLines.countId, stockCount.id),
              eq(stockCountLines.variantId, variantId),
            ),
          )
          .returning({ variantId: stockCountLines.variantId });
        if (updated.length === 0)
          throw new BadRequestException('A reason was given for a product not on this count');
      }
      const lines = await tx
        .select({
          variantId: stockCountLines.variantId,
          sku: productVariants.sku,
          variance: sql<string>`${stockCountLines.countedQuantity} - ${stockCountLines.expectedQuantity}`,
          reason: stockCountLines.reason,
        })
        .from(stockCountLines)
        .innerJoin(productVariants, eq(productVariants.id, stockCountLines.variantId))
        .where(
          and(
            eq(stockCountLines.countId, stockCount.id),
            sql`${stockCountLines.countedQuantity} <> ${stockCountLines.expectedQuantity}`,
          ),
        );
      try {
        await postStockMovements(
          tx,
          lines.map((line) => ({
            organizationId: auth.organization.id,
            storeId: stockCount.storeId,
            variantId: line.variantId,
            movementType: 'count_correction' as const,
            quantity: Number(line.variance),
            referenceType: 'stock_count',
            referenceId: stockCount.id,
            note: `${stockCount.number}: ${(line.reason ?? 'count correction').replace('_', ' ')}`,
            createdByMemberId: auth.memberId,
          })),
        );
      } catch (error) {
        if (error instanceof InsufficientStockError) {
          const sku = lines.find((line) => line.variantId === error.variantId)?.sku;
          throw new ConflictException(
            `Stock of ${String(sku)} has fallen since the count started; reopen and recount it`,
          );
        }
        throw error;
      }
      return { approvedByMemberId: auth.memberId, approvedAt: sql`now()` };
    });
  }

  cancel(auth: AuthContext, countId: string, reason: string): Promise<CountView> {
    return this.act(auth, countId, ['counting', 'submitted'], 'cancelled', () =>
      Promise.resolve({
        closingReason: reason,
        closedByMemberId: auth.memberId,
        closedAt: sql`now()`,
      }),
    );
  }

  get(auth: AuthContext, countId: string): Promise<CountView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, countId),
    );
  }

  list(auth: AuthContext, query: ListCountsQuery) {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (query.storeId && !canAccessStore(auth, query.storeId)) {
        throw new NotFoundException('Store not found');
      }
      const where = and(
        query.storeId ? eq(stockCounts.storeId, query.storeId) : this.storeScope(auth),
        query.status ? eq(stockCounts.status, query.status) : undefined,
      );
      const rows = await tx
        .select({ count: stockCounts, storeCode: stores.code })
        .from(stockCounts)
        .innerJoin(stores, eq(stores.id, stockCounts.storeId))
        .where(where)
        .orderBy(desc(stockCounts.startedAt), desc(stockCounts.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(stockCounts).where(where);
      return {
        items: rows.map(({ count: row, storeCode }): CountListItem => ({
          id: row.id,
          number: row.number,
          status: row.status,
          store: { id: row.storeId, code: storeCode },
          scope: row.scope,
          startedAt: row.startedAt.toISOString(),
        })),
        total: Number(totals?.total),
      };
    });
  }

  /** Each store's accuracy at its most recent approved count. */
  accuracy(auth: AuthContext): Promise<StoreAccuracy[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const storeRows = await tx
        .select()
        .from(stores)
        .where(
          and(
            eq(stores.isActive, true),
            auth.allStores ? undefined : inArray(stores.id, [...auth.storeIds]),
          ),
        )
        .orderBy(stores.code);
      const result: StoreAccuracy[] = [];
      for (const store of storeRows) {
        const [latest] = await tx
          .select()
          .from(stockCounts)
          .where(and(eq(stockCounts.storeId, store.id), eq(stockCounts.status, 'approved')))
          .orderBy(desc(stockCounts.approvedAt))
          .limit(1);
        result.push({
          store: { id: store.id, code: store.code, name: store.name },
          lastCount: latest ? await this.lastCount(tx, auth, latest) : null,
        });
      }
      return result;
    });
  }

  // Helpers -----------------------------------------------------------------

  private async lastCount(
    tx: Transaction,
    auth: AuthContext,
    stockCount: CountRow,
  ): Promise<NonNullable<StoreAccuracy['lastCount']>> {
    const { summary } = await this.view(tx, auth, stockCount.id);
    return {
      number: stockCount.number,
      approvedAt: String(iso(stockCount.approvedAt)),
      accuracyPercent: summary.accuracyPercent,
      countedLines: summary.countedLines,
    };
  }

  /**
   * Runs one step: the member must manage stock at the count's store, and the
   * status moves only from an expected one, so double submissions apply once.
   */
  private act(
    auth: AuthContext,
    countId: string,
    allowed: CountStatus[],
    next: CountStatus,
    work: (tx: Transaction, stockCount: CountRow) => Promise<CountChanges>,
  ): Promise<CountView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const stockCount = await this.load(tx, auth, countId);
      if (!allowed.includes(stockCount.status)) {
        throw new ConflictException(`This count is ${stockCount.status}`);
      }
      const moved = await tx
        .update(stockCounts)
        .set({ status: next, updatedAt: sql`now()` })
        .where(and(eq(stockCounts.id, countId), inArray(stockCounts.status, allowed)))
        .returning({ id: stockCounts.id });
      if (moved.length === 0)
        throw new ConflictException('Someone else just changed this count; reload it');
      const changes = await work(tx, stockCount);
      // Counting changes only lines; other steps also record who and when.
      if (Object.keys(changes).length > 0) {
        await tx.update(stockCounts).set(changes).where(eq(stockCounts.id, countId));
      }
      return this.view(tx, auth, countId);
    });
  }

  private storeScope(auth: AuthContext): SQL | undefined {
    return auth.allStores ? undefined : inArray(stockCounts.storeId, [...auth.storeIds]);
  }

  private async assertStore(tx: Transaction, auth: AuthContext, storeId: string): Promise<void> {
    const [store] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId));
    if (!store || !canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
  }

  /** Products a count covers: all, one brand, or one category with its subcategories. */
  private async scopeFilter(
    tx: Transaction,
    scope: CountRow['scope'],
    scopeId: string | null,
  ): Promise<SQL | undefined> {
    // A partial count always has a scope id (enforced by a database check).
    if (scope === 'full') return undefined;
    const id = String(scopeId);
    if (scope === 'brand') {
      const [brand] = await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, id));
      if (!brand) throw new BadRequestException('Unknown brand');
      return eq(products.brandId, id);
    }
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, id));
    if (!category) throw new BadRequestException('Unknown category');
    return or(
      eq(products.categoryId, id),
      inArray(
        products.categoryId,
        tx.select({ id: categories.id }).from(categories).where(eq(categories.parentId, id)),
      ),
    );
  }

  /** The variant for an id, or for a scanned barcode / typed SKU. */
  private async resolveVariant(
    tx: Transaction,
    variantId: string | undefined,
    code: string | undefined,
  ): Promise<string> {
    const [found] = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .leftJoin(productBarcodes, eq(productBarcodes.variantId, productVariants.id))
      .where(
        variantId
          ? eq(productVariants.id, variantId)
          : or(
              eq(productBarcodes.barcode, String(code)),
              eq(productVariants.sku, String(code).toUpperCase()),
            ),
      )
      .limit(1);
    if (!found) throw new BadRequestException(`Unknown product: ${code ?? String(variantId)}`);
    return found.id;
  }

  private async load(tx: Transaction, auth: AuthContext, countId: string): Promise<CountRow> {
    const [stockCount] = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId));
    if (!stockCount || !canAccessStore(auth, stockCount.storeId)) {
      throw new NotFoundException('Stock count not found');
    }
    return stockCount;
  }

  private async view(tx: Transaction, auth: AuthContext, countId: string): Promise<CountView> {
    const stockCount = await this.load(tx, auth, countId);
    const [store] = await tx
      .select({ id: stores.id, code: stores.code, name: stores.name })
      .from(stores)
      .where(eq(stores.id, stockCount.storeId));
    const rows = await tx
      .select({
        line: stockCountLines,
        sku: productVariants.sku,
        productName: products.name,
        brandName: brands.name,
        avgCostPaise: stockBalances.avgCostPaise,
      })
      .from(stockCountLines)
      .innerJoin(productVariants, eq(productVariants.id, stockCountLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.storeId, stockCount.storeId),
          eq(stockBalances.variantId, stockCountLines.variantId),
        ),
      )
      .where(eq(stockCountLines.countId, countId))
      .orderBy(productVariants.sku);
    const lines: CountLineView[] = rows.map(
      ({ line, sku, productName, brandName, avgCostPaise }) => {
        const variance =
          line.countedQuantity === null
            ? null
            : round3(line.countedQuantity - line.expectedQuantity);
        return {
          variantId: line.variantId,
          sku,
          productName,
          brandName,
          expectedQuantity: line.expectedQuantity,
          countedQuantity: line.countedQuantity,
          variance,
          varianceValuePaise:
            variance === null || avgCostPaise === null ? null : Math.round(variance * avgCostPaise),
          reason: line.reason,
        };
      },
    );
    const counted = lines.filter((line) => line.variance !== null);
    const matching = counted.filter((line) => line.variance === 0).length;
    const values = lines.map((line) => line.varianceValuePaise ?? 0);
    return {
      id: stockCount.id,
      number: stockCount.number,
      status: stockCount.status,
      store: store as CountView['store'],
      scope: stockCount.scope,
      scopeId: stockCount.scopeId,
      note: stockCount.note,
      closingReason: stockCount.closingReason,
      startedAt: stockCount.startedAt.toISOString(),
      submittedAt: iso(stockCount.submittedAt),
      approvedAt: iso(stockCount.approvedAt),
      closedAt: iso(stockCount.closedAt),
      summary: {
        totalLines: lines.length,
        countedLines: counted.length,
        uncountedLines: lines.length - counted.length,
        matchingLines: matching,
        accuracyPercent:
          counted.length === 0 ? null : Math.round((matching / counted.length) * 1000) / 10,
        netVarianceValuePaise: values.reduce((total, value) => total + value, 0),
        absoluteVarianceValuePaise: values.reduce((total, value) => total + Math.abs(value), 0),
      },
      lines,
    };
  }
}
