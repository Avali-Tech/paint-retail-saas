import 'reflect-metadata';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  TINT_PERMISSION,
  can,
  canAccessStore,
  normalizePhone,
  variantName,
  type TintDocumentKind,
  type TintDocumentRef,
  type TintFormulaComponent,
  type TintLineKind,
  type TintRecordPage,
  type TintRecordView,
} from '@paint/shared';
import { and, desc, eq, ilike, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { idempotent } from '../billing/idempotency.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import type { ListTintRecordsQuery, TintRecordInput } from './paint.schemas.js';
import { writeLineTints } from './line-tints.js';
import { loadTintLine, tintLineColumn, type TintLine } from './tint-lines.js';

const {
  brands,
  parties,
  productVariants,
  products,
  projects,
  quotationLines,
  quotations,
  salesOrderLines,
  salesOrders,
  stores,
  taxDocumentLines,
  taxDocuments,
  tintRecords,
} = schema;

const DOCUMENT_COLUMN: Readonly<Record<TintDocumentKind, SQL>> = {
  quotation: sql`${quotations.id}`,
  sales_order: sql`${salesOrders.id}`,
  invoice: sql`${taxDocuments.id}`,
};

/**
 * Tint records (P2-M30, spec §6.3): the shade a line's base was tinted to,
 * and the shade history searched across every store of the business ("same
 * shade as last time").
 */
@Injectable()
export class TintRecordsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(
    auth: AuthContext,
    input: TintRecordInput,
    idempotencyKey?: string,
  ): Promise<TintRecordView> {
    const request = { method: 'POST', path: '/tint-records', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        const line = await this.writableLine(tx, auth, input.lineKind, input.lineId);
        const [existing] = await tx
          .select({ id: tintRecords.id })
          .from(tintRecords)
          .where(eq(tintLineColumn(input.lineKind), input.lineId));
        if (existing) {
          throw new ConflictException('This line is already tinted: remove its tint first');
        }
        const { lineKind, lineId, ...tint } = input;
        const [id] = (await writeLineTints(tx, auth, lineKind, line, [
          {
            lineId,
            variantId: line.variantId,
            quantity: line.quantity,
            storeId: line.storeId,
            tint,
            path: '',
            basePath: 'lineId',
          },
        ])) as [string];
        return this.view(tx, id);
      }),
    );
  }

  /** Untints a line of a draft (to tint it again). */
  remove(auth: AuthContext, id: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const record = await this.view(tx, id);
      await this.writableLine(tx, auth, record.lineKind, record.lineId);
      await tx.delete(tintRecords).where(eq(tintRecords.id, id));
    });
  }

  get(auth: AuthContext, id: string): Promise<TintRecordView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.view(tx, id));
  }

  /** The shade history of the whole business, newest first (see TintRecordQuery). */
  list(auth: AuthContext, query: ListTintRecordsQuery): Promise<TintRecordPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const phone = query.q === undefined ? null : normalizePhone(query.q);
      const pattern = query.q === undefined ? null : containsPattern(query.q);
      const where = and(
        query.partyId === undefined
          ? undefined
          : sql`${tintRecords.partyId} in (
              with recursive merged (id) as (
                select ${query.partyId}::uuid
                union select p.id from ${parties} p join merged m on p.merged_into_id = m.id
              ) select id from merged)`,
        query.projectId === undefined ? undefined : eq(tintRecords.projectId, query.projectId),
        query.storeId === undefined ? undefined : eq(tintRecords.storeId, query.storeId),
        query.shadeCode === undefined ? undefined : eq(tintRecords.shadeCode, query.shadeCode),
        query.billed === true
          ? and(isNotNull(tintRecords.invoiceLineId), eq(taxDocuments.status, 'issued'))
          : undefined,
        query.documentKind === undefined
          ? undefined
          : sql`${DOCUMENT_COLUMN[query.documentKind]} = ${query.documentId}`,
        pattern === null
          ? undefined
          : or(
              ilike(tintRecords.shadeCode, pattern),
              ilike(tintRecords.shadeName, pattern),
              ilike(parties.displayName, pattern),
              phone === null ? undefined : eq(parties.phone, phone),
            ),
      );
      const rows = await joined(tx)
        .where(where)
        .orderBy(desc(tintRecords.createdAt), desc(tintRecords.id))
        .limit(query.limit)
        .offset(query.offset);
      // Past the last page there is no row to read the count from: count once more.
      const total =
        rows[0]?.total ??
        (query.offset === 0 ? 0 : (await joined(tx).where(where).limit(1)).at(0)?.total);
      return { items: rows.map(toView), total: Number(total ?? 0) };
    });
  }

  // Helpers -----------------------------------------------------------------

  /**
   * The line, when the member may write it: TINT_PERMISSION for its kind, at
   * one of its stores ("not found" otherwise), and its document a draft.
   */
  private async writableLine(
    tx: Transaction,
    auth: AuthContext,
    kind: TintLineKind,
    lineId: string,
  ): Promise<TintLine> {
    if (!can(auth, TINT_PERMISSION[kind])) {
      throw new ForbiddenException('You do not have permission to do this');
    }
    const line = await loadTintLine(tx, kind, lineId);
    if (!line.storeIds.some((storeId) => canAccessStore(auth, storeId))) {
      throw new NotFoundException('Line not found');
    }
    if (line.documentStatus !== 'draft') {
      throw new ConflictException(
        `This ${line.documentName} is ${line.documentStatus}: only a draft's lines are tinted or untinted`,
      );
    }
    return line;
  }

  private async view(tx: Transaction, id: string): Promise<TintRecordView> {
    const [row] = await joined(tx).where(eq(tintRecords.id, id));
    if (!row) throw new NotFoundException('Tint record not found');
    return toView(row);
  }
}

