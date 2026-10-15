import 'reflect-metadata';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { lockParty } from '../payments/posting.js';
import {
  releaseStock,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import {
  OPEN_ORDER_STATUSES,
  canAccessStore,
  formatINR,
  minimumAdvancePaise,
  openQuantity,
  orderStatusFor,
  type AdvanceRequiredRefusal,
  type CreditCheck,
  type OrderAvailabilityView,
  type OrderCreditView,
  type SalesOrderPage,
  type SalesOrderView,
  type StaleReservationPage,
  type TaxDocumentView,
} from '@paint/shared';
import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { idempotent } from '../billing/idempotency.js';
import { documentView, indiaToday, type TaxDocumentRow } from '../billing/invoice-view.js';
import {
  afterKey,
  cappedTotal,
  cursorTime,
  keysetSlice,
  NEWEST_FIRST,
  pageOffset,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import { fieldError } from '../tax/tax-lookups.js';
import { gateSale } from '../credit/credit-gate.js';
import { orderCredit, orderSubject } from './order-credit.js';
import { heldByLine, holdStock } from './order-stock.js';
import {
  loadOrder,
  newestFirst,
  orderLines,
  salesOrderView,
  visibleOrders,
  type SalesOrderLineRow,
  type SalesOrderRow,
  type StoredCreditCheck,
} from './order-views.js';
import { carryTints } from '../paint/tint-lines.js';
import { insertOrder, replaceOrder } from './order-writes.js';
import type {
  BillOrderInput,
  CancelLineInput,
  CancelOrderInput,
  ConfirmOrderInput,
  ListOrdersQuery,
  ReleaseOrderInput,
  ReserveOrderInput,
  SalesOrderInput,
  StaleReservationsQuery,
} from './orders.schemas.js';

const {
  creditApprovals,
  partyBalances,
  parties,
  productVariants,
  salesOrderLines,
  salesOrders,
  salesSettings,
  stockBalances,
  stockReservations,
  stores,
  taxDocumentLines,
  taxDocuments,
} = schema;

/** Thousandths, so quantities (at most 3 decimals) add up exactly. */
const milli = (quantity: number) => Math.round(quantity * 1000);

/**
 * Sales orders (P2-M04, spec §4.1–4.4, §5.3): from a quotation or direct;
 * confirm runs the credit check and reserves stock; bills raise draft invoices
 * that issue through the invoice path; cancel releases what is held.
 */
@Injectable()
export class SalesOrdersService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(
    auth: AuthContext,
    input: SalesOrderInput,
    idempotencyKey?: string,
  ): Promise<SalesOrderView> {
    const request = { method: 'POST', path: '/sales-orders', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () =>
        salesOrderView(tx, await insertOrder(tx, auth, input, await indiaToday(tx), null)),
      ),
    );
  }

  /** Changes a draft: header and lines replaced, priced again. */
  update(auth: AuthContext, id: string, input: SalesOrderInput): Promise<SalesOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      this.assertDraft(await this.writable(tx, auth, id));
      return salesOrderView(tx, await replaceOrder(tx, auth, id, input, await indiaToday(tx)));
    });
  }

  /** Discards a draft (a confirmed order is cancelled instead). */
  remove(auth: AuthContext, id: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const order = await this.writable(tx, auth, id);
      this.assertDraft(order);
      if (order.quotationId !== null) {
        throw new ConflictException(
          'This order came from a quotation: cancel it after confirming instead',
        );
      }
      await tx.delete(salesOrders).where(eq(salesOrders.id, id));
    });
  }

  get(auth: AuthContext, id: string): Promise<SalesOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      salesOrderView(tx, await loadOrder(tx, auth, id)),
    );
  }

  list(auth: AuthContext, query: ListOrdersQuery): Promise<SalesOrderPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        visibleOrders(auth),
        query.storeId ? eq(salesOrders.storeId, query.storeId) : undefined,
        query.partyId ? eq(salesOrders.billToPartyId, query.partyId) : undefined,
        query.projectId ? eq(salesOrders.projectId, query.projectId) : undefined,
        query.status ? eq(salesOrders.status, query.status) : undefined,
        query.q
          ? or(
              ilike(salesOrders.number, containsPattern(query.q)),
              ilike(parties.displayName, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await tx
        .select({
          id: salesOrders.id,
          number: salesOrders.number,
          status: salesOrders.status,
          storeId: salesOrders.storeId,
          paymentTerms: salesOrders.paymentTerms,
          billToPartyId: salesOrders.billToPartyId,
          billToName: parties.displayName,
          projectId: salesOrders.projectId,
          totalPaise: salesOrders.totalPaise,
          invoicedPaise:
            sql<number>`coalesce((select sum(d.total_paise) from ${taxDocuments} d where d.sales_order_id = ${sql.raw('"sales_orders"."id"')} and d.status = 'issued'), 0)`.mapWith(
              Number,
            ),
          createdAt: salesOrders.createdAt,
          cursorAt: cursorTime(salesOrders.createdAt),
        })
        .from(salesOrders)
        .innerJoin(parties, eq(parties.id, salesOrders.billToPartyId))
        .where(
          and(where, afterKey(NEWEST_FIRST, [salesOrders.createdAt, salesOrders.id], query.cursor)),
        )
        .orderBy(...newestFirst(salesOrders))
        .limit(query.limit + 1)
        .offset(pageOffset(query));
      const page = keysetSlice(rows, query.limit, (row) => [row.cursorAt, row.id]);
      return {
        items: page.rows.map(({ cursorAt, ...row }) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
        ...(await cappedTotal(
          tx,
          tx
            .select({ id: salesOrders.id })
            .from(salesOrders)
            .innerJoin(parties, eq(parties.id, salesOrders.billToPartyId))
            .where(where)
            .$dynamic(),
        )),
      };
    });
  }

  /** The confirm dialog's credit figures (spec §5.3), without confirming. */
  creditCheck(auth: AuthContext, id: string): Promise<OrderCreditView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      orderCredit(tx, auth.organization.id, await loadOrder(tx, auth, id)),
    );
  }

  /** Stock per line per store the member can see (spec §5.3). */
  availability(auth: AuthContext, id: string): Promise<OrderAvailabilityView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const order = await loadOrder(tx, auth, id);
      const lines = await orderLines(tx, order.id);
      const held = await heldByLine(
        tx,
        lines.map((line) => line.id),
      );
      const visibleStores = await tx
        .select({ id: stores.id, name: stores.name })
        .from(stores)
        .where(
          and(
            eq(stores.isActive, true),
            auth.allStores ? undefined : inArray(stores.id, [...auth.storeIds]),
          ),
        )
        .orderBy(asc(stores.name));
      const balances = await tx
        .select({
          storeId: stockBalances.storeId,
          variantId: stockBalances.variantId,
          onHand: stockBalances.onHand,
          reserved: stockBalances.reserved,
        })
        .from(stockBalances)
        .where(
          inArray(
            stockBalances.variantId,
            lines.map((line) => line.variantId),
          ),
        );
      const skus = await tx
        .select({ id: productVariants.id, sku: productVariants.sku })
        .from(productVariants)
        .where(
          inArray(
            productVariants.id,
            lines.map((line) => line.variantId),
          ),
        );
      return {
        lines: lines.map((line) => ({
          lineId: line.id,
          variantId: line.variantId,
          sku: String(skus.find((variant) => variant.id === line.variantId)?.sku),
          fulfilStoreId: line.fulfilStoreId,
          quantityOpen: openQuantity(line),
          quantityReserved: held(line.id),
          stores: visibleStores.map((store) => {
            const balance = balances.find(
              (row) => row.storeId === store.id && row.variantId === line.variantId,
            );
            const onHand = balance?.onHand ?? 0;
            const reserved = balance?.reserved ?? 0;
            return {
              storeId: store.id,
              storeName: store.name,
              onHand,
              reserved,
              available: (milli(onHand) - milli(reserved)) / 1000,
            };
          }),
        })),
      };
    });
  }

  /**
   * Confirms a draft (spec §4.4): a postpaid order passes the credit check or
   * carries an override the member may give; a partial order needs its advance
   * on account; then every line is reserved at its fulfil store. All or nothing.
   */
  confirm(
    auth: AuthContext,
    id: string,
    input: ConfirmOrderInput,
    idempotencyKey?: string,
  ): Promise<SalesOrderView> {
    const request = { method: 'POST', path: `/sales-orders/${id}/confirm`, body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        // The party first, then the order: the order every money flow locks in.
        const { billToPartyId } = await this.writable(tx, auth, id, false);
        await lockParty(tx, auth.organization.id, billToPartyId);
        const order = await this.writable(tx, auth, id);
        this.assertDraft(order);
        const changes: PgUpdateSetSource<typeof salesOrders> = {};

        if (order.paymentTerms === 'postpaid') {
          const credit = await orderCredit(tx, auth.organization.id, order);
          // A postpaid order always has its check.
          const [check] = [credit.check] as [CreditCheck];
          const stored: StoredCreditCheck = {
            check,
            exposureSource: credit.exposureSource,
            position: credit.position,
            site: credit.site,
          };
          changes.creditCheck = { ...stored };
          // Past the rules only with an approval (MVP 3 spec §4.3); the 2.0
          // override columns are filled from it, so old and new orders read alike.
          const approvalId = await gateSale(
            tx,
            auth,
            orderSubject(order),
            credit,
            input.creditOverride,
          );
          if (approvalId !== null) {
            const [approval] = (await tx
              .select()
              .from(creditApprovals)
              .where(eq(creditApprovals.id, approvalId))) as [typeof creditApprovals.$inferSelect];
            Object.assign(changes, {
              creditApprovalId: approvalId,
              creditOverrideApproval: approval.level,
              creditOverrideByMemberId: approval.decidedByMemberId,
              creditOverrideReason: approval.decisionReason ?? approval.reason,
              creditOverriddenAt: approval.decidedAt,
            });
          }
        } else if (order.paymentTerms === 'partial') {
          const [settings] = await tx
            .select({ pct: salesSettings.partialMinAdvancePct })
            .from(salesSettings);
          const required = minimumAdvancePaise(order.totalPaise, settings?.pct ?? 0);
          // lockParty above made sure the party has its balance row.
          const [{ advance }] = (await tx
            .select({ advance: partyBalances.advancePaise })
            .from(partyBalances)
            .where(eq(partyBalances.partyId, order.billToPartyId))) as [{ advance: number }];
          if (advance < required) {
            const refusal: AdvanceRequiredRefusal = {
              statusCode: 409,
              code: 'advance_required',
              message: `Take an advance of at least ${formatINR(required)} first (${formatINR(advance)} is on account)`,
              advanceRequiredPaise: required,
              advancePaise: advance,
            };
            throw new ConflictException(refusal);
          }
          changes.advanceRequiredPaise = required;
        }

        const lines = await orderLines(tx, id, true);
        await holdStock(
          tx,
          auth,
          lines.map((line) => ({ line, storeId: line.fulfilStoreId, quantity: line.quantity })),
        );
        const [confirmed] = (await tx
          .update(salesOrders)
          .set({
            ...changes,
            status: 'confirmed',
            confirmedAt: sql`now()`,
            confirmedByMemberId: auth.memberId,
            updatedAt: sql`now()`,
          })
          .where(eq(salesOrders.id, id))
          .returning()) as [SalesOrderRow];
        return salesOrderView(tx, confirmed);
      }),
    );
  }

  /** Cancels what is left of an order and releases everything it holds. */
  cancel(auth: AuthContext, id: string, input: CancelOrderInput): Promise<SalesOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const order = await this.writable(tx, auth, id);
      this.assertOpen(order);
      const lines = await orderLines(tx, id, true);
      await releaseStock(
        tx,
        lines.map((line) => ({ orderLineId: line.id })),
      );
      for (const line of lines) {
        await tx
          .update(salesOrderLines)
          .set({ quantityCancelled: (milli(line.quantity) - milli(line.quantityInvoiced)) / 1000 })
          .where(eq(salesOrderLines.id, line.id));
      }
      const billed = lines.some((line) => line.quantityInvoiced > 0);
      return this.end(tx, auth, order, billed ? 'closed' : 'cancelled', input.reason);
    });
  }

  /** Cancels part or all of what is open on a line, releasing what it no longer needs held. */
  cancelLine(
    auth: AuthContext,
    id: string,
    lineId: string,
    input: CancelLineInput,
  ): Promise<SalesOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const order = await this.writable(tx, auth, id);
      this.assertOpen(order);
      const lines = await orderLines(tx, id, true);
      const line = this.lineOf(lines, lineId, 'lineId');
      const open = milli(openQuantity(line));
      const cancelling = milli(input.quantity ?? openQuantity(line));
      if (cancelling > open) {
        throw fieldError('quantity', `Only ${String(open / 1000)} is open on this line`);
      }
      const held = milli((await heldByLine(tx, [line.id]))(line.id));
      if (held > open - cancelling) {
        await releaseStock(tx, [
          { orderLineId: line.id, quantity: (held - open + cancelling) / 1000 },
        ]);
      }
      const cancelled = (milli(line.quantityCancelled) + cancelling) / 1000;
      await tx
        .update(salesOrderLines)
        .set({ quantityCancelled: cancelled })
        .where(eq(salesOrderLines.id, line.id));
      const status = orderStatusFor(
        lines.map((candidate) =>
          candidate.id === line.id ? { ...candidate, quantityCancelled: cancelled } : candidate,
        ),
      );
      if (status === 'cancelled') return this.end(tx, auth, order, 'cancelled', input.reason);
      return this.move(tx, order, status);
    });
  }

  /**
   * Holds what is open but not held on the lines (all by default), moving a
   * line to another fulfil store first when asked (spec §4.3).
   */
  reserve(auth: AuthContext, id: string, input: ReserveOrderInput): Promise<SalesOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const order = await this.writable(tx, auth, id);
      this.assertOpen(order);
      const lines = await orderLines(tx, id, true);
      const targets =
        input.lines ?? lines.map((line) => ({ lineId: line.id, fulfilStoreId: undefined }));
      const moving: SalesOrderLineRow[] = [];
      for (const [index, target] of targets.entries()) {
        const line = this.lineOf(lines, target.lineId, `lines.${String(index)}.lineId`);
        const storeId = target.fulfilStoreId ?? line.fulfilStoreId;
        if (storeId !== line.fulfilStoreId) {
          const [store] = await tx
            .select({ id: stores.id })
            .from(stores)
            .where(and(eq(stores.id, storeId), eq(stores.isActive, true)));
          if (!store) throw fieldError(`lines.${String(index)}.fulfilStoreId`, 'Unknown store');
          await tx
            .update(salesOrderLines)
            .set({ fulfilStoreId: storeId })
            .where(eq(salesOrderLines.id, line.id));
        }
        moving.push({ ...line, fulfilStoreId: storeId });
      }
      await holdStock(
        tx,
        auth,
        moving.map((line) => ({ line, storeId: line.fulfilStoreId, quantity: openQuantity(line) })),
      );
      return salesOrderView(tx, order);
    });
  }

  /** Gives back what the lines hold (all by default) without cancelling them (stale reservations). */
  release(auth: AuthContext, id: string, input: ReleaseOrderInput): Promise<SalesOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const order = await this.writable(tx, auth, id);
      this.assertOpen(order);
      const lines = await orderLines(tx, id, true);
      const lineIds =
        input.lineIds?.map(
          (lineId, index) => this.lineOf(lines, lineId, `lineIds.${String(index)}`).id,
        ) ?? lines.map((line) => line.id);
      await releaseStock(
        tx,
        lineIds.map((orderLineId) => ({ orderLineId })),
      );
      return salesOrderView(tx, order);
    });
  }

  /**
   * A draft invoice for open quantities at one fulfil store (spec §5.3: "Bill
   * pre-fills a draft invoice with uninvoiced quantities; partial billing
   * allowed"). It issues through POST /invoices/:id/issue, which bills the order.
   */
  bill(
    auth: AuthContext,
    id: string,
    input: BillOrderInput,
    idempotencyKey?: string,
  ): Promise<TaxDocumentView> {
    const request = { method: 'POST', path: `/sales-orders/${id}/invoices`, body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        const order = await loadOrder(tx, auth, id, true);
        this.assertOpen(order);
        const lines = await orderLines(tx, id, true);
        const asked = input.lines?.map((item, index) => ({
          line: this.lineOf(lines, item.orderLineId, `lines.${String(index)}.orderLineId`),
          quantity: item.quantity,
          path: `lines.${String(index)}.quantity`,
        }));
        const storeId = input.storeId ?? asked?.[0]?.line.fulfilStoreId ?? order.storeId;
        if (!canAccessStore(auth, storeId)) {
          throw new ForbiddenException('You can bill only at a store you work at');
        }
        const billing =
          asked ??
          lines
            .filter((line) => line.fulfilStoreId === storeId && openQuantity(line) > 0)
            .map((line) => ({ line, quantity: openQuantity(line), path: 'lines' }));
        if (billing.length === 0) {
          throw new ConflictException('Nothing is left to bill from this store');
        }
        for (const item of billing) {
          if (item.line.fulfilStoreId !== storeId) {
            throw fieldError(item.path, 'This line is fulfilled from another store');
          }
          if (milli(item.quantity) > milli(openQuantity(item.line))) {
            throw fieldError(item.path, `Only ${String(openQuantity(item.line))} is left to bill`);
          }
        }
        const [store] = (await tx
          .select({ registrationType: stores.registrationType })
          .from(stores)
          .where(eq(stores.id, storeId))) as [{ registrationType: string }];
        // An amount off the whole order is shared by value among its bills.
        const share = (paise: number | null) => {
          if (paise === null) return null;
          const billed = billing.reduce(
            (sum, item) => sum + (item.line.taxablePaise * item.quantity) / item.line.quantity,
            0,
          );
          return Math.round((paise * billed) / Math.max(1, order.taxablePaise));
        };
        const [draft] = (await tx
          .insert(taxDocuments)
          .values({
            organizationId: auth.organization.id,
            kind: store.registrationType === 'composition' ? 'bill_of_supply' : 'invoice',
            storeId,
            partyId: order.billToPartyId,
            shipToName: order.shipToName,
            shipToAddress: order.shipToAddress,
            shipToStateCode: order.shipToStateCode,
            priceMode: order.priceMode,
            billDiscountBps: order.billDiscountBps,
            billDiscountPaise: share(order.billDiscountPaise),
            influencerPartyId: order.influencerPartyId,
            projectId: order.projectId,
            salesOrderId: order.id,
            note: input.note ?? null,
            createdByMemberId: auth.memberId,
          })
          .returning()) as [TaxDocumentRow];
        const billed = await tx
          .insert(taxDocumentLines)
          .values(
            billing.map((item, index) => ({
              organizationId: auth.organization.id,
              documentId: draft.id,
              lineNo: index + 1,
              variantId: item.line.variantId,
              quantity: item.quantity,
              unitPricePaise: item.line.unitPricePaise,
              discountBps: item.line.discountBps,
              discountPaise:
                item.line.discountPaise === null
                  ? null
                  : Math.round((item.line.discountPaise * item.quantity) / item.line.quantity),
              orderLineId: item.line.id,
            })),
          )
          .returning({
            id: taxDocumentLines.id,
            orderLineId: taxDocumentLines.orderLineId,
            quantity: taxDocumentLines.quantity,
          });
        await carryTints(
          tx,
          auth.memberId,
          'sales_order_line',
          'invoice_line',
          { partyId: order.billToPartyId, projectId: order.projectId },
          billed.map((line) => ({
            fromLineId: String(line.orderLineId),
            toLineId: line.id,
            quantity: line.quantity,
            storeId,
          })),
        );
        return documentView(tx, draft);
      }),
    );
  }

  /** Open reservations older than `olderThanDays`, oldest first (spec §4.3). */
  staleReservations(
    auth: AuthContext,
    query: StaleReservationsQuery,
  ): Promise<StaleReservationPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        eq(stockReservations.status, 'open'),
        auth.allStores ? undefined : inArray(stockReservations.storeId, [...auth.storeIds]),
        query.storeId ? eq(stockReservations.storeId, query.storeId) : undefined,
        sql`${stockReservations.createdAt} <= now() - make_interval(days => ${query.olderThanDays})`,
      );
      const rows = await tx
        .select({
          id: stockReservations.id,
          orderId: salesOrders.id,
          orderNumber: salesOrders.number,
          orderLineId: stockReservations.orderLineId,
          storeId: stockReservations.storeId,
          variantId: stockReservations.variantId,
          sku: productVariants.sku,
          quantity: stockReservations.quantity,
          reservedAt: stockReservations.createdAt,
          ageDays: sql<number>`extract(day from now() - ${stockReservations.createdAt})::int`,
        })
        .from(stockReservations)
        .innerJoin(salesOrderLines, eq(salesOrderLines.id, stockReservations.orderLineId))
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.orderId))
        .innerJoin(productVariants, eq(productVariants.id, stockReservations.variantId))
        .where(where)
        .orderBy(asc(stockReservations.createdAt), asc(stockReservations.id))
        .limit(query.limit)
        .offset(query.offset);
      const [total] = await tx.select({ value: count() }).from(stockReservations).where(where);
      return {
        items: rows.map((row) => ({ ...row, reservedAt: row.reservedAt.toISOString() })),
        total: Number(total?.value),
      };
    });
  }

  // Helpers -----------------------------------------------------------------

  /** The order, locked, at a store the member works at (an order is changed only at its store). */
  private async writable(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    lock = true,
  ): Promise<SalesOrderRow> {
    const order = await loadOrder(tx, auth, id, lock);
    if (!canAccessStore(auth, order.storeId)) {
      throw new ForbiddenException('Only the store that took this order can change it');
    }
    return order;
  }

  private assertDraft(order: SalesOrderRow): void {
    if (order.status !== 'draft') {
      throw new ConflictException(`This order is ${order.status}, not a draft`);
    }
  }

  private assertOpen(order: SalesOrderRow): void {
    if (!OPEN_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictException(
        order.status === 'draft'
          ? 'Confirm this order first (or discard the draft)'
          : `This order is ${order.status}`,
      );
    }
  }

  private lineOf(lines: readonly SalesOrderLineRow[], lineId: string, path: string) {
    const line = lines.find((candidate) => candidate.id === lineId);
    if (!line) throw fieldError(path, 'Not a line of this order');
    return line;
  }

  private async move(
    tx: Transaction,
    order: SalesOrderRow,
    status: SalesOrderRow['status'],
  ): Promise<SalesOrderView> {
    const [moved] = (await tx
      .update(salesOrders)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(salesOrders.id, order.id))
      .returning()) as [SalesOrderRow];
    return salesOrderView(tx, moved);
  }

  private async end(
    tx: Transaction,
    auth: AuthContext,
    order: SalesOrderRow,
    status: 'cancelled' | 'closed',
    reason: string,
  ): Promise<SalesOrderView> {
    const [ended] = (await tx
      .update(salesOrders)
      .set({
        status,
        cancelReason: reason,
        cancelledAt: sql`now()`,
        cancelledByMemberId: auth.memberId,
        updatedAt: sql`now()`,
      })
      .where(eq(salesOrders.id, order.id))
      .returning()) as [SalesOrderRow];
    return salesOrderView(tx, ended);
  }
}
