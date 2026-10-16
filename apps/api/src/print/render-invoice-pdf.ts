import { fileURLToPath } from 'node:url';
import {
  fillLabel,
  type InvoiceView,
  type LineView,
  type PrintLabel,
  type SecondLanguage,
} from '@paint/shared';
import PDFDocument from 'pdfkit';

/**
 * The A4 invoice as a PDF, drawn from the print view model with pdfkit (pure JS:
 * no browser in the read-only API image; see docs/mvp-2/print.md). Noto Sans draws
 * English and the rupee sign; Noto Sans Devanagari or Telugu draws the second
 * language's labels. Long invoices continue on more pages, each repeating a short
 * header and the table's column headings, and every page is numbered.
 *
 * Plain black and grey only: a printed tax document is not themed, and the
 * business's identity is its name and logo (white-label), as on the HTML template.
 */

/** Fonts shipped next to this module (copied to dist/server/fonts by the build). */
const fontFile = (name: string) => fileURLToPath(new URL(`./fonts/${name}`, import.meta.url));
export const PDF_FONTS = {
  regular: fontFile('NotoSans-Regular.ttf'),
  bold: fontFile('NotoSans-Bold.ttf'),
  hi: fontFile('NotoSansDevanagari-Regular.ttf'),
  te: fontFile('NotoSansTelugu-Regular.ttf'),
} as const;

/**
 * A PDF document with the Noto fonts registered by name (`regular`, `bold`, `hi`,
 * `te`). It is given no default font file on purpose: pdfkit 0.20 caches a registered
 * font under its name only when it opens it first, so a default loaded from the same
 * file made every later `font('regular')` read and parse the file again (a statement of
 * 300 entries took 2.9 s; now 0.1 s). Every renderer sets the font before it writes.
 */
export function pdfDocument(options: PDFKit.PDFDocumentOptions): PDFKit.PDFDocument {
  const doc = new PDFDocument(options);
  for (const [name, path] of Object.entries(PDF_FONTS)) doc.registerFont(name, path);
  return doc;
}

export interface InvoicePdfAssets {
  /** The logo's bytes (PNG or JPEG; anything else is left out and the name printed alone). */
  readonly logo: Uint8Array | null;
}

const INK = 'black';
const MUTED = '#555555';
const RULE = '#999999';
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 36;
const WIDTH = PAGE.width - 2 * MARGIN;
/** Room kept at the bottom of every page for its number. */
const BOTTOM = PAGE.height - MARGIN - 16;
const BODY = 8;
const SMALL = 7;

type Align = 'left' | 'right' | 'center';
type Doc = PDFKit.PDFDocument;

interface TextStyle {
  readonly font?: string;
  readonly size?: number;
  readonly align?: Align;
  readonly color?: string;
}

interface Column {
  readonly header: PrintLabel;
  readonly width: number;
  readonly align: Align;
  readonly value: (line: LineView) => string;
}

/** True for PNG and JPEG, the formats pdfkit can embed. */
export function embeddableImage(bytes: Uint8Array): boolean {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return png || jpeg;
}

class InvoicePdf {
  private y = MARGIN;

  constructor(
    private readonly doc: Doc,
    private readonly view: InvoiceView,
  ) {}

  private height(text: string, font: string, size: number, width: number): number {
    return this.doc.font(font).fontSize(size).heightOfString(text, { width });
  }

  /** Draws text at (x, y) and returns its height. */
  private write(
    text: string,
    x: number,
    y: number,
    width: number,
    { font = 'regular', size = BODY, align = 'left', color = INK }: TextStyle = {},
  ): number {
    this.doc.font(font).fontSize(size).fillColor(color).text(text, x, y, { width, align });
    return this.height(text, font, size, width);
  }

  /** The second language's text (translations hold no Latin letters: a test in @paint/shared keeps it so). */
  private writeTranslation(
    text: string,
    language: SecondLanguage,
    x: number,
    y: number,
    width: number,
    size: number,
    align: Align,
  ): number {
    this.doc.font(language).fontSize(size).fillColor(MUTED).text(text, x, y, { width, align });
    return this.height(text, language, size, width);
  }

  /** A label in English, with its translation under it; returns the height. */
  private label(
    label: PrintLabel,
    x: number,
    y: number,
    width: number,
    { size = BODY, font = 'bold', align = 'left' }: TextStyle = {},
  ): number {
    const english = this.write(label.text, x, y, width, { font, size, align });
    const { secondLanguage } = this.view;
    if (label.translation === null || secondLanguage === null) return english;
    return (
      english +
      this.writeTranslation(
        label.translation,
        secondLanguage,
        x,
        y + english,
        width,
        size - 1,
        align,
      )
    );
  }

