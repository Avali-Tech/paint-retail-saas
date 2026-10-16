import { fillLabel, type PrintLabel, type StatementView } from '@paint/shared';
import { pdfDocument } from './render-invoice-pdf.js';

/**
 * A party's statement of account as an A4 PDF (roadmap P2-M12), drawn with pdfkit and
 * the invoice PDF's Noto fonts from the shared statement view: the business and the
 * customer, the opening balance, every entry with its running balance, the totals and
 * the closing balance, then the ageing on the last day and the bills still due.
 * Labels print in English with the chosen second language under them. Neutral black
 * and grey, as the invoice PDF: statements are photocopied and filed.
 */

const INK = 'black';
const MUTED = '#555555';
const RULE = '#999999';
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 36;
const WIDTH = PAGE.width - 2 * MARGIN;
const BOTTOM = PAGE.height - MARGIN - 16;
const BODY = 8;
const SMALL = 7;
/** The money columns of the entry table, so the totals line up under them. */
const MONEY = { debit: 68, credit: 68, balance: 80 } as const;

type Align = 'left' | 'right' | 'center';
type Doc = PDFKit.PDFDocument;

interface TextStyle {
  readonly font?: string;
  readonly size?: number;
  readonly align?: Align;
  readonly color?: string;
}

interface Column<T> {
  readonly header: PrintLabel;
  /** 0: takes the width the others leave. */
  readonly width: number;
  readonly align: Align;
  readonly value: (row: T) => string;
}

class StatementPdf {
  private y = MARGIN;

