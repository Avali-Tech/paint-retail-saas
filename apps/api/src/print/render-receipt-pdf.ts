import { formatINR, formatPrintDate, type ReceiptView } from '@paint/shared';
import { pdfDocument } from './render-invoice-pdf.js';

/**
 * A payment receipt, receipt voucher or refund slip as an A5 PDF, drawn from
 * round 3a's receipt view with pdfkit and the invoice PDF's fonts. Plain black
 * and grey, like every printed document; the business is named by its store.
 */

const MARGIN = 36;
const MUTED = '#555555';

type Doc = PDFKit.PDFDocument;

const CHEQUE_STATUS = { pending: 'Pending', cleared: 'Cleared', bounced: 'Bounced' } as const;

/** One "Label: value" row; nothing when the value is missing. */
function row(doc: Doc, label: string, value: string | null): void {
  if (value === null) return;
  doc.font('bold').text(`${label}: `, { continued: true }).font('regular').text(value);
}

function header(doc: Doc, view: ReceiptView): void {
  const { store } = view;
  doc
    .font('bold')
    .fontSize(13)
    .text(store.tradeName ?? store.legalName ?? store.name, { align: 'center' });
  doc.font('regular').fontSize(8).fillColor(MUTED);
  if (store.tradeName !== null && store.legalName !== null) {
    doc.text(store.legalName, { align: 'center' });
  }
  if (store.address !== null) doc.text(store.address, { align: 'center' });
  if (store.gstin !== null) doc.text(`GSTIN: ${store.gstin}`, { align: 'center' });
  doc.fillColor('black').moveDown(0.6).font('bold').fontSize(12);
  doc.text(view.title, { align: 'center' }).moveDown(0.6).fontSize(9);
}

function body(doc: Doc, view: ReceiptView): void {
  row(doc, 'Number', view.number);
  row(doc, 'Voucher', view.voucherNumber);
  row(doc, 'Date', formatPrintDate(view.date));
  doc.moveDown(0.4);
  row(doc, view.direction === 'in' ? 'Received from' : 'Paid to', view.party.name);
  row(doc, 'Phone', view.party.phone);
  row(doc, 'GSTIN', view.party.gstin);
  doc.moveDown(0.4);
  doc.font('bold').fontSize(14).text(formatINR(view.amountPaise));
  doc.font('regular').fontSize(9).text(view.amountInWords).moveDown(0.4);
  row(doc, 'Mode', view.mode.name);
  row(doc, 'Reference', view.reference);
  row(doc, 'Cheque date', view.chequeDate === null ? null : formatPrintDate(view.chequeDate));
  row(doc, 'Cheque', view.chequeStatus === null ? null : CHEQUE_STATUS[view.chequeStatus]);
  row(doc, 'Tendered', view.tenderedPaise === null ? null : formatINR(view.tenderedPaise));
  row(doc, 'Change', view.changePaise === null ? null : formatINR(view.changePaise));
  if (view.settled.length > 0) {
    doc.moveDown(0.4).font('bold').text('Settled');
    for (const bill of view.settled) {
      row(doc, bill.number ?? 'Opening balance', formatINR(bill.amountPaise));
    }
  }
  if (view.unallocatedPaise > 0) {
    row(doc, 'On account', formatINR(view.unallocatedPaise));
  }
  doc.moveDown(0.4);
  row(doc, 'Balance now', formatINR(view.partyBalancePaise));
  row(doc, 'Note', view.note);
  doc.moveDown(1.2);
  row(doc, view.direction === 'in' ? 'Received by' : 'Paid by', view.receivedBy);
}

/** The receipt as an A5 PDF. */
export function renderReceiptPdf(view: ReceiptView): Promise<Buffer> {
  const doc = pdfDocument({
    size: 'A5',
    margin: MARGIN,
    lang: 'en-IN',
    info: { Title: `${view.title} ${view.number}`, Subject: view.title },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
  header(doc, view);
  body(doc, view);
  doc.end();
  return done;
}
