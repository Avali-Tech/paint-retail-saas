import 'reflect-metadata';
import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  adjustPartyAdvance,
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
  aatoTurnoverPaise,
  computeInvoice,
  formatINR,
  gstClassFor,
  hsnMeetsRequirement,
  requiredHsnDigits,
  uqcFor,
  variantName,
  type AatoBand,
  type Discount,
  type GstError,
  type Invoice,
  type InvoicePrintSettings,
  type IssuedInvoiceView,
  type SaleCreditView,
  type TaxDocumentView,
} from '@paint/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import type { CancelInvoiceInput, IssueInvoiceInput } from './billing.schemas.js';
import { paymentView } from '../payments/payment-view.js';
import {
  activeMode,
  checkDetails,
  insertAllocations,
  lockParty,
  paymentStore,
  receivePayment,
  registerSessionFor,
  type PaymentRow,
} from '../payments/posting.js';
import {
  cancelAgainstOrder,
  hasDispatches,
  issueAgainstOrder,
  type OrderIssue,
} from '../orders/order-invoicing.js';
import { gstRatesFor } from './gst-rates.js';
import { earnLoyaltyForInvoice, reverseLoyaltyForCancel } from './loyalty-reversal.js';
import {
  earnInfluencerPoints,
  reverseInfluencerPointsForCancel,
} from '../loyalty/painter-points.js';
import { queuePointsEarned } from '../loyalty/points-notice.js';
import { idempotent } from './idempotency.js';
import { documentView, indiaToday, loadDocument, type TaxDocumentRow } from './invoice-view.js';
import { invoicePrintSettings } from './print-settings.js';
import { takeDocumentNumber } from './series.js';
import { walkInParty } from './walk-in.js';
import { Notifier } from '../notifications/notifier.js';
import { postColorantUse } from '../paint/colorant-use.js';
import { invoiceCreditSubject } from './invoice-credit.js';
import { gateSale, saleCredit } from '../credit/credit-gate.js';

