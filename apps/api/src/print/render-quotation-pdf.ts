import {
  fillLabel,
  formatFormula,
  formatINR,
  formatPrintDate,
  formatShade,
  quotationLabels,
  stateLabel,
  amountInWords,
  type PrintLabel,
  type QuotationLabels,
  type QuotationView,
  type SalesLineView,
  type SecondLanguage,
} from '@paint/shared';
import PDFDocument from 'pdfkit';
import { PDF_FONTS } from './render-invoice-pdf.js';

/**
 * A quotation as an A4 PDF (spec §5.3 "Share"), drawn with pdfkit and the invoice
 * PDF's Noto fonts: headed "Quotation", never "Tax Invoice", with its version and
 * validity, bill-to, site and influencer, the lines with their tax, and the totals.
 * Labels print in English with the chosen second language (Hindi or Telugu) under
 * them. Long quotations continue on more pages, each numbered.
 */

/** The store the quotation is from, as its letterhead. */
export interface QuotationPdfStore {
  readonly name: string;
  readonly legalName: string | null;
  readonly tradeName: string | null;
  readonly gstin: string | null;
  readonly address: string | null;
}

const INK = 'black';
const MUTED = '#555555';
const RULE = '#999999';
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 36;
const WIDTH = PAGE.width - 2 * MARGIN;
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
  readonly value: (line: SalesLineView) => string;
}

/** A line's discount: a percentage, or rupees; nothing when there is none. */
function discountText(line: SalesLineView): string {
  if (line.discountBps !== null) return `${String(line.discountBps / 100)}%`;
  return line.discountPaise === null || line.discountPaise === 0
    ? ''
    : formatINR(line.discountPaise);
}

const quantityFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

class QuotationPdf {
  private y = MARGIN;
  private readonly labels: QuotationLabels;

  constructor(
    private readonly doc: Doc,
    private readonly quotation: QuotationView,
    private readonly store: QuotationPdfStore,
    private readonly second: SecondLanguage | null,
  ) {
    this.labels = quotationLabels(second);
  }

  private height(text: string, font: string, size: number, width: number): number {
    return this.doc.font(font).fontSize(size).heightOfString(text, { width });
  }

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

  /** A label in English, with its translation under it; returns the height. */
  private label(
    label: PrintLabel,
    x: number,
    y: number,
    width: number,
    { size = BODY, font = 'bold', align = 'left' }: TextStyle = {},
  ): number {
    const english = this.write(label.text, x, y, width, { font, size, align });
    if (label.translation === null || this.second === null) return english;
    return (
      english +
      this.write(label.translation, x, y + english, width, {
        font: this.second,
        size: size - 1,
        align,
        color: MUTED,
      })
    );
  }

  private labelHeight(label: PrintLabel, width: number, size: number): number {
    const english = this.height(label.text, 'bold', size, width);
    if (label.translation === null || this.second === null) return english;
    return english + this.height(label.translation, this.second, size - 1, width);
  }

