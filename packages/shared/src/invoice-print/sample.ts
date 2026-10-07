import { at } from '../gst/arith.js';
import { computeInvoice, type InvoiceInput } from '../gst/invoice.js';
import type { LineInput } from '../gst/line.js';
import { DEFAULT_GST_OPTIONS, type GstRate } from '../gst/types.js';
import type { SecondLanguage } from './labels.js';
import type { CopyMark, InvoiceDocumentInput, InvoiceView, PrintLineDetail } from './types.js';
import { buildInvoiceView } from './view-model.js';

/**
 * A sample counter sale for print previews and template tests, until round 3
 * prints issued invoices: paint packs and hardware sizes at an illustrative 18%,
 * from a fictional Hyderabad shop.
 */
export interface SampleInvoiceOptions {
  readonly kind?: 'tax_invoice' | 'bill_of_supply';
  /** b2b: a registered contractor in Telangana; b2b_inter: one in Maharashtra; b2c: a walk-in. */
  readonly buyer?: 'b2b' | 'b2b_inter' | 'b2c';
  /** Repeats the items to this many lines, to show page breaks. */
  readonly lineCount?: number;
  readonly secondLanguage?: SecondLanguage | null;
  readonly copy?: CopyMark | null;
  /** The white-label business name and logo, e.g. the signed-in business's. */
  readonly businessName?: string;
  readonly logoUrl?: string | null;
}

const RATES: readonly GstRate[] = [
  {
    categoryCode: 'gst18',
    nature: 'taxable',
    rateBasisPoints: 1800,
    cessBasisPoints: 0,
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
];

const ITEMS: readonly (PrintLineDetail & Omit<LineInput, 'categoryCode'>)[] = [
  item('Asian Paints Apex Ultima', '10 l', '32091090', 2, 6_450_00),
  {
    ...item('Asian Paints Tractor Emulsion', '4 l', '32091090', 3, 1_180_00),
    discount: { kind: 'percent', basisPoints: 500 },
  },
  item('Birla Opus Wall Putty', '20 kg', '32141000', 1, 980_00),
  item('Asian Paints Paint Brush', '4 inch', '96034020', 2, 145_00),
  item('Roller with Handle', '9 inch', '96034090', 1, 320_00),
  item('Masking Tape', '24 mm', '39191000', 4, 55_00),
];

function item(
  description: string,
  variant: string,
  hsnCode: string,
  quantity: number,
  unitPricePaise: number,
) {
  return { description, variant, hsnCode, uqc: 'NOS', quantity, unitPricePaise, discount: null };
}

const BUYERS = {
  b2b: {
    name: 'Ravi Constructions',
    gstin: '36AAACT9876Q1Z9',
    address: {
      lines: ['Plot 14, Madhapur'],
      city: 'Hyderabad',
      pincode: '500081',
      stateCode: '36',
    },
    phone: '+91 98480 12345',
  },
  b2b_inter: {
    name: 'Rao Builders',
    gstin: '27AAFCR5678K1ZP',
    address: { lines: ['FC Road, Shivajinagar'], city: 'Pune', pincode: '411005', stateCode: '27' },
    phone: null,
  },
  b2c: { name: null, gstin: null, address: null, phone: null },
} as const;

/** The engine input and the document header for the sample. */
export function sampleInvoice(options: SampleInvoiceOptions = {}): {
  input: InvoiceInput;
  document: InvoiceDocumentInput;
} {
  const kind = options.kind ?? 'tax_invoice';
  const buyer = BUYERS[options.buyer ?? 'b2b'];
  const count = options.lineCount ?? ITEMS.length;
  const items = Array.from({ length: count }, (_, index) => at(ITEMS, index % ITEMS.length));
  const input: InvoiceInput = {
    invoiceDate: '2026-10-07',
    registration: kind === 'tax_invoice' ? 'regular' : 'composition',
    parties: {
      supplierStateCode: '36',
      buyerGstin: buyer.gstin,
      deliveryStateCode: null,
      storeStateCode: '36',
    },
    pricesIncludeTax: true,
    lines: items.map((line) => ({
      categoryCode: 'gst18',
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      discount: line.discount,
    })),
    invoiceDiscount: null,
    rates: RATES,
    options: DEFAULT_GST_OPTIONS,
  };
  const document: InvoiceDocumentInput = {
    kind,
    number: kind === 'tax_invoice' ? 'AMP/26-27/00123' : 'AMP/BS/26-27/045',
    issuedOn: '2026-10-07',
    copy: options.copy === undefined ? 'original' : options.copy,
    supplier: {
      legalName: 'Sharma Paints and Hardware Private Limited',
      tradeName: options.businessName ?? 'Sharma Paints & Hardware',
      gstin: '36AAKFS4821M1ZR',
      address: {
        lines: ['8-3-214, Ameerpet Main Road'],
        city: 'Hyderabad',
        pincode: '500016',
        stateCode: '36',
      },
      phone: '+91 40 2373 4455',
      email: 'billing@sharmapaints.example',
    },
    buyer,
    shipTo: null,
    lines: items.map(({ description, variant, hsnCode, uqc }) => ({
      description,
      variant,
      hsnCode,
      uqc,
    })),
    aggregateTurnoverPaise: 3_00_00_000_00,
    reverseCharge: false,
    logoUrl: options.logoUrl ?? null,
    notes: ['Goods once tinted cannot be returned.'],
    terms: ['Payment due within 15 days.', 'Subject to Hyderabad jurisdiction.'],
    bank: {
      bankName: 'State Bank of India, Ameerpet',
      accountName: 'Sharma Paints and Hardware Pvt Ltd',
      accountNumber: '30451234567',
      ifsc: 'SBIN0020345',
      upiId: 'sharmapaints@sbi',
    },
    signatoryName: 'Rajesh Sharma',
    secondLanguage: options.secondLanguage ?? null,
  };
  return { input, document };
}

/** The sample as a print-ready view. */
export function sampleInvoiceView(options: SampleInvoiceOptions = {}): InvoiceView {
  const { input, document } = sampleInvoice(options);
  return buildInvoiceView(computeInvoice(input), document);
}
