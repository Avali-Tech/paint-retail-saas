import 'reflect-metadata';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  nextDocumentNumber,
  postStockMovements,
  releaseStock,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import {
  DISPATCH_NUMBER_PREFIX,
  ewayBillRequired,
  formatDocumentNumber,
  formatINR,
  type DispatchView,
  type InvoiceDispatchesView,
} from '@paint/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { idempotent } from '../billing/idempotency.js';
import { loadDocument, type TaxDocumentRow } from '../billing/invoice-view.js';
import { DATABASE } from '../database/database.module.js';
import { fieldError } from '../tax/tax-lookups.js';
import { dispatchedByLine } from './dispatched.js';
import type { DispatchInput } from './orders.schemas.js';

const { dispatchLines, dispatches, gstinProfiles, taxDocumentLines } = schema;

/** Thousandths, so quantities (at most 3 decimals) add up exactly. */
const milli = (quantity: number) => Math.round(quantity * 1000);
/** Rule 138: ₹50,000 unless the GSTIN's profile says otherwise. */
const DEFAULT_EWAY_THRESHOLD_PAISE = 5_000_000;

type DispatchRow = typeof dispatches.$inferSelect;

/**
 * Dispatches (spec §3.3, §4.2, §2.10): goods leaving for an issued invoice.
 * An invoice billed with stock out on dispatch takes its stock out here; any
 * other is only recorded. Above the GSTIN's threshold the e-way bill number
 * entered from the government portal is required.
 */
