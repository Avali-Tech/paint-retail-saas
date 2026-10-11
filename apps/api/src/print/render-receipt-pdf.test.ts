import type { ReceiptView } from '@paint/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { renderReceiptPdf } from './render-receipt-pdf.js';

async function read(pdf: Buffer) {
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const { totalPages, text } = await extractText(document);
  const info = (await document.getMetadata()).info as Record<string, unknown>;
  return { totalPages, text: text.join(' ').replace(/\s+/g, ' '), title: info.Title };
}

const RECEIPT: ReceiptView = {
  title: 'Payment receipt',
  number: 'RC-000012',
  voucherNumber: null,
  direction: 'in',
  date: '2026-10-08',
  store: {
    code: 'AMP',
    name: 'Ameerpet',
    legalName: 'Rangoli Paints Private Limited',
    tradeName: 'Rangoli Paints & Hardware',
    gstin: '36AABCS1429B1ZB',
    address: '1-2-3 Main Road, Hyderabad, Telangana, 500016',
  },
  party: { id: 'p1', name: 'Deccan Contractors', phone: '+919800000001', gstin: null },
  mode: { kind: 'cheque', name: 'Cheque' },
  amountPaise: 1_50_000,
  amountInWords: 'Rupees One Thousand Five Hundred Only',
  tenderedPaise: null,
  changePaise: null,
  reference: '004512',
  chequeDate: '2026-10-07',
  chequeStatus: 'pending',
  settled: [
    { number: 'AMP/26-27/000004', amountPaise: 1_00_000 },
    { number: null, amountPaise: 30_000 },
  ],
  unallocatedPaise: 20_000,
  partyBalancePaise: 4_500,
  receivedBy: 'Owner',
  note: 'Part payment',
};

describe('renderReceiptPdf', () => {
  it('draws a receipt with the bills it settled and the balance left', async () => {
    const pdf = await renderReceiptPdf(RECEIPT);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { totalPages, text, title } = await read(pdf);
    expect(totalPages).toBe(1);
    expect(title).toBe('Payment receipt RC-000012');
    for (const expected of [
      'Rangoli Paints & Hardware',
      'Rangoli Paints Private Limited',
      '1-2-3 Main Road, Hyderabad, Telangana, 500016',
      'GSTIN: 36AABCS1429B1ZB',
      'Number: RC-000012',
      'Date: 08 Oct 2026',
      'Received from: Deccan Contractors',
      'Phone: +919800000001',
      '₹1,500.00',
      'Rupees One Thousand Five Hundred Only',
      'Mode: Cheque',
      'Reference: 004512',
      'Cheque date: 07 Oct 2026',
      'Cheque: Pending',
      'AMP/26-27/000004: ₹1,000.00',
      'Opening balance: ₹300.00',
      'On account: ₹200.00',
      'Balance now: ₹45.00',
      'Note: Part payment',
      'Received by: Owner',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('Voucher:');
    expect(text).not.toContain('Tendered');
  });

  it('draws a cash refund voucher for a store with only a name', async () => {
    const { text } = await read(
      await renderReceiptPdf({
        ...RECEIPT,
        title: 'Refund voucher',
        voucherNumber: 'AMPRF/26-27/0001',
        direction: 'out',
        store: { ...RECEIPT.store, legalName: null, tradeName: null, gstin: null, address: null },
        party: { ...RECEIPT.party, phone: null, gstin: '36AAACR5055K1Z5' },
        mode: { kind: 'cash', name: 'Cash' },
        tenderedPaise: 2_000,
        changePaise: 500,
        reference: null,
        chequeDate: null,
        chequeStatus: null,
        settled: [],
        unallocatedPaise: 0,
        note: null,
      }),
    );
    expect(text).toContain('Ameerpet');
    expect(text).toContain('Refund voucher');
    expect(text).toContain('Voucher: AMPRF/26-27/0001');
    expect(text).toContain('Paid to: Deccan Contractors');
    expect(text).toContain('GSTIN: 36AAACR5055K1Z5');
    expect(text).toContain('Tendered: ₹20.00');
    expect(text).toContain('Change: ₹5.00');
    expect(text).toContain('Paid by: Owner');
    expect(text).not.toContain('Settled');
    expect(text).not.toContain('On account');
  });

  it('names the store by its legal name when it has no trade name', async () => {
    const { text } = await read(
      await renderReceiptPdf({ ...RECEIPT, store: { ...RECEIPT.store, tradeName: null } }),
    );
    expect(text).toContain('Rangoli Paints Private Limited');
    expect(text).not.toContain('Rangoli Paints & Hardware');
  });
});
