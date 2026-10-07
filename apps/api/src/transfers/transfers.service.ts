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
  nextDocumentNumber,
  postStockMovements,
  schema,
  withTenant,
  type DatabaseConnection,
  type StockMovement,
  type Transaction,
} from '@paint/db';
import { canAccessStore, formatDocumentNumber, variantTitle } from '@paint/shared';
import { and, count, desc, eq, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { Notifier } from '../notifications/notifier.js';
import type {
  CreateTransferInput,
  ListTransfersQuery,
  QuantitiesInput,
  ReceiveInput,
  TRANSFER_STATUSES,
} from './transfers.schemas.js';

const { brands, productVariants, products, stockBalances, stores, transferLines, transfers } =
  schema;

type TransferStatus = (typeof TRANSFER_STATUSES)[number];
type TransferRow = typeof transfers.$inferSelect;
type StoreRow = typeof stores.$inferSelect;
type TransferChanges = PgUpdateSetSource<typeof transfers>;

/** A transfer with both of its stores. */
interface LoadedTransfer {
  readonly transfer: TransferRow;
  readonly from: StoreRow;
  readonly to: StoreRow;
}

/** A line and the quantity chosen for it in a workflow step. */
interface LineQuantity {
  readonly line: TransferLineView;
  readonly quantity: number;
}

const fromStores = alias(stores, 'from_store');
const toStores = alias(stores, 'to_store');

export interface TransferLineView {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  readonly label: string | null;
  readonly hsnCode: string;
  readonly requestedQuantity: number;
  readonly approvedQuantity: number | null;
  readonly dispatchedQuantity: number | null;
  readonly receivedQuantity: number | null;
  readonly damagedQuantity: number | null;
  /** Dispatched but never arrived; known once received. */
  readonly shortQuantity: number | null;
  readonly unitCostPaise: number | null;
  /** Available now at the sending store, to help the approver. */
  readonly availableAtSource: number;
}

export interface StoreSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface TransferView {
  readonly id: string;
  readonly number: string;
  readonly status: TransferStatus;
  readonly from: StoreSummary;
  readonly to: StoreSummary;
  readonly note: string | null;
  readonly closingReason: string | null;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly dispatchedAt: string | null;
  readonly receivedAt: string | null;
  readonly closedAt: string | null;
  readonly lines: TransferLineView[];
}

export interface TransferSummary {
  readonly id: string;
  readonly number: string;
  readonly status: TransferStatus;
  readonly from: StoreSummary;
  readonly to: StoreSummary;
  readonly requestedAt: string;
  readonly lineCount: number;
}

export interface TransferPage {
  readonly items: TransferSummary[];
  readonly total: number;
}

export interface ChallanParty {
  readonly name: string;
  readonly code: string;
  readonly city: string | null;
  readonly state: string | null;
  readonly gstin: string | null;
}

/** Data for the delivery challan that travels with the goods. */
export interface Challan {
  readonly number: string;
  readonly dispatchedAt: string;
  readonly from: ChallanParty;
  readonly to: ChallanParty;
  /**
   * Stock moving between different GSTINs is a taxable supply: it needs a tax
   * invoice and, above the threshold, an e-way bill (Release 2.3).
   */
  readonly requiresTaxInvoice: boolean;
  readonly lines: {
    readonly sku: string;
    readonly description: string;
    readonly hsnCode: string;
    readonly quantity: number;
    readonly unitValuePaise: number | null;
    readonly valuePaise: number | null;
  }[];
  readonly totalValuePaise: number;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);
const summary = (store: StoreRow): StoreSummary => ({
  id: store.id,
  code: store.code,
  name: store.name,
});
const party = (store: StoreRow): ChallanParty => ({
  name: store.name,
  code: store.code,
  city: store.city,
  state: store.state,
  gstin: store.gstin,
});
const EVERY_LINE = 'List every product on the transfer, exactly once';

@Injectable()
export class TransfersService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  /** The receiving store asks another store for stock. */
  create(auth: AuthContext, input: CreateTransferInput): Promise<TransferView> {
    const organizationId = auth.organization.id;
    return withTenant(this.connection.db, organizationId, async (tx) => {
      const found = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(
          and(inArray(stores.id, [input.fromStoreId, input.toStoreId]), eq(stores.isActive, true)),
        );
      if (found.length !== 2) throw new BadRequestException('Unknown store');
      if (!canAccessStore(auth, input.toStoreId)) {
        throw new ForbiddenException('You can request stock only for a store you work at');
      }
      const variantIds = input.lines.map((line) => line.variantId);
      const variants = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(inArray(productVariants.id, variantIds));
      if (variants.length !== variantIds.length)
        throw new BadRequestException('Unknown product variant');

      const id = crypto.randomUUID();
      const number = formatDocumentNumber(
        'TR',
        await nextDocumentNumber(tx, organizationId, 'transfer'),
      );
      await tx.insert(transfers).values({
        id,
        organizationId,
        number,
        fromStoreId: input.fromStoreId,
        toStoreId: input.toStoreId,
        note: input.note,
        requestedByMemberId: auth.memberId,
      });
      await tx.insert(transferLines).values(
        input.lines.map((line) => ({
          organizationId,
          transferId: id,
          variantId: line.variantId,
          requestedQuantity: line.quantity,
        })),
      );
      const view = await this.view(tx, auth, id);
      await this.notifier.notify(tx, {
        organizationId,
        event: 'transfer_awaiting_approval',
        to: { storeId: input.fromStoreId, permission: 'inventory:manage' },
        actorMemberId: auth.memberId,
        title: `Transfer ${number} needs your approval`,
        body: `${view.to.name} has asked ${view.from.name} for ${String(view.lines.length)} product(s).`,
        link: `/transfers/${id}`,
      });
      return view;
    });
  }

  list(auth: AuthContext, query: ListTransfersQuery): Promise<TransferPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (query.storeId && !canAccessStore(auth, query.storeId)) {
        throw new NotFoundException('Store not found');
      }
      const mine = (column: AnyColumn) =>
        query.storeId
          ? eq(column, query.storeId)
          : auth.allStores
            ? undefined
            : inArray(column, [...auth.storeIds]);
      const where = and(
        query.direction === 'incoming'
          ? mine(transfers.toStoreId)
          : query.direction === 'outgoing'
            ? mine(transfers.fromStoreId)
            : this.visibleTo(auth, query.storeId),
        query.status ? eq(transfers.status, query.status) : undefined,
      );
      const rows = await tx
        .select({
          transfer: transfers,
          from: fromStores,
          to: toStores,
          lineCount: sql<number>`(select count(*)::int from ${transferLines} where ${transferLines.transferId} = ${transfers.id})`,
        })
        .from(transfers)
        .innerJoin(fromStores, eq(fromStores.id, transfers.fromStoreId))
        .innerJoin(toStores, eq(toStores.id, transfers.toStoreId))
        .where(where)
        .orderBy(desc(transfers.requestedAt), desc(transfers.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(transfers).where(where);
      return {
        items: rows.map(({ transfer, from, to, lineCount }) => ({
          id: transfer.id,
          number: transfer.number,
          status: transfer.status,
          from: summary(from),
          to: summary(to),
          requestedAt: transfer.requestedAt.toISOString(),
          lineCount,
        })),
        total: Number(totals?.total),
      };
    });
  }

  get(auth: AuthContext, transferId: string): Promise<TransferView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, transferId),
    );
  }

  /** The sending store agrees, possibly to smaller quantities. */
  approve(auth: AuthContext, transferId: string, input: QuantitiesInput): Promise<TransferView> {
    return this.act(
      auth,
      transferId,
      'from',
      ['requested'],
      'approved',
      async (tx, transfer, lines) => {
        const quantities = this.quantities(lines, input, (line) => line.requestedQuantity);
        for (const { line, quantity } of quantities) {
          if (quantity > line.requestedQuantity) {
            throw new BadRequestException(`Cannot approve more ${line.sku} than was requested`);
          }
        }
        if (quantities.every(({ quantity }) => quantity === 0)) {
          throw new BadRequestException('Approve at least one product, or reject the transfer');
        }
        await this.setLines(tx, transfer.id, quantities, 'approvedQuantity');
        return { approvedByMemberId: auth.memberId, approvedAt: sql`now()` };
      },
    );
  }

  reject(auth: AuthContext, transferId: string, reason: string): Promise<TransferView> {
    return this.act(auth, transferId, 'from', ['requested'], 'rejected', () =>
      Promise.resolve(this.closing(auth, reason)),
    );
  }

  /** The requesting store withdraws the request before anything is dispatched. */
  cancel(auth: AuthContext, transferId: string, reason: string): Promise<TransferView> {
    return this.act(auth, transferId, 'to', ['requested', 'approved'], 'cancelled', () =>
      Promise.resolve(this.closing(auth, reason)),
    );
  }

  /** Stock leaves the sending store. */
  dispatch(auth: AuthContext, transferId: string, input: QuantitiesInput): Promise<TransferView> {
    return this.act(
      auth,
      transferId,
      'from',
      ['approved'],
      'in_transit',
      async (tx, transfer, lines) => {
        const quantities = this.quantities(lines, input, (line) => Number(line.approvedQuantity));
        for (const { line, quantity } of quantities) {
          if (quantity > Number(line.approvedQuantity)) {
            throw new BadRequestException(`Cannot dispatch more ${line.sku} than was approved`);
          }
        }
        const sending = quantities.filter(({ quantity }) => quantity > 0);
        if (sending.length === 0) {
          throw new BadRequestException('Dispatch at least one product, or cancel the transfer');
        }
        // Record the sending store's cost so the receiving store values the stock the same.
        await tx
          .update(transferLines)
          .set({
            unitCostPaise: sql`(
            select ${stockBalances.avgCostPaise} from ${stockBalances}
            where ${stockBalances.storeId} = ${transfer.fromStoreId}
              and ${stockBalances.variantId} = ${transferLines.variantId}
          )`,
          })
          .where(eq(transferLines.transferId, transfer.id));
        await this.setLines(tx, transfer.id, quantities, 'dispatchedQuantity');
        await this.post(
          tx,
          auth,
          transfer,
          lines,
          sending.map(({ line, quantity }) => ({
            storeId: transfer.fromStoreId,
            variantId: line.variantId,
            movementType: 'transfer_out' as const,
            quantity: -quantity,
          })),
        );
        const { from, to } = await this.load(tx, auth, transfer.id);
        await this.notifier.notify(tx, {
          organizationId: auth.organization.id,
          event: 'transfer_awaiting_receipt',
          to: { storeId: transfer.toStoreId, permission: 'inventory:manage' },
          actorMemberId: auth.memberId,
          title: `Transfer ${transfer.number} is on its way`,
          body: `${from.name} has dispatched ${String(sending.length)} product(s) to ${to.name}. Record what arrives.`,
          link: `/transfers/${transfer.id}`,
        });
        return { dispatchedByMemberId: auth.memberId, dispatchedAt: sql`now()` };
      },
    );
  }

  /** Stock arrives at the receiving store; damaged units are written off, shortages recorded. */
  receive(auth: AuthContext, transferId: string, input: ReceiveInput): Promise<TransferView> {
    return this.act(
      auth,
      transferId,
      'to',
      ['in_transit'],
      'received',
      async (tx, transfer, lines) => {
        if (input.lines && input.lines.length !== lines.length) {
          throw new BadRequestException(EVERY_LINE);
        }
        const arrivals: Omit<StockMovement, 'organizationId'>[] = [];
        const writeOffs: Omit<StockMovement, 'organizationId'>[] = [];
        for (const line of lines) {
          const dispatched = Number(line.dispatchedQuantity);
          const entry = input.lines
            ? input.lines.find((candidate) => candidate.variantId === line.variantId)
            : { received: dispatched, damaged: 0 };
          if (!entry) throw new BadRequestException(EVERY_LINE);
          if (entry.received + entry.damaged > dispatched) {
            throw new BadRequestException(`More ${line.sku} received than was dispatched`);
          }
          await tx
            .update(transferLines)
            .set({ receivedQuantity: entry.received, damagedQuantity: entry.damaged })
            .where(
              and(
                eq(transferLines.transferId, transfer.id),
                eq(transferLines.variantId, line.variantId),
              ),
            );
          const arrived = entry.received + entry.damaged;
          if (arrived > 0) {
            arrivals.push({
              storeId: transfer.toStoreId,
              variantId: line.variantId,
              movementType: 'transfer_in',
              quantity: arrived,
              unitCostPaise: line.unitCostPaise,
            });
          }
          if (entry.damaged > 0) {
            writeOffs.push({
              storeId: transfer.toStoreId,
              variantId: line.variantId,
              movementType: 'damage',
              quantity: -entry.damaged,
              note: `Damaged in transit (${transfer.number})`,
            });
          }
        }
        // Arrivals first, then write-offs, so damaged units are in stock before leaving it.
        await this.post(tx, auth, transfer, lines, arrivals);
        await this.post(tx, auth, transfer, lines, writeOffs);
        return {
          receivedByMemberId: auth.memberId,
          receivedAt: sql`now()`,
          ...(input.note ? { note: input.note } : {}),
        };
      },
    );
  }

  /** Delivery challan data, available once the transfer is dispatched. */
  challan(auth: AuthContext, transferId: string): Promise<Challan> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const loaded = await this.load(tx, auth, transferId);
      const view = await this.view(tx, auth, transferId);
      if (!loaded.transfer.dispatchedAt) {
        throw new ConflictException('The challan is available once the transfer is dispatched');
      }
      const from = party(loaded.from);
      const to = party(loaded.to);
      const lines = view.lines
        .filter((line) => Number(line.dispatchedQuantity) > 0)
        .map((line) => {
          const quantity = Number(line.dispatchedQuantity);
          return {
            sku: line.sku,
            description: variantTitle(line.brandName, line.productName, line),
            hsnCode: line.hsnCode,
            quantity,
            unitValuePaise: line.unitCostPaise,
            valuePaise:
              line.unitCostPaise === null ? null : Math.round(quantity * line.unitCostPaise),
          };
        });
      return {
        number: view.number,
        dispatchedAt: loaded.transfer.dispatchedAt.toISOString(),
        from,
        to,
        requiresTaxInvoice: from.gstin !== to.gstin,
        lines,
        totalValuePaise: lines.reduce((total, line) => total + (line.valuePaise ?? 0), 0),
      };
    });
  }

  // Helpers -----------------------------------------------------------------

  private closing(auth: AuthContext, reason: string): TransferChanges {
    return { closingReason: reason, closedByMemberId: auth.memberId, closedAt: sql`now()` };
  }

  /**
   * Runs one workflow step: checks the member works at the right end of the
   * transfer, moves the status only from an expected one (so a double click or
   * a race cannot apply it twice), then does the step's work.
   */
  private act(
    auth: AuthContext,
    transferId: string,
    side: 'from' | 'to',
    allowed: TransferStatus[],
    next: TransferStatus,
    work: (
      tx: Transaction,
      transfer: TransferRow,
      lines: TransferLineView[],
    ) => Promise<TransferChanges>,
  ): Promise<TransferView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const { transfer } = await this.load(tx, auth, transferId);
      const storeId = side === 'from' ? transfer.fromStoreId : transfer.toStoreId;
      if (!canAccessStore(auth, storeId)) {
        throw new ForbiddenException(
          side === 'from'
            ? 'Only the sending store can do this'
            : 'Only the receiving store can do this',
        );
      }
      if (!allowed.includes(transfer.status)) {
        throw new ConflictException(`This transfer is ${transfer.status.replace('_', ' ')}`);
      }
      const moved = await tx
        .update(transfers)
        .set({ status: next, updatedAt: sql`now()` })
        .where(and(eq(transfers.id, transferId), inArray(transfers.status, allowed)))
        .returning({ id: transfers.id });
      if (moved.length === 0) {
        throw new ConflictException('Someone else just changed this transfer; reload it');
      }
      const { lines } = await this.view(tx, auth, transferId);
      const changes = await work(tx, transfer, lines);
      await tx.update(transfers).set(changes).where(eq(transfers.id, transferId));
      return this.view(tx, auth, transferId);
    });
  }

  /** Each line's quantity: from the request (which must list every line once) or the default. */
  private quantities(
    lines: TransferLineView[],
    input: QuantitiesInput,
    fallback: (line: TransferLineView) => number,
  ): LineQuantity[] {
    if (!input.lines) return lines.map((line) => ({ line, quantity: fallback(line) }));
    if (input.lines.length !== lines.length) throw new BadRequestException(EVERY_LINE);
    return input.lines.map(({ variantId, quantity }) => {
      const line = lines.find((candidate) => candidate.variantId === variantId);
      if (!line) throw new BadRequestException(EVERY_LINE);
      return { line, quantity };
    });
  }

  private async setLines(
    tx: Transaction,
    transferId: string,
    quantities: LineQuantity[],
    column: 'approvedQuantity' | 'dispatchedQuantity',
  ): Promise<void> {
    for (const { line, quantity } of quantities) {
      await tx
        .update(transferLines)
        .set({ [column]: quantity })
        .where(
          and(
            eq(transferLines.transferId, transferId),
            eq(transferLines.variantId, line.variantId),
          ),
        );
    }
  }

  /** Posts the movements, naming the product when the sending store is short. */
  private async post(
    tx: Transaction,
    auth: AuthContext,
    transfer: TransferRow,
    lines: TransferLineView[],
    movements: Omit<StockMovement, 'organizationId'>[],
  ): Promise<void> {
    try {
      await postStockMovements(
        tx,
        movements.map((movement) => ({
          ...movement,
          organizationId: auth.organization.id,
          referenceType: 'transfer',
          referenceId: transfer.id,
          note: movement.note ?? transfer.number,
          createdByMemberId: auth.memberId,
        })),
      );
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        const sku = lines.find((line) => line.variantId === error.variantId)?.sku;
        throw new ConflictException(`Not enough stock of ${String(sku)} at the sending store`);
      }
      throw error;
    }
  }

  private visibleTo(auth: AuthContext, storeId?: string): SQL | undefined {
    if (storeId) return or(eq(transfers.fromStoreId, storeId), eq(transfers.toStoreId, storeId));
    if (auth.allStores) return undefined;
    const ids = [...auth.storeIds];
    return or(inArray(transfers.fromStoreId, ids), inArray(transfers.toStoreId, ids));
  }

  /** The transfer with both stores; 404 unless the member works at one of them. */
  private async load(
    tx: Transaction,
    auth: AuthContext,
    transferId: string,
  ): Promise<LoadedTransfer> {
    const [row] = await tx
      .select({ transfer: transfers, from: fromStores, to: toStores })
      .from(transfers)
      .innerJoin(fromStores, eq(fromStores.id, transfers.fromStoreId))
      .innerJoin(toStores, eq(toStores.id, transfers.toStoreId))
      .where(eq(transfers.id, transferId));
    if (!row || (!canAccessStore(auth, row.from.id) && !canAccessStore(auth, row.to.id))) {
      throw new NotFoundException('Transfer not found');
    }
    return row;
  }

  private async view(
    tx: Transaction,
    auth: AuthContext,
    transferId: string,
  ): Promise<TransferView> {
    const { transfer, from, to } = await this.load(tx, auth, transferId);
    const lineRows = await tx
      .select({
        line: transferLines,
        sku: productVariants.sku,
        packSize: productVariants.packSize,
        unit: productVariants.unit,
        label: productVariants.label,
        productName: products.name,
        hsnCode: products.hsnCode,
        brandName: brands.name,
        available: sql<string>`coalesce((
          select ${stockBalances.onHand} - ${stockBalances.reserved} from ${stockBalances}
          where ${stockBalances.storeId} = ${transfer.fromStoreId}
            and ${stockBalances.variantId} = ${transferLines.variantId}
        ), 0)`,
      })
      .from(transferLines)
      .innerJoin(productVariants, eq(productVariants.id, transferLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(eq(transferLines.transferId, transferId))
      .orderBy(productVariants.sku);
    return {
      id: transfer.id,
      number: transfer.number,
      status: transfer.status,
      from: summary(from),
      to: summary(to),
      note: transfer.note,
      closingReason: transfer.closingReason,
      requestedAt: transfer.requestedAt.toISOString(),
      approvedAt: iso(transfer.approvedAt),
      dispatchedAt: iso(transfer.dispatchedAt),
      receivedAt: iso(transfer.receivedAt),
      closedAt: iso(transfer.closedAt),
      lines: lineRows.map(({ line, available, ...product }) => ({
        variantId: line.variantId,
        sku: product.sku,
        productName: product.productName,
        brandName: product.brandName,
        packSize: product.packSize,
        unit: product.unit,
        label: product.label,
        hsnCode: product.hsnCode,
        requestedQuantity: line.requestedQuantity,
        approvedQuantity: line.approvedQuantity,
        dispatchedQuantity: line.dispatchedQuantity,
        receivedQuantity: line.receivedQuantity,
        damagedQuantity: line.damagedQuantity,
        shortQuantity:
          line.receivedQuantity === null
            ? null
            : Math.round(
                (Number(line.dispatchedQuantity) -
                  line.receivedQuantity -
                  Number(line.damagedQuantity)) *
                  1000,
              ) / 1000,
        unitCostPaise: line.unitCostPaise,
        availableAtSource: Number(available),
      })),
    };
  }
}
