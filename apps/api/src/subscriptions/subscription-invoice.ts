import { schema, type Transaction } from '@paint/db';
import {
  buildInvoiceView,
  computeInvoice,
  financialYear,
  formatPrintDate,
  formatTaxDocumentNumber,
  PLANS,
  SAAS_GST_RATE_BPS,
  stateCodeFromGstin,
  type BillingInterval,
  type Invoice,
  type InvoiceView,
  type PaidPlanKey,
  type PaymentGatewayName,
  type PrintAddress,
  type PrintBankDetails,
} from '@paint/shared';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { PlatformSupplierConfig, SubscriptionsConfig } from '../config.js';

const { organizations, stores, subscriptionInvoiceSequences, subscriptionInvoices } = schema;
type InvoiceRow = typeof subscriptionInvoices.$inferSelect;
type Party = schema.SubscriptionInvoiceParty;

/** The platform as it prints on its invoices, from configuration. */
export function platformSupplier(platform: PlatformSupplierConfig): Party {
  return {
    legalName: platform.legalName,
    tradeName: null,
    gstin: platform.gstin,
    addressLines: platform.addressLines,
    city: platform.city,
    pincode: platform.pincode,
    stateCode: stateCodeFromGstin(platform.gstin),
    email: platform.email,
    phone: null,
  };
}

/**
 * The business as buyer: its first regular GST registration (by when the store was
 * added), so the invoice is B2B and its input tax credit is claimable; with none,
 * an unregistered buyer in the state of its first store that has one. Platform scope.
 */
export async function subscriptionBuyer(tx: Transaction, organizationId: string): Promise<Party> {
  const [business] = (await tx
    .select({ name: organizations.name, legalName: organizations.legalName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))) as [{ name: string; legalName: string | null }];
  const located = await tx
    .select({
      gstin: stores.gstin,
      registrationType: stores.registrationType,
      legalName: stores.legalName,
      tradeName: stores.tradeName,
      addressLine: stores.addressLine,
      city: stores.city,
      pincode: stores.pincode,
      stateCode: stores.stateCode,
    })
    .from(stores)
    .where(and(eq(stores.organizationId, organizationId), isNotNull(stores.stateCode)))
    .orderBy(asc(stores.createdAt), asc(stores.id));
  const store =
    located.find((row) => row.registrationType === 'regular' && row.gstin !== null) ?? located[0];
  const legalName = store?.legalName ?? business.legalName ?? business.name;
  return {
    legalName,
    tradeName: business.name === legalName ? null : business.name,
    gstin: store?.registrationType === 'regular' ? store.gstin : null,
    addressLines: store?.addressLine ? [store.addressLine] : [],
    city: store?.city ?? null,
    pincode: store?.pincode ?? null,
    stateCode: store?.stateCode ?? null,
    email: null,
    phone: null,
  };
}

/** What an invoice is computed from; a stored invoice reprints from the same. */
export interface SubscriptionInvoiceInput {
  readonly number: string;
  readonly issuedOn: string;
  readonly plan: PaidPlanKey;
  readonly interval: BillingInterval;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly sacCode: string;
  readonly supplier: Party;
  readonly buyer: Party;
  /** India date it is payable by. */
  readonly dueOn: string;
  /** The gateway's payment, printed as a note; null for a manual invoice. */
  readonly paymentReference: string | null;
  /** Where to pay a manual invoice: printed in the bank block; null when paid online. */
  readonly bank: PrintBankDetails | null;
}

/**
 * The invoice through the GST engine: 18% on the plan's price per store, CGST and
 * SGST when the business is in the platform's state, IGST otherwise. No round-off:
 * the gateway collects to the paisa.
 */
export function computeSubscriptionInvoice(input: SubscriptionInvoiceInput): Invoice {
  const supplierState = String(input.supplier.stateCode);
  return computeInvoice({
    invoiceDate: input.issuedOn,
    registration: 'regular',
    parties: {
      supplierStateCode: supplierState,
      buyerGstin: input.buyer.gstin,
      deliveryStateCode: input.buyer.stateCode,
      storeStateCode: supplierState,
    },
    pricesIncludeTax: false,
    lines: [
      {
        categoryCode: 'saas',
        quantity: input.quantity,
        unitPricePaise: input.unitPricePaise,
        discount: null,
      },
    ],
    invoiceDiscount: null,
    rates: [
      {
        categoryCode: 'saas',
        nature: 'taxable',
        rateBasisPoints: SAAS_GST_RATE_BPS,
        cessBasisPoints: 0,
        effectiveFrom: '2017-07-01',
        effectiveTo: null,
      },
    ],
    options: { taxRounding: 'line', roundOff: false },
  });
}

const printAddress = (party: Party): PrintAddress | null =>
  party.stateCode === null
    ? null
    : {
        lines: party.addressLines,
        city: party.city,
        pincode: party.pincode,
        stateCode: party.stateCode,
      };