  private labelHeight(label: PrintLabel, width: number, size: number): number {
    const english = this.height(label.text, 'bold', size, width);
    const { secondLanguage } = this.view;
    if (label.translation === null || secondLanguage === null) return english;
    return english + this.height(label.translation, secondLanguage, size - 1, width);
  }

  private rule(y: number, color = RULE): void {
    this.doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + WIDTH, y)
      .lineWidth(0.5)
      .strokeColor(color)
      .stroke();
  }

  private newPage(): void {
    this.doc.addPage();
    const { view } = this;
    const line = `${view.business.name} · ${view.title.text} ${view.number} · ${view.labels.continued.text}`;
    this.y = MARGIN + this.write(line, MARGIN, MARGIN, WIDTH, { size: SMALL, color: MUTED }) + 6;
  }

  /** Starts a new page unless `height` more fits on this one. */
  private ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage();
  }

  header(logo: Uint8Array | null): void {
    const { view } = this;
    const left = WIDTH * 0.6;
    let x = MARGIN;
    if (logo !== null && embeddableImage(logo)) {
      this.doc.image(Buffer.from(logo), MARGIN, MARGIN, { fit: [80, 48] });
      x += 88;
    }
    let y = MARGIN;
    y += this.write(view.business.name, x, y, left - (x - MARGIN), { font: 'bold', size: 15 });
    const supplier = [
      view.business.name === view.supplier.legalName ? null : view.supplier.legalName,
      ...view.supplier.addressLines,
      view.supplier.state,
      `GSTIN: ${view.supplier.gstin}`,
      [view.supplier.phone, view.supplier.email].filter((part) => part !== null).join(' · '),
    ].filter((line) => line !== null && line !== '');
    y += this.write(supplier.join('\n'), x, y, left - (x - MARGIN));

    const right = MARGIN + left;
    let ry = MARGIN;
    ry += this.label(view.title, right, ry, WIDTH - left, { size: 14, align: 'right' });
    if (view.copyMark !== null) {
      ry += this.write(view.copyMark, right, ry + 2, WIDTH - left, {
        font: 'bold',
        size: SMALL,
        align: 'right',
      });
    }
    this.y = Math.max(y, ry, MARGIN + 48) + 6;
    if (view.compositionNotice !== null) {
      this.y += this.write(view.compositionNotice, MARGIN, this.y, WIDTH, {
        font: 'bold',
        align: 'center',
      });
    }
    this.rule(this.y + 2, INK);
    this.y += 8;
  }

  /** Number, date, place of supply and reverse charge on the left; buyer and ship-to on the right. */
  parties(): void {
    const { view } = this;
    const { labels } = view;
    const half = WIDTH / 2 - 6;
    const facts: [PrintLabel, string][] = [
      [view.kind === 'tax_invoice' ? labels.invoiceNumber : labels.billNumber, view.number],
      [labels.date, view.date],
      [labels.placeOfSupply, view.placeOfSupply],
    ];
    if (view.reverseCharge !== null) facts.push([labels.reverseCharge, view.reverseCharge]);
    let y = this.y;
    for (const [label, value] of facts) {
      const height = this.label(label, MARGIN, y, half * 0.55, { size: BODY });
      this.write(value, MARGIN + half * 0.55, y, half * 0.45);
      y += Math.max(height, 10) + 3;
    }

    const x = MARGIN + WIDTH / 2 + 6;
    let by = this.y + this.label(labels.billTo, x, this.y, half);
    const buyer = [
      view.buyer.name,
      `${labels.gstin.text}: ${view.buyer.gstin ?? labels.unregistered.text}`,
      ...view.buyer.addressLines,
      view.buyer.state === null ? null : `${labels.state.text}: ${view.buyer.state}`,
      view.buyer.phone === null ? null : `${labels.phone.text}: ${view.buyer.phone}`,
    ].filter((line) => line !== null);
    by += this.write(buyer.join('\n'), x, by, half);
    if (view.shipTo !== null) {
      by += 4;
      by += this.label(labels.shipTo, x, by, half);
      by += this.write([...view.shipTo.addressLines, view.shipTo.state].join('\n'), x, by, half);
    }
    this.y = Math.max(y, by) + 6;
    this.rule(this.y);
    this.y += 4;
  }

  private columns(): Column[] {
    const { view } = this;
    const { labels } = view;
    const discount = view.lines.some((line) => line.discount !== null);
    const taxed = view.taxColumns.length > 0;
    const columns: (Column | null)[] = [
      { header: labels.serialNumber, width: 16, align: 'right', value: (l) => String(l.serial) },
      // Description takes what is left (below).
      {
        header: labels.description,
        width: 0,
        align: 'left',
        value: (l) => (l.variant === null ? l.description : `${l.description}\n${l.variant}`),
      },
      { header: labels.hsn, width: 44, align: 'left', value: (l) => l.hsn },
      {
        header: labels.quantity,
        width: 42,
        align: 'right',
        value: (l) => `${l.quantity} ${l.uqc}`,
      },
      {
        header: view.pricesIncludeTax ? labels.priceInclusive : labels.price,
        width: 50,
        align: 'right',
        value: (l) => l.price,
      },
      discount
        ? {
            header: labels.discount,
            width: 42,
            align: 'right',
            value: (l) => l.discount ?? '',
          }
        : null,
      {
        header: taxed ? labels.taxableValue : labels.value,
        width: 54,
        align: 'right',
        value: (l) => l.taxable,
      },
      taxed
        ? { header: labels.gstRate, width: 32, align: 'right', value: (l) => String(l.rate) }
        : null,
      ...view.taxColumns.map((column): Column => ({
        header: { text: column.label, translation: null },
        width: 46,
        align: 'right',
        value: (l) => String(l.taxes[column.key]),
      })),
      { header: labels.amount, width: 56, align: 'right', value: (l) => l.amount },
    ];
    const present = columns.filter((column) => column !== null);
    const fixed = present.reduce((sum, column) => sum + column.width, 0);
    return present.map((column) =>
      column.width === 0 ? { ...column, width: WIDTH - fixed } : column,
    );
  }

  private tableHeader(columns: readonly Column[]): void {
    let x = MARGIN;
    const height = Math.max(...columns.map((c) => this.labelHeight(c.header, c.width - 4, SMALL)));
    for (const column of columns) {
      this.label(column.header, x + 2, this.y + 2, column.width - 4, {
        size: SMALL,
        align: column.align,
      });
      x += column.width;
    }
    this.y += height + 4;
    this.rule(this.y);
    this.y += 2;
  }

  lines(): void {
    const columns = this.columns();
    this.tableHeader(columns);
    for (const line of this.view.lines) {
      const height =
        Math.max(...columns.map((c) => this.height(c.value(line), 'regular', BODY, c.width - 4))) +
        4;
      if (this.y + height > BOTTOM) {
        this.newPage();
        this.tableHeader(columns);
      }
      let x = MARGIN;
      for (const column of columns) {
        this.write(column.value(line), x + 2, this.y + 2, column.width - 4, {
          align: column.align,
        });
        x += column.width;
      }
      this.y += height;
    }
    this.rule(this.y);
    this.y += 6;
  }

  /** The tax summary by rate on the left, the totals on the right. */
  totals(): void {
    const { view } = this;
    const { labels } = view;
    const totalsWidth = 200;
    const rowHeight = 12;
    const summaryRows = view.taxSummary.length > 0 ? view.taxSummary.length + 2 : 0;
    this.ensure(Math.max(view.totals.length, summaryRows) * rowHeight + 24);
    const top = this.y;

    let y = top;
    if (view.taxSummary.length > 0) {
      y += this.label(labels.taxSummary, MARGIN, y, 280, { size: BODY });
      const cells = [labels.rate.text, labels.taxableValue.text]
        .concat(view.taxColumns.map((column) => column.label))
        .concat(labels.totalTax.text);
      const width = 290 / cells.length;
      const row = (values: readonly string[], font: string) => {
        values.forEach((value, index) => {
          this.write(value, MARGIN + index * width, y, width - 4, {
            font,
            size: SMALL,
            align: index === 0 ? 'left' : 'right',
          });
        });
        y += rowHeight;
      };
      row(cells, 'bold');
      for (const summary of view.taxSummary) {
        row(
          [summary.rate, summary.taxable]
            .concat(view.taxColumns.map((column) => String(summary.taxes[column.key])))
            .concat(summary.totalTax),
          'regular',
        );
      }
    }

    let ty = top;
    const x = MARGIN + WIDTH - totalsWidth;
    for (const total of view.totals) {
      const grand = total.key === 'grandTotal';
      if (grand) this.rule(ty);
      const font = grand ? 'bold' : 'regular';
      const size = grand ? 10 : BODY;
      const height = this.label(total.label, x, ty + 1, 120, { font, size });
      this.write(grand ? view.grandTotal : total.amount, x + 120, ty + 1, totalsWidth - 120, {
        font,
        size,
        align: 'right',
      });
      ty += Math.max(height, rowHeight) + 1;
    }
    this.y = Math.max(y, ty) + 6;
  }

  /** Amount in words, notes, terms and bank details, then the signatory. */
  footer(): void {
    const { view } = this;
    const { labels } = view;
    const blocks: { label: PrintLabel; text: string }[] = [
      { label: labels.amountInWords, text: view.amountInWords },
    ];
    if (view.notes.length > 0) blocks.push({ label: labels.notes, text: view.notes.join('\n') });
    if (view.terms.length > 0) blocks.push({ label: labels.terms, text: view.terms.join('\n') });
    if (view.bank !== null) {
      const { bank } = view;
      blocks.push({
        label: labels.bankDetails,
        text: [
          bank.bankName,
          `${bank.accountName} · ${labels.bankAccount.text} ${bank.accountNumber} · ${labels.ifsc.text} ${bank.ifsc}`,
          bank.upiId === null ? null : `${labels.upi.text}: ${bank.upiId}`,
        ]
          .filter((line) => line !== null)
          .join('\n'),
      });
    }
    // The signatory sits beside the notes, terms and bank details, so short invoices fit one page.
    const signatoryWidth = 200;
    const textWidth = WIDTH - signatoryWidth - 16;
    for (const [index, block] of blocks.entries()) {
      const width = index === 0 ? WIDTH : textWidth;
      const height =
        this.labelHeight(block.label, width, BODY) +
        this.height(block.text, 'regular', BODY, width);
      this.ensure(height + (index === 0 ? 80 : 4));
      if (index === 1) this.signatory(signatoryWidth);
      this.y += this.label(block.label, MARGIN, this.y, width);
      this.y += this.write(block.text, MARGIN, this.y, width) + 4;
    }
    if (blocks.length === 1) this.signatory(signatoryWidth);
    this.y = Math.max(this.y, this.signatoryBottom);
  }

  private signatoryBottom = 0;

  /** "For <supplier>", room to sign, the name and "Authorised signatory", at the right. */
  private signatory(width: number): void {
    const { view } = this;
    const x = MARGIN + WIDTH - width;
    let y = this.y + 2;
    y += this.write(view.signatory.forLine, x, y, width, { font: 'bold', align: 'right' });
    y += 28;
    if (view.signatory.name !== null) {
      y += this.write(view.signatory.name, x, y, width, { align: 'right' });
    }
    y += this.label(view.labels.authorisedSignatory, x, y, width, { size: BODY, align: 'right' });
    this.signatoryBottom = y;
  }

  /** "Page 1 of 2" at the foot of every page. */
  pageNumbers(): void {
    const { start, count } = this.doc.bufferedPageRange();
    for (let index = start; index < start + count; index += 1) {
      this.doc.switchToPage(index);
      // Writing below the bottom margin would otherwise start a new page.
      this.doc.page.margins.bottom = 0;
      const params = { page: index + 1, pages: count };
      const { page } = this.view.labels;
      const y = PAGE.height - MARGIN;
      const style: TextStyle = { size: SMALL, color: MUTED, align: 'center' };
      const height = this.write(fillLabel(page.text, params), MARGIN, y, WIDTH, style);
      const language = this.view.secondLanguage;
      if (page.translation !== null && language !== null) {
        const text = fillLabel(page.translation, params);
        this.writeTranslation(text, language, MARGIN, y + height, WIDTH, SMALL - 1, 'center');
      }
    }
  }
}

/** The invoice as an A4 PDF. `assets.logo` is the logo's bytes, which the view only links to. */
export function renderInvoicePdf(
  view: InvoiceView,
  assets: InvoicePdfAssets = { logo: null },
): Promise<Buffer> {
  const doc = pdfDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    lang: 'en-IN',
    info: {
      Title: `${view.title.text} ${view.number}`,
      Author: view.supplier.legalName,
      Subject: view.title.text,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
  const pdf = new InvoicePdf(doc, view);
  pdf.header(assets.logo);
  pdf.parties();
  pdf.lines();
  pdf.totals();
  pdf.footer();
  pdf.pageNumbers();
  doc.end();
  return done;
}
