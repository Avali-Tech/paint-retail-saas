import {
  DEFAULT_GST_OPTIONS,
  buildInvoiceView,
  computeInvoice,
  type Discount,
  type GstRate,
  type InvoiceView,
  type PrintAddress,
  type SecondLanguage,
  type TaxDocumentView,
} from '@paint/shared';

// An issued bill as round 2b's templates print it. The issue snapshots every line's
// rate, price and discount, so the engine's `Invoice` is worked out again from the
// document (the same inputs give the same figures), then joined to its header data.

const discountOf = (bps: number | null, paise: number | null): Discount | null => {
  if (bps !== null) return { kind: 'percent', basisPoints: bps };
  return paise === null ? null : { kind: 'amount', paise };
};

const address = (text: string | null, stateCode: string): PrintAddress => ({
  lines: text === null ? [] : [text],
  city: null,
  pincode: null,
  stateCode,
});

/** The print view of an issued invoice or bill of supply, labels also in `secondLanguage`. */
export function printViewOf(
  document: TaxDocumentView,
  secondLanguage: SecondLanguage | null,
): InvoiceView {
  // An issued document always has its supplier snapshot, number, date and place of supply.
  const supplierState = String(document.supplier.stateCode);
  const placeOfSupply = String(document.placeOfSupplyCode);
  const composition = document.kind === 'bill_of_supply';
  const code = (rateBps: number | null) => `rate:${String(rateBps)}`;
  const rates: GstRate[] = document.lines.map((line) => ({
    categoryCode: code(line.rateBps),
    nature: Number(line.rateBps) > 0 ? 'taxable' : 'nil_rated',
    rateBasisPoints: Number(line.rateBps),
    cessBasisPoints: 0,
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  }));
  const invoice = computeInvoice({
    invoiceDate: String(document.issuedOn),
    registration: composition ? 'composition' : 'regular',
    parties: {
      supplierStateCode: supplierState,
      buyerGstin: document.buyer.gstin,
      // The issue fixed the place of supply; a B2C one is given as the delivery state.
      deliveryStateCode: placeOfSupply,
      storeStateCode: supplierState,
    },
    pricesIncludeTax: document.priceMode === 'inclusive',
    lines: document.lines.map((line) => ({
      categoryCode: code(line.rateBps),
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      discount: discountOf(line.discountBps, line.discountPaise),
    })),
    invoiceDiscount: discountOf(document.billDiscountBps, document.billDiscountPaise),
    // Rows repeat for lines at the same rate; the engine wants one per category.
    rates: rates.filter(
      (rate, index) =>
        rates.findIndex((other) => other.categoryCode === rate.categoryCode) === index,
    ),
    options: DEFAULT_GST_OPTIONS,
  });
  return buildInvoiceView(invoice, {
    kind: composition ? 'bill_of_supply' : 'tax_invoice',
    number: String(document.number),
    issuedOn: String(document.issuedOn),
    // A counter receipt carries no copy mark ([CA-2]).
    copy: null,
    supplier: {
      legalName: String(document.supplier.legalName),
      tradeName: document.supplier.tradeName,
      gstin: String(document.supplier.gstin),
      address: address(document.supplier.address, supplierState),
      phone: null,
      email: null,
    },
    buyer: {
      name: document.buyer.name,
      gstin: document.buyer.gstin,
      address:
        document.buyer.address === null
          ? null
          : address(document.buyer.address, document.buyer.stateCode ?? placeOfSupply),
      phone: null,
    },
    shipTo: null,
    lines: document.lines.map((line) => ({
      description: String(line.description),
      // The issue writes the pack size or label into the description.
      variant: null,
      hsnCode: String(line.hsnCode),
      uqc: String(line.uqc),
    })),
    // Not known at the counter: the HSN digits rule is checked when the bill is issued.
    aggregateTurnoverPaise: 0,
    reverseCharge: document.reverseCharge,
    logoUrl: null,
    notes: [],
    terms: [],
    bank: null,
    signatoryName: null,
    secondLanguage,
  });
}
