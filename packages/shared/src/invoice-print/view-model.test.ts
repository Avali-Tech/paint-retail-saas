import { describe, expect, it } from 'vitest';
import { computeInvoice, type InvoiceInput } from '../gst/invoice.js';
import { sampleInvoice, sampleInvoiceView } from './sample.js';
import type { InvoiceDocumentInput } from './types.js';
import { InvoicePrintError, buildInvoiceView } from './view-model.js';

/** The sample, changed: engine input first, then the document. */
function view(
  options: Parameters<typeof sampleInvoice>[0],
  change: {
    input?: (input: InvoiceInput) => InvoiceInput;
    document?: (document: InvoiceDocumentInput) => InvoiceDocumentInput;
  } = {},
) {
  const { input, document } = sampleInvoice(options);
  const invoice = computeInvoice(change.input ? change.input(input) : input);
  return buildInvoiceView(invoice, change.document ? change.document(document) : document);
}

const WALK_IN_ADDRESS = {
  lines: ['House 9, Kukatpally'],
  city: 'Hyderabad',
  pincode: '500072',
  stateCode: '36',
};

describe('buildInvoiceView', () => {
  it('prints a B2B intra-state tax invoice with every Rule 46 field', () => {
    const printed = sampleInvoiceView();

    expect(printed.kind).toBe('tax_invoice');
    expect(printed.title).toEqual({ text: 'Tax Invoice', translation: null });
    expect(printed.compositionNotice).toBeNull();
    expect(printed.copyMark).toBe('ORIGINAL FOR RECIPIENT');
    expect(printed.business).toEqual({ name: 'Sharma Paints & Hardware', logoUrl: null });
    expect(printed.supplier).toEqual({
      name: 'Sharma Paints and Hardware Private Limited',
      legalName: 'Sharma Paints and Hardware Private Limited',
      gstin: '36AAKFS4821M1ZR',
      addressLines: ['8-3-214, Ameerpet Main Road', 'Hyderabad 500016'],
      state: 'Telangana (36)',
      phone: '+91 40 2373 4455',
      email: 'billing@sharmapaints.example',
    });
    expect(printed.buyer).toEqual({
      name: 'Ravi Constructions',
      gstin: '36AAACT9876Q1Z9',
      registered: true,
      addressLines: ['Plot 14, Madhapur', 'Hyderabad 500081'],
      state: 'Telangana (36)',
      phone: '+91 98480 12345',
    });
    expect(printed.shipTo).toBeNull();
    expect(printed.number).toBe('AMP/26-27/00123');
    expect(printed.date).toBe('07 Oct 2026');
    expect(printed.placeOfSupply).toBe('Telangana (36)');
    expect(printed.supplyType).toBe('intra_state');
    expect(printed.buyerType).toBe('b2b');
    expect(printed.gstClass).toBe('b2b');
    expect(printed.reverseCharge).toBe('No');
    expect(printed.pricesIncludeTax).toBe(true);
    expect(printed.taxColumns).toEqual([
      { key: 'cgst', label: 'CGST' },
      { key: 'sgst', label: 'SGST' },
    ]);
    expect(printed.lines[0]).toEqual({
      serial: 1,
      description: 'Asian Paints Apex Ultima',
      variant: '10 l',
      hsn: '32091090',
      quantity: '2',
      uqc: 'NOS',
      price: '6,450.00',
      discount: null,
      taxable: '10,932.20',
      rate: '18%',
      taxes: { cgst: '983.90', sgst: '983.90' },
      amount: '12,900.00',
      tint: {
        shade: 'X 132 · Ivory Mist',
        base: 'Apex Ultima Pastel Base',
        formula: 'XY 12 ml, R 3 shot',
      },
    });
    expect(printed.lines[1]?.tint).toBeNull();
    expect(printed.lines[1]?.discount).toBe('177.00');
    expect(printed.lines[3]?.variant).toBe('4 inch');
    expect(printed.taxSummary).toEqual([
      {
        rate: '18%',
        taxable: '15,316.08',
        taxes: { cgst: '1,378.46', sgst: '1,378.46' },
        totalTax: '2,756.92',
      },
    ]);
    expect(printed.totals.map((row) => [row.key, row.label.text, row.amount])).toEqual([
      ['discount', 'Discount', '-177.00'],
      ['subtotal', 'Taxable value', '15,316.08'],
      ['cgst', 'CGST', '1,378.46'],
      ['sgst', 'SGST', '1,378.46'],
      ['roundOff', 'Round off', '0.00'],
      ['grandTotal', 'Total', '18,073.00'],
    ]);
    expect(printed.grandTotal).toBe('₹18,073.00');
    expect(printed.amountInWords).toBe('Rupees Eighteen Thousand Seventy-Three Only');
    expect(printed.notes).toEqual(['Goods once tinted cannot be returned.']);
    expect(printed.terms).toHaveLength(2);
    expect(printed.bank?.ifsc).toBe('SBIN0020345');
    expect(printed.signatory).toEqual({
      forLine: 'For Sharma Paints and Hardware Private Limited',
      name: 'Rajesh Sharma',
    });
    expect(printed.requirements).toEqual({
      buyerGstin: true,
      buyerDetails: true,
      deliveryAddress: false,
      hsnDigits: 4,
      placeOfSupply: false,
      reverseChargeLine: true,
      compositionNotice: false,
    });
    expect(printed.issues).toEqual([]);
  });

  it('prints IGST and requires the place of supply on an inter-state invoice', () => {
    const printed = sampleInvoiceView({ buyer: 'b2b_inter', copy: 'duplicate' });

    expect(printed.copyMark).toBe('DUPLICATE FOR TRANSPORTER');
    expect(printed.placeOfSupply).toBe('Maharashtra (27)');
    expect(printed.supplyType).toBe('inter_state');
    expect(printed.taxColumns).toEqual([{ key: 'igst', label: 'IGST' }]);
    expect(printed.lines[0]?.taxes).toEqual({ igst: '1,967.80' });
    expect(printed.requirements.placeOfSupply).toBe(true);
    expect(printed.buyer.phone).toBeNull();
  });

  it('labels the state half UTGST in a union territory without a legislature', () => {
    const printed = view(
      {},
      {
        input: (input) => ({
          ...input,
          lines: input.lines.map((line) => ({ ...line, discount: null })),
          parties: {
            supplierStateCode: '04',
            buyerGstin: null,
            deliveryStateCode: null,
            storeStateCode: '04',
          },
        }),
        document: (document) => ({
          ...document,
          buyer: { name: null, gstin: null, address: null, phone: null },
        }),
      },
    );

    expect(printed.taxColumns).toEqual([
      { key: 'cgst', label: 'CGST' },
      { key: 'sgst', label: 'UTGST' },
    ]);
    expect(printed.totals.map((row) => row.label.text)).toEqual([
      'Taxable value',
      'CGST',
      'UTGST',
      'Round off',
      'Total',
    ]);
  });

  it('prints a cess column only when there is cess, and names untaxed lines', () => {
    const printed = view(
      {},
      {
        input: (input) => ({
          ...input,
          rates: [
            {
              categoryCode: 'gst18',
              nature: 'taxable',
              rateBasisPoints: 1800,
              cessBasisPoints: 100,
              effectiveFrom: '2017-07-01',
              effectiveTo: null,
            },
            {
              categoryCode: 'exempt',
              nature: 'exempt',
              rateBasisPoints: 0,
              cessBasisPoints: 0,
              effectiveFrom: '2017-07-01',
              effectiveTo: null,
            },
          ],
          lines: input.lines.map((line, index) =>
            index === 5 ? { ...line, categoryCode: 'exempt' } : line,
          ),
        }),
      },
    );

    expect(printed.taxColumns.map((column) => column.key)).toEqual(['cgst', 'sgst', 'cess']);
    expect(printed.lines[5]?.rate).toBe('Exempt');
    expect(printed.taxSummary.map((row) => row.rate)).toEqual(['Exempt', '18%']);
    expect(printed.totals.map((row) => row.key)).toContain('cess');
  });

  it('prints a walk-in sale under ₹50,000 without buyer details, as B2C small', () => {
    const printed = sampleInvoiceView({ buyer: 'b2c', copy: 'triplicate' });

    expect(printed.copyMark).toBe('TRIPLICATE FOR SUPPLIER');
    expect(printed.buyer).toEqual({
      name: 'Walk-in customer',
      gstin: null,
      registered: false,
      addressLines: [],
      state: null,
      phone: null,
    });
    expect(printed.gstClass).toBe('b2cs');
    expect(printed.requirements.buyerDetails).toBe(false);
    expect(printed.requirements.hsnDigits).toBe(0);
    expect(printed.issues).toEqual([]);
  });

  it('asks for an unregistered buyer’s name, address and delivery address from ₹50,000', () => {
    const printed = sampleInvoiceView({ buyer: 'b2c', lineCount: 24 });

    expect(printed.requirements).toMatchObject({ buyerDetails: true, deliveryAddress: true });
    expect(printed.issues).toEqual([
      { code: 'buyer_name', clause: '46(e)', line: null },
      { code: 'buyer_address', clause: '46(e)', line: null },
      { code: 'delivery_address', clause: '46(e)', line: null },
    ]);

    const complete = view(
      { buyer: 'b2c', lineCount: 24 },
      {
        document: (document) => ({
          ...document,
          buyer: { name: 'Lakshmi Devi', gstin: null, address: WALK_IN_ADDRESS, phone: null },
        }),
      },
    );
    expect(complete.issues).toEqual([]);
    expect(complete.buyer.state).toBe('Telangana (36)');
  });

  it('takes the ship-to address as the delivery address', () => {
    const printed = view(
      { buyer: 'b2c', lineCount: 24 },
      {
        document: (document) => ({
          ...document,
          buyer: { name: '  ', gstin: null, address: null, phone: null },
          shipTo: WALK_IN_ADDRESS,
        }),
      },
    );

    expect(printed.shipTo).toEqual({
      addressLines: ['House 9, Kukatpally', 'Hyderabad 500072'],
      state: 'Telangana (36)',
    });
    expect(printed.issues.map((issue) => issue.code)).toEqual(['buyer_name', 'buyer_address']);
  });

  it('marks an unregistered inter-state sale above ₹1,00,000 as B2C large', () => {
    const delivered = (lineCount: number) =>
      view(
        { buyer: 'b2c', lineCount },
        {
          input: (input) => ({
            ...input,
            parties: { ...input.parties, deliveryStateCode: '27' },
          }),
        },
      );

    expect(delivered(40).gstClass).toBe('b2cl');
    expect(delivered(6).gstClass).toBe('b2cs');
  });

  it('asks for the HSN digits the turnover requires', () => {
    const printed = view(
      {},
      {
        document: (document) => ({
          ...document,
          aggregateTurnoverPaise: 6_00_00_000_00,
          lines: document.lines.map((line, index) =>
            index === 2 ? { ...line, hsnCode: '3214' } : line,
          ),
        }),
      },
    );

    expect(printed.requirements.hsnDigits).toBe(6);
    expect(printed.issues).toEqual([{ code: 'hsn_digits', clause: '46(g)', line: 2 }]);
  });

  it('asks for a B2B buyer’s name and address under 46(d), and a valid serial number', () => {
    const printed = view(
      {},
      {
        document: (document) => ({
          ...document,
          number: 'amp/26-27/00123',
          buyer: { ...document.buyer, name: null, address: null },
        }),
      },
    );

    expect(printed.buyer.name).toBe('Walk-in customer');
    expect(printed.issues).toEqual([
      { code: 'number_format', clause: '46(b)', line: null },
      { code: 'buyer_name', clause: '46(d)', line: null },
      { code: 'buyer_address', clause: '46(d)', line: null },
    ]);
    expect(view({}, { document: (d) => ({ ...d, number: 'AMP/2026-27/000123' }) }).issues).toEqual([
      { code: 'number_format', clause: '46(b)', line: null },
    ]);
  });

  it('prints a bill of supply with the composition notice and no tax', () => {
    const printed = sampleInvoiceView({ kind: 'bill_of_supply', buyer: 'b2c' });

    expect(printed.title.text).toBe('Bill of Supply');
    expect(printed.compositionNotice).toBe(
      'Composition taxable person, not eligible to collect tax on supplies',
    );
    expect(printed.reverseCharge).toBeNull();
    expect(printed.taxColumns).toEqual([]);
    expect(printed.taxSummary).toEqual([]);
    expect(printed.lines[0]?.rate).toBeNull();
    expect(printed.lines[0]?.taxes).toEqual({});
    expect(printed.totals.map((row) => [row.key, row.label.text, row.amount])).toEqual([
      ['discount', 'Discount', '-177.00'],
      ['subtotal', 'Value', '18,073.00'],
      ['roundOff', 'Round off', '0.00'],
      ['grandTotal', 'Total', '18,073.00'],
    ]);
    expect(printed.requirements).toMatchObject({
      reverseChargeLine: false,
      compositionNotice: true,
    });
  });

  it('prints reverse charge, the legal name without a trade name, and a second language', () => {
    const printed = view(
      { secondLanguage: 'hi', copy: null, logoUrl: '/logo.png' },
      {
        input: (input) => ({ ...input, invoiceDiscount: { kind: 'amount', paise: 73_00 } }),
        document: (document) => ({
          ...document,
          reverseCharge: true,
          supplier: { ...document.supplier, tradeName: null },
        }),
      },
    );

    expect(printed.reverseCharge).toBe('Yes');
    expect(printed.copyMark).toBeNull();
    expect(printed.business).toEqual({
      name: 'Sharma Paints and Hardware Private Limited',
      logoUrl: '/logo.png',
    });
    expect(printed.secondLanguage).toBe('hi');
    expect(printed.title.translation).toBe('टैक्स इनवॉइस');
    expect(printed.labels.amountInWords.translation).toBe('रकम शब्दों में');
    expect(printed.totals[0]).toEqual({
      key: 'discount',
      label: { text: 'Discount', translation: 'छूट' },
      amount: '-250.00',
    });
    expect(printed.lines[0]?.discount).toBe('52.11');
    expect(printed.grandTotal).toBe('₹18,000.00');
  });

  it('refuses document data that does not belong to the invoice', () => {
    const { input, document } = sampleInvoice();
    const invoice = computeInvoice(input);
    const refused = (changed: InvoiceDocumentInput) => {
      try {
        buildInvoiceView(invoice, changed);
      } catch (error) {
        return error instanceof InvoicePrintError ? [error.code, error.message] : error;
      }
      return null;
    };

    expect(refused({ ...document, kind: 'bill_of_supply' })).toEqual([
      'kind_mismatch',
      'A tax_invoice cannot print as a bill_of_supply',
    ]);
    expect(refused({ ...document, buyer: { ...document.buyer, gstin: null } })).toEqual([
      'buyer_mismatch',
      'The buyer GSTIN must be given exactly when the invoice is B2B',
    ]);
    expect(refused({ ...document, lines: document.lines.slice(1) })).toEqual([
      'line_mismatch',
      'The invoice has 6 lines, the document 5',
    ]);
    expect(refused(document)).toBeNull();
  });
});