/** The invoice as the print view the PDF draws (the same as the business's own invoices). */
export function subscriptionInvoiceView(input: SubscriptionInvoiceInput): InvoiceView {
  const invoice = computeSubscriptionInvoice(input);
  const { supplier, buyer } = input;
  return buildInvoiceView(invoice, {
    kind: 'tax_invoice',
    number: input.number,
    issuedOn: input.issuedOn,
    copy: 'original',
    supplier: {
      legalName: supplier.legalName,
      tradeName: null,
      gstin: String(supplier.gstin),
      address: {
        lines: supplier.addressLines,
        city: supplier.city,
        pincode: supplier.pincode,
        stateCode: String(supplier.stateCode),
      },
      phone: supplier.phone,
      email: supplier.email,
    },
    buyer: {
      name: buyer.tradeName === null ? buyer.legalName : `${buyer.legalName} (${buyer.tradeName})`,
      gstin: buyer.gstin,
      address: printAddress(buyer),
      phone: buyer.phone,
    },
    shipTo: null,
    lines: [
      {
        description: `${PLANS[input.plan].name} plan, ${input.interval} subscription per store, ${formatPrintDate(input.periodStart)} to ${formatPrintDate(input.periodEnd)}`,
        variant: null,
        hsnCode: input.sacCode,
        uqc: 'OTH',
        tint: null,
      },
    ],
    // SAC codes are always printed in full.
    aggregateTurnoverPaise: 0,
    reverseCharge: false,
    logoUrl: null,
    notes: [
      input.paymentReference === null
        ? `Payable by ${formatPrintDate(input.dueOn)} by bank transfer or UPI to the account below. Quote ${input.number} as the reference.`
        : `Paid online, payment ${input.paymentReference}.`,
    ],
    terms: ['Software as a service (SAC ' + input.sacCode + '); no goods are supplied.'],
    bank: input.bank,
    signatoryName: null,
    secondLanguage: null,
  });
}

/** What one of our invoices is for; the rest comes from configuration and the business. */
export interface NewSubscriptionInvoice {
  readonly organizationId: string;
  readonly plan: PaidPlanKey;
  readonly interval: BillingInterval;
  readonly quantity: number;
  /** India dates, first and last day of the period invoiced. */
  readonly periodStart: string;
  readonly periodEnd: string;
  /** India date it is payable by; never before the day of issue. */
  readonly dueOn: string;
  readonly gateway: PaymentGatewayName;
  /** The gateway's payment; null for a manual invoice. */
  readonly gatewayPaymentId: string | null;
}

/**
 * Issues our GST invoice, numbered in the platform's series (gap-free per financial
 * year), dated today in India, and stores it; platform scope, in the caller's
 * transaction.
 */
export async function insertSubscriptionInvoice(
  tx: Transaction,
  settings: SubscriptionsConfig,
  spec: NewSubscriptionInvoice,
): Promise<InvoiceRow> {
  const today = await tx.execute<{ on: string }>(
    sql`select ((now() at time zone 'Asia/Kolkata')::date)::text as "on"`,
  );
  const issuedOn = (today.rows[0] as { on: string }).on;
  const { platform } = settings;
  const fy = financialYear(issuedOn);
  const [sequence] = (await tx
    .insert(subscriptionInvoiceSequences)
    .values({ financialYear: fy, lastValue: 1 })
    .onConflictDoUpdate({
      target: subscriptionInvoiceSequences.financialYear,
      set: { lastValue: sql`${subscriptionInvoiceSequences.lastValue} + 1` },
    })
    .returning({ value: subscriptionInvoiceSequences.lastValue })) as [{ value: number }];
  // Rule 46(b): at most 16 characters (PRS/26-27/000001).
  const digits = 16 - 7 - platform.invoicePrefix.length;
  const input: SubscriptionInvoiceInput = {
    number: formatTaxDocumentNumber(platform.invoicePrefix, fy, sequence.value, digits),
    issuedOn,
    plan: spec.plan,
    interval: spec.interval,
    quantity: spec.quantity,
    unitPricePaise: PLANS[spec.plan].prices[spec.interval],
    periodStart: spec.periodStart,
    periodEnd: spec.periodEnd,
    sacCode: platform.sacCode,
    supplier: platformSupplier(platform),
    buyer: await subscriptionBuyer(tx, spec.organizationId),
    // A period invoiced late is payable at once.
    dueOn: spec.dueOn < issuedOn ? issuedOn : spec.dueOn,
    paymentReference: spec.gatewayPaymentId,
    bank: spec.gatewayPaymentId === null ? settings.bank : null,
  };
  const { placeOfSupply, totals } = computeSubscriptionInvoice(input);
  const [row] = (await tx
    .insert(subscriptionInvoices)
    .values({
      organizationId: spec.organizationId,
      number: input.number,
      financialYear: fy,
      serial: sequence.value,
      issuedOn,
      plan: input.plan,
      billingInterval: input.interval,
      storeQuantity: input.quantity,
      unitPricePaise: input.unitPricePaise,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sacCode: input.sacCode,
      rateBps: SAAS_GST_RATE_BPS,
      placeOfSupply,
      taxablePaise: totals.taxablePaise,
      cgstPaise: totals.cgstPaise,
      sgstPaise: totals.sgstPaise,
      igstPaise: totals.igstPaise,
      totalPaise: totals.payablePaise,
      supplier: input.supplier,
      buyer: input.buyer,
      dueOn: input.dueOn,
      gateway: spec.gateway,
      gatewayPaymentId: spec.gatewayPaymentId,
    })
    .returning()) as [InvoiceRow];
  return row;
}

/**
 * A stored invoice as the print view its PDF draws, as issued. A manual invoice
 * prints the platform's bank details as configured now.
 */
export function storedInvoiceView(row: InvoiceRow, bank: PrintBankDetails): InvoiceView {
  return subscriptionInvoiceView({
    number: row.number,
    issuedOn: row.issuedOn,
    plan: row.plan as PaidPlanKey,
    interval: row.billingInterval,
    quantity: row.storeQuantity,
    unitPricePaise: row.unitPricePaise,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    sacCode: row.sacCode,
    supplier: row.supplier,
    buyer: row.buyer,
    dueOn: row.dueOn,
    paymentReference: row.gatewayPaymentId,
    bank: row.gatewayPaymentId === null ? bank : null,
  });
}
