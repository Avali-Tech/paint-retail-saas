import 'reflect-metadata';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  nextDocumentNumber,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import {
  QUOTATION_NUMBER_PREFIX,
  effectiveQuotationStatus,
  formatDocumentNumber,
  type QuotationPage,
  type QuotationView,
  type SalesOrderView,
} from '@paint/shared';
import { and, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { requireSaleParty } from '../billing/sale-parties.js';
import { idempotent } from '../billing/idempotency.js';
import { indiaToday } from '../billing/invoice-view.js';
import {
  afterKey,
  cappedTotal,
  cursorTime,
  keysetSlice,
  NEWEST_FIRST,
  pageOffset,
} from '../common/keyset.js';
import { addDays } from '../contracts/contract-dates.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import { fieldError } from '../tax/tax-lookups.js';
import { tintsOf, writeLineTints } from '../paint/line-tints.js';
import { carriesByLineNo, carryTints } from '../paint/tint-lines.js';
import {
  loadQuotation,
  newestFirst,
  orderLines,
  quotationView,
  salesOrderView,
  type QuotationRow,
} from './order-views.js';
import { insertOrder } from './order-writes.js';
import type {
  ConvertQuotationInput,
  ListQuotationsQuery,
  QuotationInput,
} from './orders.schemas.js';
import { priceHeader, pricedColumns, saleHeader, storedHeader } from './sale-header.js';
import { discountOf } from './sale-pricing.js';

const { parties, quotationLines, quotations, salesSettings } = schema;

/**
 * Quotations (P2-M03, spec §5.3): versioned quotes for a party, site or
 * project, priced by the GST engine; a sent quote is revised as a new version
 * and converted into a sales order.
 */
@Injectable()
export class QuotationsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(
    auth: AuthContext,
    input: QuotationInput,
    idempotencyKey?: string,
  ): Promise<QuotationView> {
    const request = { method: 'POST', path: '/quotations', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, () => this.createIn(tx, auth, input)),
    );
  }

  /** A new draft quotation, in the caller's transaction (also an estimate's convert, round 5b). */
  async createIn(
    tx: Transaction,
    auth: AuthContext,
    input: QuotationInput,
  ): Promise<QuotationView> {
    const today = await indiaToday(tx);
    const values = await this.priced(tx, auth, input, today);
    const number = formatDocumentNumber(
      QUOTATION_NUMBER_PREFIX,
      await nextDocumentNumber(tx, auth.organization.id, 'quotation'),
    );
    const [row] = (await tx
      .insert(quotations)
      .values({
        ...values.header,
        organizationId: auth.organization.id,
        number,
        validUntil: values.validUntil,
        createdByMemberId: auth.memberId,
      })
      .returning()) as [QuotationRow];
    await this.writeTints(
      tx,
      auth,
      row,
      input,
      await this.writeLines(tx, auth, row.id, values.lines),
    );
    return quotationView(tx, row, today);
  }

  /** Changes a draft version: the header and every line are replaced and priced again. */
  update(auth: AuthContext, id: string, input: QuotationInput): Promise<QuotationView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const current = await loadQuotation(tx, auth, id, true);
      this.assertDraft(current);
      const today = await indiaToday(tx);
      const values = await this.priced(tx, auth, input, today);
      const [row] = (await tx
        .update(quotations)
        .set({ ...values.header, validUntil: values.validUntil, updatedAt: sql`now()` })
        .where(eq(quotations.id, id))
        .returning()) as [QuotationRow];
      await tx.delete(quotationLines).where(eq(quotationLines.quotationId, id));
      await this.writeTints(
        tx,
        auth,
        row,
        input,
        await this.writeLines(tx, auth, id, values.lines),
      );
      return quotationView(tx, row, today);
    });
  }

  /** Discards a first-version draft; a revision is edited instead. */
  remove(auth: AuthContext, id: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const current = await loadQuotation(tx, auth, id, true);
      this.assertDraft(current);
      if (current.version > 1) {
        throw new ConflictException('A revision is not discarded: change it instead');
      }
      await tx.delete(quotations).where(eq(quotations.id, id));
    });
  }

  get(auth: AuthContext, id: string): Promise<QuotationView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      quotationView(tx, await loadQuotation(tx, auth, id), await indiaToday(tx)),
    );
  }

  list(auth: AuthContext, query: ListQuotationsQuery): Promise<QuotationPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const today = await indiaToday(tx);
      const expired = sql`${quotations.status} in ('sent', 'accepted') and ${quotations.validUntil} < ${today}::date`;
      const where = and(
        auth.allStores ? undefined : inArray(quotations.storeId, [...auth.storeIds]),
        query.allVersions ? undefined : ne(quotations.status, 'superseded'),
        query.storeId ? eq(quotations.storeId, query.storeId) : undefined,
        query.partyId ? eq(quotations.billToPartyId, query.partyId) : undefined,
        query.projectId ? eq(quotations.projectId, query.projectId) : undefined,
        query.status === 'expired'
          ? expired
          : query.status === 'sent' || query.status === 'accepted'
            ? and(eq(quotations.status, query.status), sql`not (${expired})`)
            : query.status
              ? eq(quotations.status, query.status)
              : undefined,
        query.q
          ? or(
              ilike(quotations.number, containsPattern(query.q)),
              ilike(parties.displayName, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await tx
        .select({
          id: quotations.id,
          number: quotations.number,
          version: quotations.version,
          status: quotations.status,
          storeId: quotations.storeId,
          billToPartyId: quotations.billToPartyId,
          billToName: parties.displayName,
          projectId: quotations.projectId,
          validUntil: quotations.validUntil,
          totalPaise: quotations.totalPaise,
          createdAt: quotations.createdAt,
          cursorAt: cursorTime(quotations.createdAt),
        })
        .from(quotations)
        .innerJoin(parties, eq(parties.id, quotations.billToPartyId))
        .where(
          and(where, afterKey(NEWEST_FIRST, [quotations.createdAt, quotations.id], query.cursor)),
        )
        .orderBy(...newestFirst(quotations))
        .limit(query.limit + 1)
        .offset(pageOffset(query));
      const page = keysetSlice(rows, query.limit, (row) => [row.cursorAt, row.id]);
      return {
        items: page.rows.map(({ cursorAt, ...row }) => ({
          ...row,
          status: effectiveQuotationStatus(row.status, row.validUntil, today),
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
        ...(await cappedTotal(
          tx,
          tx
            .select({ id: quotations.id })
            .from(quotations)
            .innerJoin(parties, eq(parties.id, quotations.billToPartyId))
            .where(where)
            .$dynamic(),
        )),
      };
    });
  }

  /** Draft → sent: the version the customer has; from now on it changes only by revision. */
  send(auth: AuthContext, id: string): Promise<QuotationView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const current = await loadQuotation(tx, auth, id, true);
      this.assertDraft(current);
      const today = await indiaToday(tx);
      if (current.validUntil < today) {
        throw new ConflictException('This quotation is past its validity: change the date first');
      }
      return this.move(tx, id, { status: 'sent', sentAt: sql`now()` }, today);
    });
  }

  /** Sent → accepted: the customer said yes. */
  accept(auth: AuthContext, id: string): Promise<QuotationView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const current = await loadQuotation(tx, auth, id, true);
      const today = await indiaToday(tx);
      if (effectiveQuotationStatus(current.status, current.validUntil, today) !== 'sent') {
        throw new ConflictException(
          `Only a sent, valid quotation is accepted; this one is ${effectiveQuotationStatus(current.status, current.validUntil, today)}`,
        );
      }
      return this.move(tx, id, { status: 'accepted', acceptedAt: sql`now()` }, today);
    });
  }

  /**
   * A new version (spec §5.3: "Revise creates v2 and keeps v1 read-only"):
   * a draft copy priced at today's rates with a fresh validity; the version it
   * replaces is superseded.
   */
  revise(auth: AuthContext, id: string): Promise<QuotationView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const current = await loadQuotation(tx, auth, id, true);
      if (current.status !== 'sent' && current.status !== 'accepted') {
        throw new ConflictException(
          current.status === 'draft'
            ? 'A draft is changed, not revised'
            : `A ${current.status} quotation is not revised`,
        );
      }
      const today = await indiaToday(tx);
      const lines = await tx
        .select()
        .from(quotationLines)
        .where(eq(quotationLines.quotationId, id))
        .orderBy(quotationLines.lineNo);
      const billTo = await requireSaleParty(tx, current.billToPartyId, 'billToPartyId');
      const header = storedHeader(current);
      const priced = await priceHeader(
        tx,
        header,
        billTo,
        discountOf(current.billDiscountBps, current.billDiscountPaise),
        lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitPricePaise: line.unitPricePaise,
          discount: discountOf(line.discountBps, line.discountPaise),
        })),
        today,
      );
      await tx
        .update(quotations)
        .set({ status: 'superseded', updatedAt: sql`now()` })
        .where(eq(quotations.id, id));
      const [row] = (await tx
        .insert(quotations)
        .values({
          ...pricedColumns(header, priced),
          organizationId: auth.organization.id,
          number: current.number,
          version: current.version + 1,
          rootQuotationId: current.rootQuotationId ?? current.id,
          validUntil: addDays(today, await this.validityDays(tx)),
          createdByMemberId: auth.memberId,
        })
        .returning()) as [QuotationRow];
      const created = await this.writeLines(tx, auth, row.id, priced.lines);
      await carryTints(
        tx,
        auth.memberId,
        'quotation_line',
        'quotation_line',
        { partyId: row.billToPartyId, projectId: row.projectId },
        carriesByLineNo(
          lines,
          created.map((line) => ({ ...line, storeId: row.storeId })),
        ),
      );
      return quotationView(tx, row, today);
    });
  }

  /**
   * A sent or accepted, valid quote becomes a draft sales order re-priced at
   * today's rates (spec §3.3); the quote is converted and points at it.
   */
  convert(
    auth: AuthContext,
    id: string,
    input: ConvertQuotationInput,
    idempotencyKey?: string,
  ): Promise<SalesOrderView> {
    const request = { method: 'POST', path: `/quotations/${id}/convert`, body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        const current = await loadQuotation(tx, auth, id, true);
        const today = await indiaToday(tx);
        const status = effectiveQuotationStatus(current.status, current.validUntil, today);
        if (status !== 'sent' && status !== 'accepted') {
          throw new ConflictException(
            status === 'expired'
              ? 'This quotation has expired: revise it first'
              : `A ${status} quotation is not converted`,
          );
        }
        const lines = await tx
          .select()
          .from(quotationLines)
          .where(eq(quotationLines.quotationId, id))
          .orderBy(quotationLines.lineNo);
        const order = await insertOrder(
          tx,
          auth,
          {
            storeId: current.storeId,
            billToPartyId: current.billToPartyId,
            influencerPartyId: current.influencerPartyId,
            projectId: current.projectId,
            shipTo:
              current.shipToStateCode === null
                ? null
                : {
                    name: current.shipToName ?? undefined,
                    address: current.shipToAddress ?? undefined,
                    stateCode: current.shipToStateCode,
                  },
            priceMode: current.priceMode,
            billDiscount: discountOf(current.billDiscountBps, current.billDiscountPaise),
            note: input.note ?? current.note,
            paymentTerms: input.paymentTerms,
            lines: lines.map((line) => ({
              variantId: line.variantId,
              quantity: line.quantity,
              unitPricePaise: line.unitPricePaise,
              discount: discountOf(line.discountBps, line.discountPaise),
              fulfilStoreId: input.fulfilStoreId,
            })),
          },
          today,
          current.id,
        );
        await carryTints(
          tx,
          auth.memberId,
          'quotation_line',
          'sales_order_line',
          { partyId: order.billToPartyId, projectId: order.projectId },
          carriesByLineNo(
            lines,
            (await orderLines(tx, order.id)).map((line) => ({
              id: line.id,
              lineNo: line.lineNo,
              quantity: line.quantity,
              storeId: line.fulfilStoreId,
            })),
          ),
        );
        await tx
          .update(quotations)
          .set({ status: 'converted', salesOrderId: order.id, updatedAt: sql`now()` })
          .where(eq(quotations.id, id));
        return salesOrderView(tx, order);
      }),
    );
  }

  // Helpers -----------------------------------------------------------------

  private assertDraft(quotation: QuotationRow): void {
    if (quotation.status !== 'draft') {
      throw new ConflictException(
        `This quotation is ${quotation.status}: revise it as a new version instead`,
      );
    }
  }

  private async validityDays(tx: Transaction): Promise<number> {
    const [settings] = await tx
      .select({ days: salesSettings.quoteValidityDays })
      .from(salesSettings);
    return settings?.days ?? 15;
  }

  /** The request checked and priced at `today`, with its validity. */
  private async priced(tx: Transaction, auth: AuthContext, input: QuotationInput, today: string) {
    const { header, billTo } = await saleHeader(tx, auth, input);
    const validUntil = input.validUntil ?? addDays(today, await this.validityDays(tx));
    if (validUntil < today) throw fieldError('validUntil', 'A quotation is valid from today');
    const priced = await priceHeader(
      tx,
      header,
      billTo,
      input.billDiscount ?? null,
      input.lines,
      today,
    );
    return { header: pricedColumns(header, priced), validUntil, lines: priced.lines };
  }

  private async move(
    tx: Transaction,
    id: string,
    changes: PgUpdateSetSource<typeof quotations>,
    today: string,
  ): Promise<QuotationView> {
    const [row] = (await tx
      .update(quotations)
      .set({ ...changes, updatedAt: sql`now()` })
      .where(eq(quotations.id, id))
      .returning()) as [QuotationRow];
    return quotationView(tx, row, today);
  }

  /** The tints sent with the lines (round 5a), in the saving transaction. */
  private async writeTints(
    tx: Transaction,
    auth: AuthContext,
    row: QuotationRow,
    input: QuotationInput,
    lines: readonly { id: string; lineNo: number; quantity: number }[],
  ): Promise<void> {
    await writeLineTints(
      tx,
      auth,
      'quotation_line',
      { partyId: row.billToPartyId, projectId: row.projectId },
      tintsOf(input.lines, lines, () => row.storeId),
    );
  }

  private writeLines(
    tx: Transaction,
    auth: AuthContext,
    quotationId: string,
    lines: Awaited<ReturnType<typeof priceHeader>>['lines'],
  ) {
    return tx
      .insert(quotationLines)
      .values(lines.map((line) => ({ ...line, organizationId: auth.organization.id, quotationId })))
      .returning({
        id: quotationLines.id,
        lineNo: quotationLines.lineNo,
        quantity: quotationLines.quantity,
      });
  }
}
