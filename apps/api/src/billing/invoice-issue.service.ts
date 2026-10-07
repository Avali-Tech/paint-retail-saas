import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  nextDocumentNumber,
  postPartyLedger,
  postStockMovements,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import {
  BUYER_DETAILS_THRESHOLD_PAISE,
  DEFAULT_GST_OPTIONS,
  computeInvoice,
  defaultSeries,
  financialYear,
  formatTaxDocumentNumber,
  gstClassFor,
  hsnMeetsRequirement,
  requiredHsnDigits,
  uqcFor,
  variantName,
  type Discount,
  type GstError,
  type GstRate,
  type Invoice,
  type TaxDocumentView,
} from '@paint/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import type { CancelInvoiceInput, IssueInvoiceInput } from './billing.schemas.js';
import { idempotent } from './idempotency.js';
import { documentView, indiaToday, loadDocument, type TaxDocumentRow } from './invoice-view.js';

const {
  documentSeries,
  gstinProfiles,
  parties,
  productVariants,
  products,
  salesSettings,
  stockBalances,
  stores,
  taxCategories,
  taxDocumentLines,
  taxDocumentLinks,
  taxDocumentTaxRows,
  taxDocuments,
  taxRates,
} = schema;

/** A turnover just above ₹5 crore, to read the HSN rule for the `above_5cr` band. */
const ABOVE_5_CRORE_PAISE = 5_00_00_000_00 + 1;

const discountOf = (bps: number | null, paise: number | null): Discount | null => {
  if (bps !== null) return { kind: 'percent', basisPoints: bps };
  return paise === null ? null : { kind: 'amount', paise };
};

/** A refusal naming the field at fault, shaped like the validation pipe's answers. */
const unprocessable = (issues: { path: string; message: string }[]) =>
  new UnprocessableEntityException({ statusCode: 422, message: 'Cannot issue', issues });

/** The buyer as the issued document records it. */
interface BuyerSnapshot {
  readonly name: string | null;
  readonly gstin: string | null;
  readonly address: string | null;
  readonly stateCode: string | null;
  readonly deliveryStateCode: string | null;
}

/** The item at `index` of a list known to be that long (the engine returns one line per input). */
const nth = <T>(items: readonly T[], index: number): T => (items.slice(index, index + 1) as [T])[0];

const party = alias(schema.parties, 'party');

/** One line of the draft with what the issue snapshots from its product. */
interface DraftLine {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly discountBps: number | null;
  readonly discountPaise: number | null;
  readonly sku: string;
  readonly productName: string;
  readonly packSize: number;
  readonly label: string | null;
  readonly hsnCode: string;
  readonly unit: string;
  readonly taxCategoryId: string | null;
}

/**
 * Issuing and cancelling invoices and bills of supply (spec §4.1–4.2, §4.6):
 * one transaction numbers the document, snapshots it, takes the stock out and
 * writes the party ledger, or does none of it.
 */
