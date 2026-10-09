import 'reflect-metadata';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { canAccessStore, type TaxDocumentPage, type TaxDocumentView } from '@paint/shared';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
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
import type { DiscountInput, DraftInvoiceInput, ListInvoicesQuery } from './billing.schemas.js';
import { idempotent } from './idempotency.js';
import { INFLUENCER_ROLES, requireSaleParty, requireSaleSite } from './sale-parties.js';
import { documentView, loadDocument, type TaxDocumentRow } from './invoice-view.js';
import { tintsOf, writeLineTints } from '../paint/line-tints.js';

const { productVariants, salesSettings, stores, taxDocumentLines, taxDocuments } = schema;

const percentOf = (discount: DiscountInput | undefined) =>
  discount?.kind === 'percent' ? discount.basisPoints : null;
const amountOf = (discount: DiscountInput | undefined) =>
  discount?.kind === 'amount' ? discount.paise : null;

/** Draft invoices and bills of supply (held bills), and reading them back. */
@Injectable()
export class InvoicesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(
    auth: AuthContext,
    input: DraftInvoiceInput,
    idempotencyKey?: string,
  ): Promise<TaxDocumentView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(
        tx,
        auth,
        idempotencyKey,
        { method: 'POST', path: '/invoices', body: input },
        async () => {
          const header = await this.header(tx, auth, input);
          const [document] = (await tx
            .insert(taxDocuments)
            .values({
              ...header,
              organizationId: auth.organization.id,
              createdByMemberId: auth.memberId,
            })
            .returning()) as [TaxDocumentRow];
          await this.writeLines(tx, auth, document.id, input);
          return documentView(tx, document);
        },
      ),
    );
  }

  /** Changes a draft (hold and resume): the header and every line are replaced. */
  update(auth: AuthContext, id: string, input: DraftInvoiceInput): Promise<TaxDocumentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const document = await loadDocument(tx, auth, id, true);
      if (document.status !== 'draft') {
        throw new ConflictException('An issued invoice cannot be changed');
      }
      if (document.salesOrderId !== null) {
        throw new ConflictException(
          'This bill comes from a sales order: discard it and bill the order again',
        );
      }
      const header = await this.header(tx, auth, input);
      const [updated] = (await tx
        .update(taxDocuments)
        .set({ ...header, updatedAt: sql`now()` })
        .where(eq(taxDocuments.id, id))
        .returning()) as [TaxDocumentRow];
      await tx.delete(taxDocumentLines).where(eq(taxDocumentLines.documentId, id));
      await this.writeLines(tx, auth, id, input);
      return documentView(tx, updated);
    });
  }

  /** Discards a draft; an issued invoice is cancelled instead. */
  remove(auth: AuthContext, id: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const document = await loadDocument(tx, auth, id, true);
      if (document.status !== 'draft') {
        throw new ConflictException('An issued invoice is never deleted; cancel it instead');
      }
      await tx.delete(taxDocuments).where(eq(taxDocuments.id, id));
    });
  }

  get(auth: AuthContext, id: string): Promise<TaxDocumentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      documentView(tx, await loadDocument(tx, auth, id)),
    );
  }

  list(auth: AuthContext, query: ListInvoicesQuery): Promise<TaxDocumentPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const pattern = query.q === undefined ? null : containsPattern(query.q);
      const where = and(
        auth.allStores ? undefined : inArray(taxDocuments.storeId, [...auth.storeIds]),
        query.storeId ? eq(taxDocuments.storeId, query.storeId) : undefined,
        query.partyId ? eq(taxDocuments.partyId, query.partyId) : undefined,
        query.status ? eq(taxDocuments.status, query.status) : undefined,
        query.kinds ? inArray(taxDocuments.kind, query.kinds) : undefined,
        query.from ? sql`${taxDocuments.issuedOn} >= ${query.from}::date` : undefined,
        query.to ? sql`${taxDocuments.issuedOn} <= ${query.to}::date` : undefined,
        pattern === null
          ? undefined
          : or(ilike(taxDocuments.number, pattern), ilike(taxDocuments.buyerName, pattern)),
      );
      const rows = await tx
        .select({
          id: taxDocuments.id,
          kind: taxDocuments.kind,
          status: taxDocuments.status,
          storeId: taxDocuments.storeId,
          number: taxDocuments.number,
          issuedOn: taxDocuments.issuedOn,
          buyerName: taxDocuments.buyerName,
          totalPaise: taxDocuments.totalPaise,
          cursorAt: cursorTime(taxDocuments.createdAt),
        })
        .from(taxDocuments)
        .where(
          and(
            where,
            afterKey(NEWEST_FIRST, [taxDocuments.createdAt, taxDocuments.id], query.cursor),
          ),
        )
        .orderBy(desc(taxDocuments.createdAt), desc(taxDocuments.id))
        .limit(query.limit + 1)
        .offset(pageOffset(query));
      const page = keysetSlice(rows, query.limit, (row) => [row.cursorAt, row.id]);
      return {
        items: page.rows.map(({ cursorAt, ...item }) => item),
        nextCursor: page.nextCursor,
        ...(await cappedTotal(
          tx,
          tx.select({ id: taxDocuments.id }).from(taxDocuments).where(where).$dynamic(),
        )),
      };
    });
  }

  // Helpers -----------------------------------------------------------------

  /** The draft's header from the request, after checking every reference. */
  private async header(tx: Transaction, auth: AuthContext, input: DraftInvoiceInput) {
    const [store] = await tx
      .select({ registrationType: stores.registrationType })
      .from(stores)
      .where(and(eq(stores.id, input.storeId), eq(stores.isActive, true)));
    if (!store) throw fieldError('storeId', 'Unknown store');
    if (!canAccessStore(auth, input.storeId)) {
      throw new ForbiddenException('You can bill only at a store you work at');
    }
    if (input.partyId !== undefined) await requireSaleParty(tx, input.partyId, 'partyId');
    if (input.influencerPartyId !== undefined) {
      await requireSaleParty(tx, input.influencerPartyId, 'influencerPartyId', INFLUENCER_ROLES);
    }
    if (input.projectId !== undefined) await requireSaleSite(tx, input.projectId);
    const [settings] = await tx
      .select({ priceMode: salesSettings.defaultPriceMode })
      .from(salesSettings);
    return {
      kind:
        store.registrationType === 'composition'
          ? ('bill_of_supply' as const)
          : ('invoice' as const),
      storeId: input.storeId,
      partyId: input.partyId ?? null,
      buyerName: input.buyer.name ?? null,
      buyerGstin: input.buyer.gstin ?? null,
      buyerAddress: input.buyer.address ?? null,
      buyerStateCode: input.buyer.stateCode ?? null,
      shipToName: input.shipTo?.name ?? null,
      shipToAddress: input.shipTo?.address ?? null,
      shipToStateCode: input.shipTo?.stateCode ?? null,
      priceMode: input.priceMode ?? settings?.priceMode ?? 'inclusive',
      billDiscountBps: percentOf(input.billDiscount),
      billDiscountPaise: amountOf(input.billDiscount),
      influencerPartyId: input.influencerPartyId ?? null,
      projectId: input.projectId ?? null,
      dueOn: input.dueOn ?? null,
      note: input.note ?? null,
    };
  }

  private async writeLines(
    tx: Transaction,
    auth: AuthContext,
    documentId: string,
    input: DraftInvoiceInput,
  ): Promise<void> {
    const variantIds = [...new Set(input.lines.map((line) => line.variantId))];
    const variants = await tx
      .select({ id: productVariants.id, price: productVariants.sellingPricePaise })
      .from(productVariants)
      .where(and(inArray(productVariants.id, variantIds), eq(productVariants.isActive, true)));
    const values = input.lines.map((line, index) => {
      const variant = variants.find((candidate) => candidate.id === line.variantId);
      if (!variant) throw fieldError(`lines.${String(index)}.variantId`, 'Unknown product');
      const unitPricePaise = line.unitPricePaise ?? variant.price;
      if (unitPricePaise === null) {
        throw fieldError(
          `lines.${String(index)}.unitPricePaise`,
          'This product has no price; enter one',
        );
      }
      return {
        organizationId: auth.organization.id,
        documentId,
        lineNo: index + 1,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPricePaise,
        discountBps: percentOf(line.discount),
        discountPaise: amountOf(line.discount),
      };
    });
    const saved = await tx.insert(taxDocumentLines).values(values).returning({
      id: taxDocumentLines.id,
      lineNo: taxDocumentLines.lineNo,
      quantity: taxDocumentLines.quantity,
    });
    // The shades sent with the lines (round 5a), in the same transaction.
    await writeLineTints(
      tx,
      auth,
      'invoice_line',
      { partyId: input.partyId ?? null, projectId: input.projectId ?? null },
      tintsOf(input.lines, saved, () => input.storeId),
    );
  }
}
