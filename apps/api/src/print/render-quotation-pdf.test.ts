import type { LineTintView, QuotationView, SalesLineView } from '@paint/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { renderQuotationPdf, type QuotationPdfStore } from './render-quotation-pdf.js';

async function read(pdf: Buffer) {
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const { totalPages, text } = await extractText(document);
  const info = (await document.getMetadata()).info as Record<string, unknown>;
  return {
    totalPages,
    pages: text.map((page) => page.replace(/\s+/g, ' ')),
    text: text.join(' ').replace(/\s+/g, ' '),
    title: info.Title,
  };
}

const line = (overrides: Partial<SalesLineView> = {}): SalesLineView => ({
  id: 'ql-1',
  lineNo: 1,
  variantId: 'v-1',
  sku: 'APX-20L',
  description: 'Asian Paints Apex Ultima 20 l',
  hsnCode: '3209',
  quantity: 2,
  unitPricePaise: 5_000_00,
  discountBps: 1000,
  discountPaise: null,
  taxablePaise: 7_627_12,
  rateBps: 1800,
  cgstPaise: 686_44,
  sgstPaise: 686_44,
  igstPaise: 0,
  cessPaise: 0,
  totalPaise: 9_000_00,
  ...overrides,
});

const TINT: LineTintView = {
  id: 'tint-1',
  brand: { id: 'brand-asian', name: 'Asian Paints' },
  shadeCode: 'X 132',
  shadeName: 'Ivory Mist',
  packQuantity: 2,
  colorantCostPaise: null,
  tintChargePaise: 0,
  machine: null,
  formula: [{ colorant: 'XY', amount: 12, unit: 'ml' }],
  note: null,
  createdAt: '2026-10-08T05:00:00.000Z',
};

const QUOTE: QuotationView = {
  priceMode: 'inclusive',
  billDiscountBps: null,
  billDiscountPaise: null,
  placeOfSupplyCode: '36',
  supplyType: 'intra_state',
  taxablePaise: 12_711_87,
  cgstPaise: 1_144_07,
  sgstPaise: 1_144_06,
  igstPaise: 0,
  cessPaise: 0,
  roundOffPaise: 0,
  totalPaise: 15_000_00,
  id: 'quote-2',
  number: 'QT-000042',
  version: 2,
  rootQuotationId: 'quote-1',
  status: 'sent',
  storeId: 'store-amp',
  billTo: { id: 'p1', name: 'Apex Builders', gstin: '36AABCU9603R1ZO', phone: '9876543210' },
  influencer: { id: 'p2', name: 'Ramesh Painter' },
  project: { id: 'pr1', name: 'Madhapur Villa' },
  shipTo: { name: 'Site office', address: 'Plot 12, Madhapur', stateCode: '36' },
  validUntil: '2026-10-22',
  pricedOn: '2026-10-08',
  note: 'Delivery after 5 pm',
  sentAt: '2026-10-08T06:00:00.000Z',
  acceptedAt: null,
  salesOrderId: null,
  createdByMemberId: 'member-1',
  createdAt: '2026-10-08T05:00:00.000Z',
  updatedAt: '2026-10-08T05:00:00.000Z',
  lines: [
    line({ tint: TINT }),
    line({
      id: 'ql-2',
      lineNo: 2,
      description: 'Godrej Hinge 4 inch',
      hsnCode: '8302',
      quantity: 10.5,
      unitPricePaise: 600_00,
      discountBps: null,
      discountPaise: 50_00,
      taxablePaise: 5_084_75,
      cgstPaise: 457_63,
      sgstPaise: 457_62,
      totalPaise: 6_000_00,
    }),
  ],
  versions: [],
};

const STORE: QuotationPdfStore = {
  name: 'Ameerpet',
  legalName: 'Rangoli Paints Private Limited',
  tradeName: 'Rangoli Paints & Hardware',
  gstin: '36AABCS1429B1ZB',
  address: '1-2-3 Main Road, Hyderabad, Telangana, 500016',
};