  constructor(
    private readonly doc: Doc,
    private readonly view: StatementView,
  ) {}

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
    const second = this.view.secondLanguage;
    if (label.translation === null || second === null) return english;
    return (
      english +
      this.write(label.translation, x, y + english, width, {
        font: second,
        size: size - 1,
        align,
        color: MUTED,
      })
    );
  }

  private labelHeight(label: PrintLabel, width: number, size: number): number {
    const english = this.height(label.text, 'bold', size, width);
    const second = this.view.secondLanguage;
    if (label.translation === null || second === null) return english;
    return english + this.height(label.translation, second, size - 1, width);
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
    const line = `${view.business.name} · ${view.labels.statement.text} · ${view.party.name} · ${view.labels.continued.text}`;
    this.y = MARGIN + this.write(line, MARGIN, MARGIN, WIDTH, { size: SMALL, color: MUTED }) + 6;
  }

  private ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage();
  }

  /** The business on the left; "Statement of Account", the period and the date on the right. */
  header(): void {
    const { view } = this;
    const { business, labels } = view;
    const left = WIDTH * 0.55;
    let y = MARGIN;
    y += this.write(business.name, MARGIN, y, left, { font: 'bold', size: 15 });
    const letterhead = [
      business.legalName,
      business.address,
      business.gstin === null ? null : `${labels.gstin.text}: ${business.gstin}`,
    ].filter((line) => line !== null);
    if (letterhead.length > 0) y += this.write(letterhead.join('\n'), MARGIN, y, left);

    const right = MARGIN + left;
    const width = WIDTH - left;
    let ry = MARGIN;
    ry += this.label(labels.statement, right, ry, width, { size: 14, align: 'right' });
    ry += 2;
    ry += this.label(labels.period, right, ry, width, { font: 'regular', align: 'right' });
    ry += this.write(view.period, right, ry, width, { font: 'bold', align: 'right' }) + 2;
    ry += this.write(`${labels.date.text}: ${view.generatedOn}`, right, ry, width, {
      align: 'right',
    });
    this.y = Math.max(y, ry) + 8;
    this.rule(this.y, INK);
    this.y += 6;
  }

  /** The customer, and the balance the period opens and closes with. */
  party(): void {
    const { view } = this;
    const { party, labels } = view;
    const half = WIDTH / 2 - 6;
    let y = this.y;
    y += this.label(labels.customer, MARGIN, y, half);
    const lines = [
      party.name,
      party.phone === null ? null : `${labels.phone.text}: ${party.phone}`,
      party.gstin === null ? null : `${labels.gstin.text}: ${party.gstin}`,
      party.address,
    ].filter((line) => line !== null);
    y += this.write(lines.join('\n'), MARGIN, y, half);

    const x = MARGIN + WIDTH / 2 + 6;
    let by = this.y;
    for (const [label, value] of [
      [labels.openingBalance, view.opening],
      [labels.closingBalance, view.closing],
    ] as const) {
      const height = this.label(label, x, by, half * 0.55);
      this.write(value, x + half * 0.55, by, half * 0.45, { font: 'bold', align: 'right' });
      by += Math.max(height, 10) + 3;
    }
    this.y = Math.max(y, by) + 6;
    this.rule(this.y);
    this.y += 4;
  }

  private fit<T>(columns: readonly Column<T>[]): Column<T>[] {
    const fixed = columns.reduce((sum, column) => sum + column.width, 0);
    return columns.map((column) =>
      column.width === 0 ? { ...column, width: WIDTH - fixed } : column,
    );
  }

  private tableHeader<T>(columns: readonly Column<T>[]): void {
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

  /** Rows under a header that repeats on every page they run onto. */
  private table<T>(columns: readonly Column<T>[], rows: readonly T[]): void {
    this.ensure(40);
    this.tableHeader(columns);
    for (const row of rows) {
      const height =
        Math.max(...columns.map((c) => this.height(c.value(row), 'regular', BODY, c.width - 4))) +
        4;
      if (this.y + height > BOTTOM) {
        this.newPage();
        this.tableHeader(columns);
      }
      let x = MARGIN;
      for (const column of columns) {
        this.write(column.value(row), x + 2, this.y + 2, column.width - 4, {
          align: column.align,
        });
        x += column.width;
      }
      this.y += height;
    }
    this.rule(this.y);
    this.y += 4;
  }

  /** Every entry with its running balance, then the totals. */
  entries(): void {
    const { view } = this;
    const { labels } = view;
    if (view.rows.length === 0) {
      this.ensure(20);
      this.y += this.label(labels.noEntries, MARGIN, this.y + 4, WIDTH, { align: 'center' }) + 10;
      return;
    }
    const columns = this.fit<StatementView['rows'][number]>([
      { header: labels.date, width: 56, align: 'left', value: (r) => r.date },
      {
        header: labels.particulars,
        width: 0,
        align: 'left',
        value: (r) => (r.note === null ? r.particulars : `${r.particulars}\n${r.note}`),
      },
      { header: labels.reference, width: 92, align: 'left', value: (r) => r.reference ?? '' },
      { header: labels.debit, width: MONEY.debit, align: 'right', value: (r) => r.debit },
      { header: labels.credit, width: MONEY.credit, align: 'right', value: (r) => r.credit },
      { header: labels.balance, width: MONEY.balance, align: 'right', value: (r) => r.balance },
    ]);
    this.table(columns, view.rows);
    this.ensure(14);
    const x = MARGIN + WIDTH - MONEY.balance - MONEY.credit - MONEY.debit;
    const bold = { font: 'bold', align: 'right' } as const;
    this.label(labels.total, MARGIN + 2, this.y, x - MARGIN - 4, { align: 'right' });
    this.write(view.totalDebit, x + 2, this.y, MONEY.debit - 4, bold);
    this.write(view.totalCredit, x + MONEY.debit + 2, this.y, MONEY.credit - 4, bold);
    this.write(view.closing, x + MONEY.debit + MONEY.credit + 2, this.y, MONEY.balance - 4, bold);
    this.y += this.labelHeight(labels.total, x - MARGIN - 4, BODY) + 10;
  }

  /** The ageing on the last day, and the bills still due. */
  ageing(): void {
    const { view } = this;
    const { labels } = view;
    const width = 240;
    this.ensure(this.labelHeight(labels.ageing, width, 10) + view.ageing.length * 14 + 20);
    this.y += this.label(labels.ageing, MARGIN, this.y, WIDTH, { size: 10 });
    this.y += this.write(`${labels.date.text}: ${view.ageingOn}`, MARGIN, this.y, WIDTH) + 4;
    for (const row of view.ageing) {
      if (row.key === 'outstanding' || row.key === 'net') this.rule(this.y);
      const font = row.strong ? 'bold' : 'regular';
      const height = this.label(row.label, MARGIN, this.y + 1, 150, { font });
      this.write(row.amount, MARGIN + 150, this.y + 1, width - 150, { font, align: 'right' });
      this.y += Math.max(height, 10) + 3;
    }
    this.y += 8;
    if (view.openItems.length === 0) return;
    this.ensure(this.labelHeight(labels.openItems, WIDTH, 10) + 40);
    this.y += this.label(labels.openItems, MARGIN, this.y, WIDTH, { size: 10 }) + 4;
    this.table(
      this.fit<StatementView['openItems'][number]>([
        { header: labels.reference, width: 0, align: 'left', value: (r) => r.reference },
        { header: labels.date, width: 70, align: 'left', value: (r) => r.date },
        { header: labels.dueOn, width: 70, align: 'left', value: (r) => r.dueOn },
        { header: labels.daysPastDue, width: 70, align: 'right', value: (r) => r.daysPastDue },
        { header: labels.amountDue, width: 90, align: 'right', value: (r) => r.amount },
      ]),
      view.openItems,
    );
  }

  footer(): void {
    const { labels } = this.view;
    this.ensure(this.labelHeight(labels.computerGenerated, WIDTH, SMALL) + 6);
    this.label(labels.computerGenerated, MARGIN, this.y + 4, WIDTH, {
      font: 'regular',
      size: SMALL,
      align: 'center',
    });
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

/** The statement as an A4 PDF. */
export function renderStatementPdf(view: StatementView): Promise<Buffer> {
  const doc = pdfDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    lang: 'en-IN',
    info: {
      Title: `${view.labels.statement.text} · ${view.party.name} · ${view.period}`,
      Author: view.business.legalName ?? view.business.name,
      Subject: view.labels.statement.text,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
  const pdf = new StatementPdf(doc, view);
  pdf.header();
  pdf.party();
  pdf.entries();
  pdf.ageing();
  pdf.footer();
  pdf.pageNumbers();
  doc.end();
  return done;
}
