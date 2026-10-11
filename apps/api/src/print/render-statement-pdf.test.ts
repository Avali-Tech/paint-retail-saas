import {
  buildStatementView,
  emptyTotals,
  statementLabels,
  type PartyLedgerEntryKind,
  type StatementData,
  type StatementEntryView,
} from '@paint/shared';
import PDFDocument from 'pdfkit';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { PDF_FONTS } from './render-invoice-pdf.js';
import { renderStatementPdf } from './render-statement-pdf.js';

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

const KINDS: PartyLedgerEntryKind[] = [
  'opening',
  'invoice',
  'debit_note',
  'credit_note',
  'payment_in',
  'refund_out',
  'cheque_bounce',
  'adjustment',
  'cancellation',
];

function entries(count: number): StatementEntryView[] {
  let balance = 0;
  return Array.from({ length: count }, (_, index) => {
    const kind = KINDS[index % KINDS.length] ?? 'invoice';
    const amount = ['credit_note', 'payment_in', 'cancellation'].includes(kind) ? -1_000 : 2_000;
    balance += amount;
    return {
      entryOn: '2026-09-02',
      entryType: kind,
      referenceNumber: kind === 'opening' ? null : `AMP/26-27/${String(index).padStart(6, '0')}`,
      note: index % 4 === 0 ? 'UPI from the site office' : null,
      amountPaise: amount,
      balancePaise: balance,
    };
  });
}

const DATA: StatementData = {
  business: {
    name: 'Rangoli Paints',
    legalName: 'Rangoli Paints Private Limited',
    gstin: '36AABCS1429B1Z5',
    address: '1-2-3 Main Road, Hyderabad, 500016',
  },
  party: {
    id: 'party-1',
    name: 'Deccan Contractors',
    phone: '9876543210',
    gstin: '36AABCU9603R1ZO',
    address: 'Kukatpally, Hyderabad',
  },
  from: '2026-09-01',
  to: '2026-10-11',
  generatedOn: '2026-10-11',
  openingPaise: 50_000,
  entries: entries(9),
  debitsPaise: 12_000,
  creditsPaise: 3_000,
  closingPaise: 59_000,
  ageing: {
    buckets: {
      not_due: 9_000,
      days_0_30: 20_000,
      days_31_60: 0,
      days_61_90: 0,
      days_90_plus: 31_000,
    },
    outstandingPaise: 60_000,
    unappliedPaise: 1_000,
    netPaise: 59_000,
  },
  openItems: [
    {
      kind: 'invoice',
      number: 'AMP/26-27/000001',
      raisedOn: '2026-06-01',
      dueOn: '2026-07-01',
      outstandingPaise: 31_000,
      daysPastDue: 102,
    },
  ],
};

describe('renderStatementPdf', () => {
  it('draws the business, the customer, every entry, the totals and the ageing', async () => {
    const pdf = await read(await renderStatementPdf(buildStatementView(DATA, null)));
    expect(pdf.totalPages).toBe(1);
    expect(pdf.title).toBe('Statement of Account · Deccan Contractors · 01 Sep 2026 – 11 Oct 2026');
    for (const text of [
      'Rangoli Paints',
      'Rangoli Paints Private Limited',
      'GSTIN: 36AABCS1429B1Z5',
      'Statement of Account',
      '01 Sep 2026 – 11 Oct 2026',
      'Date: 11 Oct 2026',
      'Deccan Contractors',
      'Phone: 9876543210',
      'GSTIN: 36AABCU9603R1ZO',
      'Opening balance',
      '500.00 Dr',
      'Closing balance',
      '590.00 Dr',
      'Payment received',
      'UPI from the site office',
      'Invoice cancelled',
      'Total',
      '120.00',
      'Ageing',
      'Over 90 days',
      'Paid in advance',
      'Balance due',
      'Bills due',
      '102',
      'This is a computer-generated statement.',
      'Page 1 of 1',
    ]) {
      expect(pdf.text).toContain(text);
    }
  });

  it('prints every label in Hindi and in Telugu under the English', async () => {
    // Text extraction reorders some vowel signs, so these are words without them.
    const hindi = await read(await renderStatementPdf(buildStatementView(DATA, 'hi')));
    expect(hindi.text).toContain('Debit नामे');
    expect(hindi.text).toContain('कुल बकाया');
    const telugu = await read(await renderStatementPdf(buildStatementView(DATA, 'te')));
    expect(telugu.text).toContain('Credit జమ');
    expect(telugu.text).not.toContain('नामे');
  });

  it('can draw every translated label with its script font', () => {
    // fontkit fails on some Telugu clusters (e.g. క్రె); keep every label drawable.
    for (const language of ['hi', 'te'] as const) {
      const doc = new PDFDocument();
      doc.registerFont(language, PDF_FONTS[language]);
      for (const label of Object.values(statementLabels(language))) {
        if (label.translation === null) continue;
        expect(doc.font(language).fontSize(8).heightOfString(label.translation)).toBeGreaterThan(0);
      }
    }
  });

  it(
    'runs onto more pages with the headings repeated and every page numbered',
    { timeout: 60_000 },
    async () => {
      const many = entries(160);
      const data = {
        ...DATA,
        entries: many,
        openItems: Array.from({ length: 40 }, (_, index) => ({
          kind: 'charge' as const,
          number: null,
          raisedOn: '2026-09-01',
          dueOn: '2026-09-01',
          outstandingPaise: 100,
          daysPastDue: index - 5,
        })),
      };
      const pdf = await read(await renderStatementPdf(buildStatementView(data, 'hi')));
      expect(pdf.totalPages).toBeGreaterThan(3);
      expect(pdf.pages[1]).toContain('Rangoli Paints · Statement of Account · Deccan Contractors');
      expect(pdf.pages[1]).toContain('Particulars');
      expect(pdf.pages.at(-1)).toContain(
        `Page ${String(pdf.totalPages)} of ${String(pdf.totalPages)}`,
      );
      expect(pdf.text).toContain('Charge');
    },
  );

  it('says when a period has no entries, and leaves out what is not known', async () => {
    const pdf = await read(
      await renderStatementPdf(
        buildStatementView(
          {
            ...DATA,
            business: { name: 'Rangoli Paints', legalName: null, gstin: null, address: null },
            party: { ...DATA.party, phone: null, gstin: null, address: null },
            openingPaise: 0,
            entries: [],
            debitsPaise: 0,
            creditsPaise: 0,
            closingPaise: 0,
            ageing: emptyTotals(),
            openItems: [],
          },
          'te',
        ),
      ),
    );
    expect(pdf.text).toContain('No entries in this period');
    expect(pdf.text).not.toContain('GSTIN');
    expect(pdf.text).not.toContain('Bills due');
    expect(pdf.text).not.toContain('Paid in advance');
  });
});