const {
  allocations,
  gstinProfiles,
  payments,
  productVariants,
  products,
  stockBalances,
  stores,
  taxDocumentLines,
  taxDocumentLinks,
  taxDocumentTaxRows,
  taxDocuments,
} = schema;

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
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  issue(
    auth: AuthContext,
    id: string,
    input: IssueInvoiceInput,
    idempotencyKey?: string,
  ): Promise<IssuedInvoiceView> {
    const request = { method: 'POST', path: `/invoices/${id}/issue`, body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, () => this.issueIn(tx, auth, id, input)),
    );
  }

  /** Same-day cancellation of a counter mistake (spec §3.6, [CA-9]); otherwise a credit note. */
  cancel(auth: AuthContext, id: string, input: CancelInvoiceInput): Promise<TaxDocumentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      // The party first, then the document: the order every payment flow locks in.
      const { partyId } = await loadDocument(tx, auth, id);
      if (partyId !== null) await lockParty(tx, auth.organization.id, partyId);
      const document = await loadDocument(tx, auth, id, true);
      if (document.kind === 'credit_note' || document.kind === 'debit_note') {
        throw new ConflictException('A note is never cancelled: raise a note the other way');
      }
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
      if (await hasDispatches(tx, id)) {
        throw new ConflictException(
          'Goods have left on a dispatch of this invoice; raise a credit note instead',
        );
      }
      const [paid] = (await tx
        .select({
          total: sql<number>`coalesce(sum(${allocations.amountPaise}), 0)`.mapWith(Number),
        })
        .from(allocations)
        .where(eq(allocations.documentId, id))) as [{ total: number }];
      if (paid.total !== 0) {
        throw new ConflictException(
          'Payments are allocated to this invoice: undo them first, or raise a credit note',
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
      // Goods billed for dispatch never left: nothing comes back (spec §4.2).
      const returning = document.stockPosting === 'on_issue' ? lines : [];
      await postStockMovements(
        tx,
        returning.map((line) => ({
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
      if (document.salesOrderId !== null) await cancelAgainstOrder(tx, document);
      const reversal = {
        organizationId: auth.organization.id,
        invoiceId: id,
        invoiceNumber: String(document.number),
        memberId: auth.memberId,
      };
      await reverseLoyaltyForCancel(tx, reversal);
      await reverseInfluencerPointsForCancel(tx, reversal);
      return documentView(tx, cancelled);
    });
  }

  /** Where the customer stands for issuing the draft with `unpaidPaise` left unpaid (MVP 3 spec §4.2). */
  creditCheck(auth: AuthContext, id: string, unpaidPaise: number): Promise<SaleCreditView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const document = await loadDocument(tx, auth, id);
      if (document.status !== 'draft') {
        throw new ConflictException(`This invoice is already ${document.status}`);
      }
      if (document.partyId === null) {
        throw new ConflictException('A walk-in bill is paid in full: pick the customer first');
      }
      const subject = await invoiceCreditSubject(tx, document, unpaidPaise, {
        payments: [],
        allocateAdvances: false,
      });
      return saleCredit(
        tx,
        auth.organization.id,
        subject ?? {
          type: 'tax_document',
          id,
          partyId: document.partyId,
          projectId: document.projectId,
          storeId: document.storeId,
          amountPaise: unpaidPaise,
          excludeOrderId: null,
        },
        subject !== null,
      );
    });
  }

  private async issueIn(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    input: IssueInvoiceInput,
  ): Promise<IssuedInvoiceView> {
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
        aatoBand: sql<AatoBand | null>`(select gp.aato_band::text from ${gstinProfiles} gp where gp.gstin = ${stores.gstin})`,
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
    const rates = await gstRatesFor(tx, categoryIds);

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
      aatoTurnoverPaise(store.aatoBand ?? 'up_to_5cr'),
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

    // Money left unpaid is credit: checked against the rules once billing is live (MVP 3 spec §4.2).
    const credit = await this.creditGate(tx, auth, document, invoice.totals.payablePaise, input);

    // A bill from a sales order bills its lines (and consumes or keeps their reservations).
    const order: OrderIssue | null =
      document.salesOrderId === null ? null : await issueAgainstOrder(tx, auth, document, today);

    // The number, gap-free per GSTIN, financial year, kind and prefix.
    const { seriesId, number, fy } = await takeDocumentNumber(
      tx,
      organizationId,
      { id: document.storeId, code: store.code, gstin: store.gstin },
      kind,
      today,
    );

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
          taxNature: computed.rate?.nature ?? null,
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

    const partyId = document.partyId ?? (await walkInParty(tx, organizationId));
    const totals = invoice.totals;
    const [issued] = (await tx
      .update(taxDocuments)
      .set({
        kind,
        status: 'issued',
        seriesId,
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
        dueOn: order?.dueOn ?? sql`coalesce(${taxDocuments.dueOn}, ${today}::date)`,
        stockPosting: order?.postStock === false ? 'on_dispatch' : 'on_issue',
        creditCheck: credit === null ? null : { ...credit.view },
        creditApprovalId: credit?.approvalId ?? null,
        irn: input.einvoice?.irn,
        ackNo: input.einvoice?.ackNo,
        ackAt: input.einvoice?.ackAt,
        updatedAt: sql`now()`,
      })
      .where(eq(taxDocuments.id, id))
      .returning()) as [TaxDocumentRow];

    // Counter goods leave now, in either stock_post_on mode; an order's wait for dispatch (§4.2).
    const leaving = order?.postStock === false ? [] : lines;
    await this.assertInStock(tx, document.storeId, leaving);
    await postStockMovements(
      tx,
      leaving.map((line) => ({
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
    // The colorant in the tinted packs leaves with them (round 8a).
    await postColorantUse(tx, this.notifier, {
      organizationId,
      storeId: document.storeId,
      invoiceId: id,
      invoiceNumber: number,
      referenceType: 'tax_document',
      referenceId: id,
      memberId: auth.memberId,
      lines: leaving.map((line) => ({
        invoiceLineId: line.id,
        quantity: line.quantity,
        lineQuantity: line.quantity,
      })),
    });
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
    await earnLoyaltyForInvoice(tx, {
      organizationId,
      invoiceId: id,
      invoiceNumber: number,
      partyId,
      taxablePaise: totals.taxablePaise,
      issuedOn: today,
      memberId: auth.memberId,
    });
    const painterPoints = await earnInfluencerPoints(tx, {
      organizationId,
      invoiceId: id,
      invoiceNumber: number,
      partyId,
      influencerPartyId: document.influencerPartyId,
      issuedOn: today,
      memberId: auth.memberId,
    });
    if (painterPoints !== null) await queuePointsEarned(tx, painterPoints, auth.memberId);
    const view = await this.takePayments(
      tx,
      auth,
      issued,
      partyId,
      document.partyId === null,
      input,
      await invoicePrintSettings(tx, store.aatoBand),
    );
    if (order?.prepaid && view.outstandingPaise > 0) {
      throw new ConflictException(
        `This order is prepaid: take the full ${formatINR(view.totalPaise)} with the bill (or use advances)`,
      );
    }
    return view;
  }

  /**
   * Whether issuing leaves money on credit, and if so the credit check and the
   * approval that lets it through (MVP 3 spec §4.2–§4.3); null when the bill is
   * not credit: before go-live, a walk-in bill, a bill of a postpaid order
   * (checked at confirm) or one paid in full with the issue.
   */
  private async creditGate(
    tx: Transaction,
    auth: AuthContext,
    document: TaxDocumentRow,
    totalPaise: number,
    input: IssueInvoiceInput,
  ): Promise<{ view: SaleCreditView; approvalId: string | null } | null> {
    const subject = await invoiceCreditSubject(tx, document, totalPaise, input);
    if (subject === null) return null;
    await lockParty(tx, auth.organization.id, subject.partyId);
    const view = await saleCredit(tx, auth.organization.id, subject, true);
    const approvalId = await gateSale(tx, auth, subject, view, input.creditOverride);
    return { view, approvalId };
  }

  /**
   * The payments taken with the issue (spec §4.4, POS walk-in): the party's
   * advances first when asked, then each new payment, all allocated to this
   * invoice in the same transaction. A walk-in bill paid at the counter is
   * paid in full; nothing may be paid beyond the bill (cash change goes back).
   */
  private async takePayments(
    tx: Transaction,
    auth: AuthContext,
    invoice: TaxDocumentRow,
    partyId: string,
    walkIn: boolean,
    input: IssueInvoiceInput,
    print: InvoicePrintSettings,
  ): Promise<IssuedInvoiceView> {
    let outstanding = invoice.totalPaise;
    const target = { documentId: invoice.id, partyLedgerId: null };
    if (input.allocateAdvances && !walkIn) {
      const advances = await tx
        .select({
          id: payments.id,
          left: sql<number>`${payments.amountPaise} - coalesce((select sum(a.amount_paise) from ${allocations} a where a.payment_id = ${sql.raw('"payments"."id"')}), 0)`.mapWith(
            Number,
          ),
        })
        .from(payments)
        .where(
          and(
            eq(payments.partyId, partyId),
            eq(payments.direction, 'in'),
            sql`${payments.chequeStatus} is distinct from 'bounced'`,
            sql`${payments.amountPaise} > coalesce((select sum(a.amount_paise) from ${allocations} a where a.payment_id = ${sql.raw('"payments"."id"')}), 0)`,
          ),
        )
        .orderBy(asc(payments.createdAt), asc(payments.id));
      for (const advance of advances) {
        if (outstanding === 0) break;
        const amountPaise = Math.min(advance.left, outstanding);
        await insertAllocations(tx, auth, partyId, advance.id, [{ ...target, amountPaise }]);
        await adjustPartyAdvance(tx, partyId, -amountPaise);
        outstanding -= amountPaise;
      }
    }
    const requested = input.payments ?? [];
    const paying = requested.reduce((sum, item) => sum + item.amountPaise, 0);
    if (walkIn && input.payments !== undefined && paying !== outstanding) {
      throw unprocessable([
        { path: 'payments', message: `A walk-in bill is paid in full: ${formatINR(outstanding)}` },
      ]);
    }
    if (paying > outstanding) {
      throw unprocessable([
        { path: 'payments', message: `Only ${formatINR(outstanding)} is due on this bill` },
      ]);
    }
    const taken: PaymentRow[] = [];
    if (requested.length > 0) {
      const store = await paymentStore(tx, auth, invoice.storeId, 'storeId');
      for (const [index, item] of requested.entries()) {
        const at = `payments.${String(index)}.`;
        const mode = await activeMode(tx, item.modeId, `${at}modeId`);
        checkDetails(mode, item, at);
        const registerSessionId = await registerSessionFor(
          tx,
          store.id,
          mode.kind,
          item.registerSessionId,
          `${at}registerSessionId`,
        );
        taken.push(
          await receivePayment(
            tx,
            auth,
            {
              store,
              partyId,
              mode,
              details: item,
              receivedOn: String(invoice.issuedOn),
              registerSessionId,
            },
            [{ ...target, amountPaise: item.amountPaise }],
          ),
        );
      }
    }
    const views = [];
    for (const payment of taken) views.push(await paymentView(tx, payment));
    const paidPaise = invoice.totalPaise - outstanding + paying;
    return {
      ...(await documentView(tx, invoice)),
      payments: views,
      paidPaise,
      outstandingPaise: invoice.totalPaise - paidPaise,
      changePaise: views.reduce((sum, view) => sum + (view.changePaise ?? 0), 0),
      print,
    };
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
}
