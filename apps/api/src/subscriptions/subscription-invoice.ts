import { schema, type Transaction } from '@paint/db';
import {
  buildInvoiceView,
  computeInvoice,
  formatPrintDate,
  PLANS,
  SAAS_GST_RATE_BPS,
  stateCodeFromGstin,
  type BillingInterval,
  type Invoice,
  type InvoiceView,
  type PaidPlanKey,
  type PrintAddress,
} from '@paint/shared';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { PlatformSupplierConfig } from '../config.js';

const { organizations, stores } = schema;
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
  /** The gateway's payment, printed as a note. */
  readonly paymentReference: string;
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
    notes: [`Paid online, payment ${input.paymentReference}.`],
    terms: ['Software as a service (SAC ' + input.sacCode + '); no goods are supplied.'],
    bank: null,
    signatoryName: null,
    secondLanguage: null,
  });
}