/** Tint records joined to everything a view or a filter needs. */
function joined(tx: Transaction) {
  return tx
    .select({
      record: tintRecords,
      storeName: stores.name,
      partyName: parties.displayName,
      partyPhone: parties.phone,
      projectName: projects.name,
      brandName: brands.name,
      productId: productVariants.productId,
      sku: productVariants.sku,
      packSize: productVariants.packSize,
      unit: productVariants.unit,
      label: productVariants.label,
      variantActive: productVariants.isActive,
      productName: products.name,
      documentId: sql<string>`coalesce(${quotations.id}, ${salesOrders.id}, ${taxDocuments.id})`,
      documentNumber: sql<
        string | null
      >`coalesce(${quotations.number}, ${salesOrders.number}, ${taxDocuments.number})`,
      documentStatus: sql<TintDocumentRef['status']>`coalesce(${quotations.status}::text,
        ${salesOrders.status}::text, ${taxDocuments.status}::text)`,
      documentDate: sql<string>`coalesce(${taxDocuments.issuedOn},
        (coalesce(${quotations.createdAt}, ${salesOrders.createdAt}, ${taxDocuments.createdAt})
          at time zone 'Asia/Kolkata')::date)::text`,
      // Every match, whatever the page (so a page past the end still says how many there are).
      total: sql<string>`count(*) over ()`,
    })
    .from(tintRecords)
    .innerJoin(stores, eq(stores.id, tintRecords.storeId))
    .innerJoin(brands, eq(brands.id, tintRecords.brandId))
    .innerJoin(productVariants, eq(productVariants.id, tintRecords.baseVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(parties, eq(parties.id, tintRecords.partyId))
    .leftJoin(projects, eq(projects.id, tintRecords.projectId))
    .leftJoin(quotationLines, eq(quotationLines.id, tintRecords.quotationLineId))
    .leftJoin(quotations, eq(quotations.id, quotationLines.quotationId))
    .leftJoin(salesOrderLines, eq(salesOrderLines.id, tintRecords.salesOrderLineId))
    .leftJoin(salesOrders, eq(salesOrders.id, salesOrderLines.orderId))
    .leftJoin(taxDocumentLines, eq(taxDocumentLines.id, tintRecords.invoiceLineId))
    .leftJoin(taxDocuments, eq(taxDocuments.id, taxDocumentLines.documentId))
    .$dynamic();
}

const DOCUMENT_KIND: Readonly<Record<TintLineKind, TintDocumentKind>> = {
  quotation_line: 'quotation',
  sales_order_line: 'sales_order',
  invoice_line: 'invoice',
};

type ViewRow = Awaited<ReturnType<ReturnType<typeof joined>['execute']>>[number];

function toView(row: ViewRow): TintRecordView {
  const { record } = row;
  const lineKind: TintLineKind =
    record.quotationLineId !== null
      ? 'quotation_line'
      : record.salesOrderLineId !== null
        ? 'sales_order_line'
        : 'invoice_line';
  return {
    id: record.id,
    lineKind,
    lineId: String(record.quotationLineId ?? record.salesOrderLineId ?? record.invoiceLineId),
    document: {
      kind: DOCUMENT_KIND[lineKind],
      id: row.documentId,
      number: row.documentNumber,
      status: row.documentStatus,
      date: row.documentDate,
    },
    store: { id: record.storeId, name: row.storeName },
    party:
      record.partyId === null
        ? null
        : { id: record.partyId, name: String(row.partyName), phone: row.partyPhone },
    project:
      record.projectId === null ? null : { id: record.projectId, name: String(row.projectName) },
    brand: { id: record.brandId, name: row.brandName },
    shadeCode: record.shadeCode,
    shadeName: record.shadeName,
    baseVariant: {
      id: record.baseVariantId,
      productId: row.productId,
      sku: row.sku,
      description: `${row.productName} ${variantName(row)}`,
      isActive: row.variantActive,
    },
    packQuantity: record.packQuantity,
    colorantCostPaise: record.colorantCostPaise,
    tintChargePaise: record.tintChargePaise,
    machine: record.machine,
    formula: record.formula as TintFormulaComponent[],
    note: record.note,
    createdByMemberId: record.createdByMemberId,
    createdAt: record.createdAt.toISOString(),
  };
}