@Injectable()
export class DispatchesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(
    auth: AuthContext,
    invoiceId: string,
    input: DispatchInput,
    idempotencyKey?: string,
  ): Promise<DispatchView> {
    const request = { method: 'POST', path: `/invoices/${invoiceId}/dispatches`, body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        const invoice = await this.issuedInvoice(tx, auth, invoiceId);
        const lines = await this.lines(tx, invoiceId);
        const sent = await dispatchedByLine(tx, invoiceId);
        const pending = (line: (typeof lines)[number]) =>
          milli(line.quantity) - milli(sent(line.id));
        const going = (
          input.lines?.map((item, index) => {
            const line = lines.find((candidate) => candidate.id === item.invoiceLineId);
            if (!line)
              throw fieldError(
                `lines.${String(index)}.invoiceLineId`,
                'Not a line of this invoice',
              );
            if (milli(item.quantity) > pending(line)) {
              throw fieldError(
                `lines.${String(index)}.quantity`,
                `Only ${String(pending(line) / 1000)} of line ${String(line.lineNo)} is waiting`,
              );
            }
            return { line, quantity: item.quantity };
          }) ??
          lines
            .filter((line) => pending(line) > 0)
            .map((line) => ({ line, quantity: pending(line) / 1000 }))
        ).map((item) => ({
          ...item,
          valuePaise: Math.round((item.line.totalPaise * item.quantity) / item.line.quantity),
        }));
        if (going.length === 0) throw new ConflictException('Everything on this invoice has gone');
        const valuePaise = going.reduce((sum, item) => sum + item.valuePaise, 0);
        const threshold = await this.ewayThreshold(tx, invoice);
        if (ewayBillRequired(valuePaise, threshold) && input.ewayBillNo === undefined) {
          throw fieldError(
            'ewayBillNo',
            `Goods worth ${formatINR(valuePaise)} need an e-way bill (above ${formatINR(threshold)})`,
          );
        }
        const stockPosted = invoice.stockPosting === 'on_dispatch';
        const [dispatch] = (await tx
          .insert(dispatches)
          .values({
            organizationId: auth.organization.id,
            number: formatDocumentNumber(
              DISPATCH_NUMBER_PREFIX,
              await nextDocumentNumber(tx, auth.organization.id, 'dispatch'),
            ),
            invoiceId,
            storeId: invoice.storeId,
            vehicleNo: input.vehicleNo,
            ewayBillNo: input.ewayBillNo,
            ewayValidUntil: input.ewayValidUntil,
            valuePaise,
            stockPosted,
            note: input.note,
            createdByMemberId: auth.memberId,
          })
          .returning()) as [DispatchRow];
        await tx.insert(dispatchLines).values(
          going.map((item) => ({
            organizationId: auth.organization.id,
            dispatchId: dispatch.id,
            invoiceLineId: item.line.id,
            quantity: item.quantity,
            valuePaise: item.valuePaise,
          })),
        );
        if (stockPosted) {
          // Billed earlier and held for the customer: the hold is consumed as the goods leave.
          await releaseStock(
            tx,
            going.map((item) => ({
              orderLineId: String(item.line.orderLineId),
              quantity: item.quantity,
              consumedBy: { type: 'dispatch' as const, id: dispatch.id },
            })),
          );
          await postStockMovements(
            tx,
            going.map((item) => ({
              organizationId: auth.organization.id,
              storeId: invoice.storeId,
              variantId: item.line.variantId,
              movementType: 'sale' as const,
              quantity: -item.quantity,
              referenceType: 'dispatch',
              referenceId: dispatch.id,
              note: `${dispatch.number} for ${String(invoice.number)}`,
              createdByMemberId: auth.memberId,
            })),
          );
        }
        const [view] = (await this.views(tx, invoice, [dispatch])) as [DispatchView];
        return view;
      }),
    );
  }

  /** What has gone for an invoice, line by line, and every dispatch. */
  list(auth: AuthContext, invoiceId: string): Promise<InvoiceDispatchesView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const invoice = await loadDocument(tx, auth, invoiceId);
      const lines = await this.lines(tx, invoiceId);
      const sent = await dispatchedByLine(tx, invoiceId);
      const rows = await tx
        .select()
        .from(dispatches)
        .where(eq(dispatches.invoiceId, invoiceId))
        .orderBy(asc(dispatches.createdAt), asc(dispatches.id));
      return {
        invoiceId,
        stockPosting: invoice.stockPosting,
        ewayThresholdPaise: await this.ewayThreshold(tx, invoice),
        lines: lines.map((line) => ({
          invoiceLineId: line.id,
          lineNo: line.lineNo,
          variantId: line.variantId,
          description: line.description,
          quantity: line.quantity,
          dispatchedQuantity: sent(line.id),
          pendingQuantity: (milli(line.quantity) - milli(sent(line.id))) / 1000,
        })),
        dispatches: await this.views(tx, invoice, rows),
      };
    });
  }

  // Helpers -----------------------------------------------------------------

  private async issuedInvoice(
    tx: Transaction,
    auth: AuthContext,
    invoiceId: string,
  ): Promise<TaxDocumentRow> {
    const invoice = await loadDocument(tx, auth, invoiceId, true);
    if (invoice.kind !== 'invoice' && invoice.kind !== 'bill_of_supply') {
      throw new ConflictException('Only an invoice or bill of supply is dispatched');
    }
    if (invoice.status !== 'issued') {
      throw new ConflictException(
        `Only an issued invoice is dispatched; this one is ${invoice.status}`,
      );
    }
    return invoice;
  }

  private lines(tx: Transaction, invoiceId: string) {
    return tx
      .select()
      .from(taxDocumentLines)
      .where(eq(taxDocumentLines.documentId, invoiceId))
      .orderBy(asc(taxDocumentLines.lineNo));
  }

  private async ewayThreshold(tx: Transaction, invoice: TaxDocumentRow): Promise<number> {
    // Every issued document carries its supplier GSTIN (tax_documents_issued_complete).
    const [profile] = await tx
      .select({ threshold: gstinProfiles.ewayThresholdPaise })
      .from(gstinProfiles)
      .where(eq(gstinProfiles.gstin, String(invoice.supplierGstin)));
    return profile?.threshold ?? DEFAULT_EWAY_THRESHOLD_PAISE;
  }

  private async views(
    tx: Transaction,
    invoice: TaxDocumentRow,
    rows: readonly DispatchRow[],
  ): Promise<DispatchView[]> {
    const lines = await tx
      .select({
        line: dispatchLines,
        variantId: taxDocumentLines.variantId,
        description: taxDocumentLines.description,
      })
      .from(dispatchLines)
      .innerJoin(taxDocumentLines, eq(taxDocumentLines.id, dispatchLines.invoiceLineId))
      .where(
        inArray(
          dispatchLines.dispatchId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(taxDocumentLines.lineNo));
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      invoiceId: row.invoiceId,
      invoiceNumber: String(invoice.number),
      storeId: row.storeId,
      dispatchedAt: row.dispatchedAt.toISOString(),
      vehicleNo: row.vehicleNo,
      ewayBillNo: row.ewayBillNo,
      ewayValidUntil: row.ewayValidUntil,
      valuePaise: row.valuePaise,
      stockPosted: row.stockPosted,
      note: row.note,
      createdByMemberId: row.createdByMemberId,
      lines: lines
        .filter(({ line }) => line.dispatchId === row.id)
        .map(({ line, variantId, description }) => ({
          id: line.id,
          invoiceLineId: line.invoiceLineId,
          variantId,
          description,
          quantity: line.quantity,
          valuePaise: line.valuePaise,
        })),
    }));
  }
}
