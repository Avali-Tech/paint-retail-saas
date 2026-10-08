import 'reflect-metadata';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { canAccessStore, type TaxDocumentPage, type TaxDocumentView } from '@paint/shared';
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { fieldError } from '../tax/tax-lookups.js';
import type { DiscountInput, DraftInvoiceInput, ListInvoicesQuery } from './billing.schemas.js';
import { idempotent } from './idempotency.js';
import { documentView, loadDocument, type TaxDocumentRow } from './invoice-view.js';

const {
  parties,
  partyRoles,
  productVariants,
  projects,
  salesSettings,
  stores,
  taxDocumentLines,
  taxDocuments,
} = schema;

/** Roles an influencer holds (spec §6.4). */
const INFLUENCER_ROLES = ['painter', 'contractor', 'architect'] as const;

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
      const where = and(
        auth.allStores ? undefined : inArray(taxDocuments.storeId, [...auth.storeIds]),
        query.storeId ? eq(taxDocuments.storeId, query.storeId) : undefined,
        query.partyId ? eq(taxDocuments.partyId, query.partyId) : undefined,
        query.status ? eq(taxDocuments.status, query.status) : undefined,
        query.kinds ? inArray(taxDocuments.kind, query.kinds) : undefined,
        query.from ? sql`${taxDocuments.issuedOn} >= ${query.from}::date` : undefined,
        query.to ? sql`${taxDocuments.issuedOn} <= ${query.to}::date` : undefined,
        query.q
          ? or(
              ilike(taxDocuments.number, `%${query.q}%`),
              ilike(taxDocuments.buyerName, `%${query.q}%`),
            )
          : undefined,
      );
      const items = await tx
        .select({
          id: taxDocuments.id,
          kind: taxDocuments.kind,
          status: taxDocuments.status,
          storeId: taxDocuments.storeId,
          number: taxDocuments.number,
          issuedOn: taxDocuments.issuedOn,
          buyerName: taxDocuments.buyerName,
          totalPaise: taxDocuments.totalPaise,
        })
        .from(taxDocuments)
        .where(where)
        .orderBy(desc(taxDocuments.createdAt), desc(taxDocuments.id))
        .limit(query.limit)
        .offset(query.offset);
      const [total] = await tx.select({ value: count() }).from(taxDocuments).where(where);
      return { items, total: Number(total?.value) };
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
    if (input.partyId !== undefined) await this.assertParty(tx, input.partyId, 'partyId', null);
    if (input.influencerPartyId !== undefined) {
      await this.assertParty(tx, input.influencerPartyId, 'influencerPartyId', INFLUENCER_ROLES);
    }
    if (input.projectId !== undefined) {
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (!project) throw fieldError('projectId', 'Unknown site');
    }
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

  private async assertParty(
    tx: Transaction,
    partyId: string,
    path: string,
    roles: readonly (typeof INFLUENCER_ROLES)[number][] | null,
  ): Promise<void> {
    const [party] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.id, partyId),
          eq(parties.isActive, true),
          isNull(parties.mergedIntoId),
          roles === null
            ? undefined
            : sql`exists (select 1 from ${partyRoles} r where r.party_id = ${sql.raw('"parties"."id"')} and r.role::text = any(${`{${roles.join(',')}}`}::text[]))`,
        ),
      );
    if (!party) {
      throw fieldError(
        path,
        roles === null ? 'Unknown customer' : 'Choose a painter, contractor or architect',
      );
    }
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
    await tx.insert(taxDocumentLines).values(values);
  }
}