  private rule(y: number, color = RULE): void {
    this.doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + WIDTH, y)
      .lineWidth(0.5)
      .strokeColor(color)
      .stroke();
  }

  private businessName(): string {
    return this.store.tradeName ?? this.store.legalName ?? this.store.name;
  }

  private newPage(): void {
    this.doc.addPage();
    const { quotation, labels } = this;
    const line = `${this.businessName()} · ${labels.quotation.text} ${quotation.number} v${String(quotation.version)} · ${labels.continued.text}`;
    this.y = MARGIN + this.write(line, MARGIN, MARGIN, WIDTH, { size: SMALL, color: MUTED }) + 6;
  }

  private ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage();
  }

  /** The store's letterhead on the left, "Quotation" and its number on the right. */
  header(): void {
    const { store, quotation, labels } = this;
    const left = WIDTH * 0.6;
    let y = MARGIN;
    y += this.write(this.businessName(), MARGIN, y, left, { font: 'bold', size: 15 });
    const letterhead = [
      store.tradeName !== null && store.legalName !== null ? store.legalName : null,
      store.address,
      store.gstin === null ? null : `${labels.gstin.text}: ${store.gstin}`,
    ].filter((line) => line !== null);
    if (letterhead.length > 0) y += this.write(letterhead.join('\n'), MARGIN, y, left);

    const right = MARGIN + left;
    let ry = MARGIN;
    ry += this.label(labels.quotation, right, ry, WIDTH - left, { size: 14, align: 'right' });
    ry += this.write(
      `${quotation.number} v${String(quotation.version)}`,
      right,
      ry + 2,
      WIDTH - left,
      {
        font: 'bold',
        align: 'right',
      },
    );
    this.y = Math.max(y, ry) + 8;
    this.rule(this.y, INK);
    this.y += 6;
  }

  /** Number, version, dates and place of supply; then bill-to, site and influencer. */
  parties(): void {
    const { quotation, labels } = this;
    const half = WIDTH / 2 - 6;
    const facts: [PrintLabel, string][] = [
      [labels.quotationNumber, quotation.number],
      [labels.version, String(quotation.version)],
      [labels.date, formatPrintDate(quotation.pricedOn)],
      [labels.validUntil, formatPrintDate(quotation.validUntil)],
      [labels.placeOfSupply, stateLabel(quotation.placeOfSupplyCode)],
    ];
    let y = this.y;
    for (const [label, value] of facts) {
      const height = this.label(label, MARGIN, y, half * 0.45);
      this.write(value, MARGIN + half * 0.45, y, half * 0.55);
      y += Math.max(height, 10) + 3;
    }

    const x = MARGIN + WIDTH / 2 + 6;
    const { billTo, shipTo, project, influencer } = quotation;
    let by = this.y;
    by += this.label(labels.billTo, x, by, half);
    const buyer = [
      billTo.name,
      billTo.gstin === null ? null : `${labels.gstin.text}: ${billTo.gstin}`,
      billTo.phone === null ? null : `${labels.phone.text}: ${billTo.phone}`,
    ].filter((line) => line !== null);
    by += this.write(buyer.join('\n'), x, by, half);
    const site = [
      project?.name ?? null,
      shipTo.name,
      shipTo.address,
      shipTo.stateCode === null ? null : stateLabel(shipTo.stateCode),
    ].filter((line) => line !== null);
    if (site.length > 0) {
      by += 4;
      by += this.label(labels.site, x, by, half);
      by += this.write(site.join('\n'), x, by, half);
    }
    if (influencer !== null) {
      by += 4;
      by += this.label(labels.influencer, x, by, half);
      by += this.write(influencer.name, x, by, half);
    }
    this.y = Math.max(y, by) + 6;
    this.rule(this.y);
    this.y += 4;
  }

  private columns(): Column[] {
    const { quotation, labels } = this;
    const discount = quotation.lines.some((line) => discountText(line) !== '');
    const columns: (Column | null)[] = [
      { header: labels.serialNumber, width: 16, align: 'right', value: (l) => String(l.lineNo) },
      {
        header: labels.description,
        width: 0,
        align: 'left',
        // A tinted base carries one compact line: "Tint X 132 · Ivory · XY 12 ml".
        value: (l) =>
          l.tint === undefined
            ? l.description
            : `${l.description}\n${[
                `${labels.tint.text} ${formatShade(l.tint.shadeCode, l.tint.shadeName)}`,
                formatFormula(l.tint.formula),
              ]
                .filter((part) => part !== null)
                .join(' · ')}`,
      },
      { header: labels.hsn, width: 44, align: 'left', value: (l) => l.hsnCode ?? '' },
      {
        header: labels.quantity,
        width: 40,
        align: 'right',
        value: (l) => quantityFormat.format(l.quantity),
      },
      {
        header: quotation.priceMode === 'inclusive' ? labels.priceInclusive : labels.price,
        width: 58,
        align: 'right',
        value: (l) => formatINR(l.unitPricePaise),
      },
      discount
        ? {
            header: labels.discount,
            width: 50,
            align: 'right',
            value: discountText,
          }
        : null,
      {
        header: labels.taxableValue,
        width: 62,
        align: 'right',
        value: (l) => formatINR(l.taxablePaise),
      },
      {
        header: labels.gstRate,
        width: 32,
        align: 'right',
        value: (l) => (l.rateBps === null ? '' : `${String(l.rateBps / 100)}%`),
      },
      {
        header: labels.tax,
        width: 54,
        align: 'right',
        value: (l) => formatINR(l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise),
      },
      {
        header: labels.amount,
        width: 64,
        align: 'right',
        value: (l) => formatINR(l.totalPaise),
      },
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
    for (const line of this.quotation.lines) {
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

  /** Taxable value, each tax that applies, round off and the total, at the right. */
  totals(): void {
    const { quotation, labels } = this;
    const plain = (text: string): PrintLabel => ({ text, translation: null });
    const rows: [PrintLabel, number, boolean][] = [
      [labels.taxableValue, quotation.taxablePaise, false],
      ...(
        [
          ['CGST', quotation.cgstPaise],
          ['SGST', quotation.sgstPaise],
          ['IGST', quotation.igstPaise],
          ['Cess', quotation.cessPaise],
        ] as const
      )
        .filter(([, paise]) => paise !== 0)
        .map(([name, paise]): [PrintLabel, number, boolean] => [plain(name), paise, false]),
      [labels.roundOff, quotation.roundOffPaise, false],
      [labels.grandTotal, quotation.totalPaise, true],
    ];
    const totalsWidth = 220;
    this.ensure(rows.length * 16 + 12);
    const x = MARGIN + WIDTH - totalsWidth;
    for (const [label, paise, grand] of rows) {
      if (grand) this.rule(this.y);
      const font = grand ? 'bold' : 'regular';
      const size = grand ? 10 : BODY;
      const height = this.label(label, x, this.y + 1, 130, { font, size });
      this.write(formatINR(paise), x + 130, this.y + 1, totalsWidth - 130, {
        font,
        size,
        align: 'right',
      });
      this.y += Math.max(height, 12) + 1;
    }
    this.y += 6;
  }

  /** Amount in words, the note, and that this is not a tax invoice. */
  footer(): void {
    const { quotation, labels } = this;
    const blocks: [PrintLabel, string][] = [
      [labels.amountInWords, amountInWords(quotation.totalPaise)],
    ];
    if (quotation.note !== null) blocks.push([labels.notes, quotation.note]);
    for (const [label, text] of blocks) {
      this.ensure(this.labelHeight(label, WIDTH, BODY) + this.height(text, 'regular', BODY, WIDTH));
      this.y += this.label(label, MARGIN, this.y, WIDTH);
      this.y += this.write(text, MARGIN, this.y, WIDTH) + 4;
    }
    this.ensure(this.labelHeight(labels.notInvoice, WIDTH, BODY) + 4);
    this.label(labels.notInvoice, MARGIN, this.y + 4, WIDTH, { align: 'center' });
  }

  /** "Page 1 of 2" at the foot of every page. */
  pageNumbers(): void {
    const { start, count } = this.doc.bufferedPageRange();
    for (let index = start; index < start + count; index += 1) {
      this.doc.switchToPage(index);
      // Writing below the bottom margin would otherwise start a new page.
      this.doc.page.margins.bottom = 0;
      const params = { page: index + 1, pages: count };
      const { page } = this.labels;
      this.label(
        {
          text: fillLabel(page.text, params),
          translation: page.translation === null ? null : fillLabel(page.translation, params),
        },
        MARGIN,
        PAGE.height - MARGIN,
        WIDTH,
        { font: 'regular', size: SMALL, align: 'center' },
      );
    }
  }
}

/** The quotation as an A4 PDF, its labels in English and `second` (Hindi or Telugu) when given. */
export function renderQuotationPdf(
  quotation: QuotationView,
  store: QuotationPdfStore,
  second: SecondLanguage | null = null,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    font: PDF_FONTS.regular,
    lang: 'en-IN',
    info: {
      Title: `Quotation ${quotation.number} v${String(quotation.version)}`,
      Author: store.legalName ?? store.name,
      Subject: 'Quotation',
    },
  });
  for (const [name, path] of Object.entries(PDF_FONTS)) doc.registerFont(name, path);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
  const pdf = new QuotationPdf(doc, quotation, store, second);
  pdf.header();
  pdf.parties();
  pdf.lines();
  pdf.totals();
  pdf.footer();
  pdf.pageNumbers();
  doc.end();
  return done;
}