describe('renderQuotationPdf', () => {
  it('draws a quotation, not a tax invoice, with its version, validity, parties, lines and totals', async () => {
    const pdf = await renderQuotationPdf(QUOTE, STORE);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { totalPages, text, title } = await read(pdf);
    expect(totalPages).toBe(1);
    expect(title).toBe('Quotation QT-000042 v2');
    for (const expected of [
      'Rangoli Paints & Hardware',
      'Rangoli Paints Private Limited',
      '1-2-3 Main Road, Hyderabad, Telangana, 500016',
      'GSTIN: 36AABCS1429B1ZB',
      'Quotation',
      'QT-000042 v2',
      'Quotation no.',
      'Version',
      '08 Oct 2026',
      'Valid until',
      '22 Oct 2026',
      'Telangana (36)',
      'Bill to',
      'Apex Builders',
      'GSTIN: 36AABCU9603R1ZO',
      'Phone: 9876543210',
      'Site',
      'Madhapur Villa',
      'Plot 12, Madhapur',
      'Influencer',
      'Ramesh Painter',
      'Rate (incl. GST)',
      'Discount',
      '10%',
      '₹50.00',
      '10.5',
      'Godrej Hinge 4 inch',
      'Tint X 132 · Ivory Mist · XY 12 ml',
      '₹1,372.88',
      'CGST',
      'SGST',
      'Round off',
      '₹15,000.00',
      'Rupees Fifteen Thousand Only',
      'Delivery after 5 pm',
      'This is a quotation, not a tax invoice.',
      'Page 1 of 1',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('Tax Invoice');
    expect(text).not.toContain('IGST');
  });

  it('adds Hindi under the labels, and leaves out what a plain quote does not have', async () => {
    const { text } = await read(
      await renderQuotationPdf(
        {
          ...QUOTE,
          priceMode: 'exclusive',
          supplyType: 'inter_state',
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 2_288_13,
          cessPaise: 100,
          billTo: { ...QUOTE.billTo, gstin: null, phone: null },
          influencer: null,
          project: null,
          shipTo: { name: null, address: null, stateCode: null },
          note: null,
          lines: [
            line({
              discountBps: null,
              discountPaise: 0,
              hsnCode: null,
              rateBps: null,
              tint: { ...TINT, shadeName: null, formula: [] },
            }),
            line({ id: 'ql-2', lineNo: 2, discountBps: null, discountPaise: null }),
          ],
        },
        { name: 'Ameerpet', legalName: null, tradeName: null, gstin: null, address: null },
        'hi',
      ),
    );
    for (const expected of ['Ameerpet', 'तारीख', 'IGST', 'Cess', 'पेज 1 / 1', 'Tint X 132']) {
      expect(text).toContain(expected);
    }
    expect(text).toContain('Rate ');
    expect(text).not.toContain('Rate (incl. GST)');
    for (const absent of ['Discount', 'Influencer', 'Site', 'Notes', 'CGST', 'GSTIN:', 'XY 12']) {
      expect(text).not.toContain(absent);
    }
  });

  it('names the store by its legal name when it has no trade name', async () => {
    const { text } = await read(
      await renderQuotationPdf(QUOTE, { ...STORE, tradeName: null, legalName: 'Rangoli LLP' }),
    );
    expect(text).toContain('Rangoli LLP');
    expect(text).not.toContain('Rangoli Paints & Hardware');
  });

  // 70 lines in Telugu take a few seconds alone and more under load: room as for the invoice PDF.
  it(
    'continues a long quotation on numbered pages in Telugu, each with the column headings',
    { timeout: 30_000 },
    async () => {
      const lines = Array.from({ length: 70 }, (_, index) =>
        line({
          id: `ql-${String(index)}`,
          lineNo: index + 1,
          description: `Item ${String(index + 1)}`,
        }),
      );
      const { totalPages, pages, text } = await read(
        await renderQuotationPdf({ ...QUOTE, lines, note: 'Long note\n'.repeat(40) }, STORE, 'te'),
      );
      expect(totalPages).toBeGreaterThan(1);
      expect(pages[1]).toContain('Rangoli Paints & Hardware · Quotation QT-000042 v2 · Continued');
      expect(pages[1]).toContain('Description');
      // Text extraction splits some Telugu clusters; these come back whole.
      expect(text).toContain('తేదీ');
      expect(text).toContain('పేజీ 2 /');
      expect(text).toContain(`Page 2 of ${String(totalPages)}`);
      expect(text).toContain('Item 70');
    },
  );
});