@Injectable()
export class InvoiceIssueService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  issue(
    auth: AuthContext,
    id: string,
    input: IssueInvoiceInput,
    idempotencyKey?: string,
  ): Promise<TaxDocumentView> {
    const request = { method: 'POST', path: `/invoices/${id}/issue`, body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, () => this.issueIn(tx, auth, id, input)),
    );
  }

  /** Same-day cancellation of a counter mistake (spec §3.6, [CA-9]); otherwise a credit note. */
  cancel(auth: AuthContext, id: string, input: CancelInvoiceInput): Promise<TaxDocumentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const document = await loadDocument(tx, auth, id, true);
      if (document.status !== 'issued') {
        throw new ConflictException('Only an issued invoice can be cancelled');
      }
      const today = await indiaToday(tx);
      if (document.issuedOn !== today) {
        throw new ConflictException(
          'An invoice can be cancelled only on the day it was issued; raise a credit note instead',
        );
      }
      const [linked] = await tx
        .select({ id: taxDocumentLinks.id })
        .from(taxDocumentLinks)
        .where(eq(taxDocumentLinks.toDocumentId, id))
        .limit(1);
      if (linked) {
        throw new ConflictException(
          'A note or advance refers to this invoice; it cannot be cancelled',
        );
      }
      const [cancelled] = (await tx
        .update(taxDocuments)
        .set({
          status: 'cancelled',
          cancelReason: input.reason,
          cancelledAt: sql`now()`,
          cancelledByMemberId: auth.memberId,
          updatedAt: sql`now()`,
        })
        .where(eq(taxDocuments.id, id))
        .returning()) as [TaxDocumentRow];
      const lines = await tx
        .select({ variantId: taxDocumentLines.variantId, quantity: taxDocumentLines.quantity })
        .from(taxDocumentLines)
        .where(eq(taxDocumentLines.documentId, id));
      await postStockMovements(
        tx,
        lines.map((line) => ({
          organizationId: auth.organization.id,
          storeId: document.storeId,
          variantId: line.variantId,
          movementType: 'sale_return' as const,
          quantity: line.quantity,
          referenceType: 'tax_document',
          referenceId: id,
          note: `Cancelled ${String(document.number)}`,
          createdByMemberId: auth.memberId,
        })),
      );
      if (document.totalPaise > 0) {
        await postPartyLedger(tx, [
          {
            organizationId: auth.organization.id,
            // Every issued document has its party (the walk-in party at the least).
            partyId: String(document.partyId),
            storeId: document.storeId,
            entryOn: today,
            entryType: 'cancellation',
            amountPaise: -document.totalPaise,
            referenceType: 'tax_document',
            referenceId: id,
            note: input.reason,
            createdByMemberId: auth.memberId,
          },
        ]);
      }
      return documentView(tx, cancelled);
    });
  }

  private async issueIn(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    input: IssueInvoiceInput,
  ): Promise<TaxDocumentView> {
    const organizationId = auth.organization.id;
    const document = await loadDocument(tx, auth, id, true);
    if (document.status !== 'draft') {
      throw new ConflictException(`This invoice is already ${document.status}`);
    }
    const today = await indiaToday(tx);

    // The registration issuing it; registered stores always have these (stores_registration_complete).
    const [store] = await tx
      .select({
        code: stores.code,
        registrationType: stores.registrationType,
        gstin: sql<string>`${stores.gstin}`,
        stateCode: sql<string>`${stores.stateCode}`,
        legalName: sql<string>`${stores.legalName}`,
        tradeName: stores.tradeName,
        address: sql<
          string | null
        >`nullif(concat_ws(', ', ${stores.addressLine}, ${stores.city}, ${stores.state}, ${stores.pincode}), '')`,
        aatoBand: sql<
          string | null
        >`(select gp.aato_band::text from ${gstinProfiles} gp where gp.gstin = ${stores.gstin})`,
        einvoiceRequired: sql<boolean>`coalesce((select gp.einvoice_required_from <= ${today}::date from ${gstinProfiles} gp where gp.gstin = ${stores.gstin}), false)`,
      })
      .from(stores)
      .where(
        and(eq(stores.id, document.storeId), sql`${stores.registrationType} <> 'unregistered'`),
      );
    if (!store) {
      throw new ConflictException(
        'Register this store for GST (Settings, Tax & GST) before billing',
      );
    }
    const kind = store.registrationType === 'composition' ? 'bill_of_supply' : 'invoice';

    // The buyer: what was typed on the bill, completed from the party.
    const [buyer] = (await tx
      .select({
        name: sql<
          string | null
        >`coalesce(${taxDocuments.buyerName}, ${party.legalName}, ${party.displayName})`,
        gstin: sql<string | null>`coalesce(${taxDocuments.buyerGstin}, ${party.gstin})`,
        address: sql<
          string | null
        >`coalesce(${taxDocuments.buyerAddress}, nullif(concat_ws(', ', ${party.addressLine}, ${party.city}, ${party.state}, ${party.pincode}), ''))`,
        stateCode: sql<
          string | null
        >`coalesce(${taxDocuments.buyerStateCode}, ${party.placeOfSupply})`,
        deliveryStateCode: sql<
          string | null
        >`coalesce(${taxDocuments.shipToStateCode}, ${taxDocuments.buyerStateCode}, ${party.placeOfSupply})`,
      })
      .from(taxDocuments)
      .leftJoin(party, eq(party.id, taxDocuments.partyId))
      .where(eq(taxDocuments.id, id))) as [BuyerSnapshot];

    const lines: DraftLine[] = await tx
      .select({
        id: taxDocumentLines.id,
        variantId: taxDocumentLines.variantId,
        quantity: taxDocumentLines.quantity,
        unitPricePaise: taxDocumentLines.unitPricePaise,
        discountBps: taxDocumentLines.discountBps,
        discountPaise: taxDocumentLines.discountPaise,
        sku: productVariants.sku,
        productName: products.name,
        packSize: productVariants.packSize,
        label: productVariants.label,
        hsnCode: products.hsnCode,
        unit: sql<string>`${productVariants.unit}::text`,
        taxCategoryId: products.taxCategoryId,
      })
      .from(taxDocumentLines)
      .innerJoin(productVariants, eq(productVariants.id, taxDocumentLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(taxDocumentLines.documentId, id))
      .orderBy(asc(taxDocumentLines.lineNo));
    const uncategorised = lines.findIndex((line) => line.taxCategoryId === null);
    if (uncategorised !== -1) {
      throw unprocessable([
        {
          path: `lines.${String(uncategorised)}.variantId`,
          message: 'Give this product a tax category before billing it',
        },
      ]);
    }
    const categoryIds = [...new Set(lines.map((line) => String(line.taxCategoryId)))];
    const rates: GstRate[] = (
      await tx
        .select({
          categoryCode: taxRates.taxCategoryId,
          key: taxCategories.key,
          rateBasisPoints: taxRates.rateBps,
          effectiveFrom: taxRates.effectiveFrom,
          effectiveTo: taxRates.effectiveTo,
        })
        .from(taxRates)
        .innerJoin(taxCategories, eq(taxCategories.id, taxRates.taxCategoryId))
        .where(inArray(taxRates.taxCategoryId, categoryIds))
    ).map(({ key, ...rate }) => ({
      ...rate,
      // A 0% category is exempt when it is the Exempt default, nil-rated otherwise.
      nature: rate.rateBasisPoints > 0 ? 'taxable' : key === 'exempt' ? 'exempt' : 'nil_rated',
      cessBasisPoints: 0,
    }));

    let invoice: Invoice;
    try {
      invoice = computeInvoice({
        invoiceDate: today,
        registration: kind === 'bill_of_supply' ? 'composition' : 'regular',
        parties: {
          supplierStateCode: store.stateCode,
          buyerGstin: buyer.gstin,
          deliveryStateCode: buyer.deliveryStateCode,
          storeStateCode: store.stateCode,
        },
        pricesIncludeTax: document.priceMode === 'inclusive',
        lines: lines.map((line) => ({
          categoryCode: String(line.taxCategoryId),
          quantity: line.quantity,
          unitPricePaise: line.unitPricePaise,
          discount: discountOf(line.discountBps, line.discountPaise),
        })),
        invoiceDiscount: discountOf(document.billDiscountBps, document.billDiscountPaise),
        rates,
        options: DEFAULT_GST_OPTIONS,
      });
    } catch (error) {
      // The engine refuses bad input only with a GstError, whose code names the rule.
      const refusal = error as GstError;
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: refusal.message,
        code: refusal.code,
      });
    }

    const problems: { path: string; message: string }[] = [];
    // HSN digits by the GSTIN's turnover (Notification 78/2020, spec §2.7).
    const digits = requiredHsnDigits(
      store.aatoBand === 'above_5cr' ? ABOVE_5_CRORE_PAISE : 0,
      invoice.buyerType,
    );
    lines.forEach((line, index) => {
      if (!hsnMeetsRequirement(line.hsnCode, digits)) {
        problems.push({
          path: `lines.${String(index)}.variantId`,
          message: `${line.sku} needs an HSN code of at least ${String(digits)} digits`,
        });
      }
    });
    // Rule 46(e): an unregistered buyer's details from ₹50,000 of taxable value.
    if (
      invoice.buyerType === 'b2c' &&
      invoice.totals.taxablePaise >= BUYER_DETAILS_THRESHOLD_PAISE
    ) {
      const details: [string, string | null][] = [
        ['buyer.name', buyer.name],
        ['buyer.address', buyer.address],
        ['buyer.stateCode', buyer.stateCode],
      ];
      for (const [path, value] of details) {
        if (value === null) {
          problems.push({
            path,
            message: 'Required for a bill of ₹50,000 or more to an unregistered buyer',
          });
        }
      }
    }
    // Rule 48(4)-(5): above the threshold a B2B invoice without an IRN is not an invoice.
    if (invoice.buyerType === 'b2b' && store.einvoiceRequired && input.einvoice === undefined) {
      problems.push({
        path: 'einvoice',
        message: 'This GSTIN must e-invoice: enter the IRN and acknowledgement from the portal',
      });
    }
    if (problems.length > 0) throw unprocessable(problems);

    // The number, gap-free per GSTIN, financial year, kind and prefix.
    const series = await this.series(tx, organizationId, document.storeId, store.code, kind);
    const fy = financialYear(today);
    const serial = await nextDocumentNumber(
      tx,
      organizationId,
      `tax:${kind}:${store.gstin}:${fy}:${series.prefix}`,
    );
    const number = formatTaxDocumentNumber(series.prefix, fy, serial, series.digits);

    // Lines and tax rows are written while the document is still a draft.
    for (const [index, line] of lines.entries()) {
      const computed = nth(invoice.lines, index);
      await tx
        .update(taxDocumentLines)
        .set({
          description: `${line.productName} ${variantName(line)}`,
          hsnCode: line.hsnCode,
          uqc: uqcFor(line.unit),
          grossPaise: computed.grossPaise,
          taxablePaise: computed.taxablePaise,
          taxCategoryId: line.taxCategoryId,
          rateBps: computed.rate?.rateBasisPoints ?? null,
          cessBps: computed.rate?.cessBasisPoints ?? null,
          cgstPaise: computed.cgstPaise,
          sgstPaise: computed.sgstPaise,
          igstPaise: computed.igstPaise,
          cessPaise: computed.cessPaise,
          totalPaise: computed.totalPaise,
        })
        .where(eq(taxDocumentLines.id, line.id));
    }
    await this.writeTaxRows(tx, organizationId, id, lines, invoice);

    const partyId = document.partyId ?? (await this.walkInParty(tx, organizationId));
    const totals = invoice.totals;
    const [issued] = (await tx
      .update(taxDocuments)
      .set({
        kind,
        status: 'issued',
        seriesId: series.id,
        number,
        fy,
        issuedOn: today,
        issuedAt: sql`now()`,
        issuedByMemberId: auth.memberId,
        supplierGstin: store.gstin,
        supplierStateCode: store.stateCode,
        supplierLegalName: store.legalName,
        supplierTradeName: store.tradeName,
        supplierAddress: store.address,
        partyId,
        buyerName: buyer.name,
        buyerGstin: buyer.gstin,
        buyerAddress: buyer.address,
        buyerStateCode: buyer.stateCode,
        placeOfSupplyCode: invoice.placeOfSupply,
        supplyType: invoice.supplyType,
        gstClass: gstClassFor(
          buyer.gstin,
          invoice.supplyType === 'inter_state',
          totals.payablePaise,
        ),
        taxablePaise: totals.taxablePaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        igstPaise: totals.igstPaise,
        cessPaise: totals.cessPaise,
        roundOffPaise: totals.roundOffPaise,
        totalPaise: totals.payablePaise,
        dueOn: sql`coalesce(${taxDocuments.dueOn}, ${today}::date)`,
        stockPosting: 'on_issue',
        irn: input.einvoice?.irn,
        ackNo: input.einvoice?.ackNo,
        ackAt: input.einvoice?.ackAt,
        updatedAt: sql`now()`,
      })
      .where(eq(taxDocuments.id, id))
      .returning()) as [TaxDocumentRow];

    // Counter goods leave now, in either stock_post_on mode (spec §4.2).
    await this.assertInStock(tx, document.storeId, lines);
    await postStockMovements(
      tx,
      lines.map((line) => ({
        organizationId,
        storeId: document.storeId,
        variantId: line.variantId,
        movementType: 'sale' as const,
        quantity: -line.quantity,
        referenceType: 'tax_document',
        referenceId: id,
        createdByMemberId: auth.memberId,
      })),
    );
    if (totals.payablePaise > 0) {
      await postPartyLedger(tx, [
        {
          organizationId,
          partyId,
          storeId: document.storeId,
          entryOn: today,
          entryType: 'invoice',
          amountPaise: totals.payablePaise,
          referenceType: 'tax_document',
          referenceId: id,
          note: number,
          createdByMemberId: auth.memberId,
        },
      ]);
    }
    return documentView(tx, issued);
  }

  /**
   * Refuses the issue when the store has less available stock than the bill
   * takes. The balances are locked first, in postStockMovements' order, so the
   * stock cannot fall before it is posted.
   */
  private async assertInStock(
    tx: Transaction,
    storeId: string,
    lines: readonly DraftLine[],
  ): Promise<void> {
    const wanted = new Map<string, number>();
    for (const line of lines) {
      wanted.set(line.variantId, (wanted.get(line.variantId) ?? 0) + line.quantity);
    }
    const balances = await tx
      .select({
        variantId: stockBalances.variantId,
        available: sql<number>`${stockBalances.onHand} - ${stockBalances.reserved}`.mapWith(Number),
      })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.storeId, storeId),
          inArray(stockBalances.variantId, [...wanted.keys()]),
        ),
      )
      .orderBy(asc(stockBalances.variantId))
      .for('update');
    const short = [...wanted].find(
      ([variantId, quantity]) =>
        (balances.find((balance) => balance.variantId === variantId)?.available ?? 0) < quantity,
    );
    if (short) {
      const sku = lines.find((line) => line.variantId === short[0])?.sku;
      throw new ConflictException(`Not enough stock of ${String(sku)} at this store`);
    }
  }

  /** Taxable value and tax per HSN code and rate, from the engine's lines. */
  private async writeTaxRows(
    tx: Transaction,
    organizationId: string,
    documentId: string,
    lines: readonly DraftLine[],
    invoice: Invoice,
  ): Promise<void> {
    const rows = new Map<string, typeof taxDocumentTaxRows.$inferInsert>();
    invoice.lines.forEach((computed, index) => {
      if (computed.rate === null) return;
      const { hsnCode } = nth(lines, index);
      const key = `${hsnCode}|${String(computed.rate.rateBasisPoints)}|${String(computed.rate.cessBasisPoints)}`;
      const row = rows.get(key) ?? {
        organizationId,
        documentId,
        hsnCode,
        rateBps: computed.rate.rateBasisPoints,
        cessBps: computed.rate.cessBasisPoints,
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        cessPaise: 0,
      };
      rows.set(key, {
        ...row,
        taxablePaise: row.taxablePaise + computed.taxablePaise,
        cgstPaise: row.cgstPaise + computed.cgstPaise,
        sgstPaise: row.sgstPaise + computed.sgstPaise,
        igstPaise: row.igstPaise + computed.igstPaise,
        cessPaise: row.cessPaise + computed.cessPaise,
      });
    });
    if (rows.size > 0) await tx.insert(taxDocumentTaxRows).values([...rows.values()]);
  }

  /** The store's active series for `kind`, set up with the default prefix when it has none. */
  private async series(
    tx: Transaction,
    organizationId: string,
    storeId: string,
    storeCode: string,
    kind: 'invoice' | 'bill_of_supply',
  ): Promise<{ id: string; prefix: string; digits: number }> {
    const active = () =>
      tx
        .select({
          id: documentSeries.id,
          prefix: documentSeries.prefix,
          digits: documentSeries.digits,
        })
        .from(documentSeries)
        .where(
          and(
            eq(documentSeries.storeId, storeId),
            eq(documentSeries.kind, kind),
            eq(documentSeries.isActive, true),
          ),
        );
    const [existing] = await active();
    if (existing) return existing;
    const fallback = defaultSeries(storeCode, kind);
    if (fallback === null) {
      throw new BadRequestException(
        `Set up a document series for this store: its code is too long to number ${kind.replaceAll('_', ' ')}s`,
      );
    }
    // Concurrent first bills at a store race to create it; the losers use the winner's.
    await tx
      .insert(documentSeries)
      .values({ organizationId, storeId, kind, ...fallback })
      .onConflictDoNothing();
    const [created] = (await active()) as [{ id: string; prefix: string; digits: number }];
    return created;
  }

  /** The party walk-in sales are billed to, created with the first one (spec §4.6). */
  private async walkInParty(tx: Transaction, organizationId: string): Promise<string> {
    await tx.insert(salesSettings).values({ organizationId }).onConflictDoNothing();
    const [settings] = (await tx
      .select({ walkInPartyId: salesSettings.walkInPartyId })
      .from(salesSettings)
      .for('update')) as [{ walkInPartyId: string | null }];
    if (settings.walkInPartyId !== null) return settings.walkInPartyId;
    const [party] = (await tx
      .insert(parties)
      .values({ organizationId, displayName: 'Walk-in customer', kind: 'person' })
      .returning({ id: parties.id })) as [{ id: string }];
    await tx
      .update(salesSettings)
      .set({ walkInPartyId: party.id, updatedAt: sql`now()` })
      .where(eq(salesSettings.organizationId, organizationId));
    return party.id;
  }
}
