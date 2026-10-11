import { at } from '../gst/arith.js';
import type { InvoiceView, PartyView } from './types.js';

/**
 * The invoice as fixed-width text for an 80 mm thermal printer: 48 columns at
 * 12 cpi (72 mm printable). For ESC/POS printing and plain-text sharing; the
 * browser prints the HTML version. English only and "Rs" rather than "₹": counter
 * printers' built-in fonts have neither Indic scripts nor the rupee sign.
 */
export const THERMAL_COLUMNS = 48;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
/** User-perceived characters, so a Devanagari or Telugu syllable counts once. */
const graphemes = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);
const width = (text: string) => graphemes(text).length;

/** Greedy word wrap; a word longer than the line is cut. Always at least one line. */
export function wrapText(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    let rest = word;
    while (width(rest) > columns) {
      if (line !== '') lines.push(line);
      line = '';
      const parts = graphemes(rest);
      lines.push(parts.slice(0, columns).join(''));
      rest = parts.slice(columns).join('');
    }
    if (line === '') line = rest;
    else if (width(line) + 1 + width(rest) <= columns) line = `${line} ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  // The last line: never empty unless the text has no words at all.
  lines.push(line);
  return lines;
}

const padEnd = (text: string, columns: number) =>
  text + ' '.repeat(Math.max(0, columns - width(text)));
const padStart = (text: string, columns: number) =>
  ' '.repeat(Math.max(0, columns - width(text))) + text;

/** Centred, wrapped. */
function centre(text: string, columns: number): string[] {
  return wrapText(text, columns).map((line) =>
    padEnd(' '.repeat(Math.floor((columns - width(line)) / 2)) + line, columns).trimEnd(),
  );
}

/** Label on the left, value on the right; the value goes under the label when both do not fit. */
function pair(left: string, right: string, columns: number): string[] {
  if (width(left) + 1 + width(right) <= columns) {
    return [left + padStart(right, columns - width(left))];
  }
  return [
    ...wrapText(left, columns),
    ...wrapText(right, columns).map((line) => padStart(line, columns)),
  ];
}

/** One row of fixed-width cells; the first is left-aligned, the rest right-aligned. */
function row(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) =>
      index === 0 ? padEnd(cell, at(widths, index)) : padStart(cell, at(widths, index)),
    )
    .join('')
    .trimEnd();
}

function party(title: string, view: PartyView, columns: number): string[] {
  return [
    ...wrapText(`${title}: ${view.name}`, columns),
    ...(view.gstin === null ? [] : [`GSTIN: ${view.gstin}`]),
    ...view.addressLines.flatMap((line) => wrapText(line, columns)),
    ...(view.state === null ? [] : wrapText(`State: ${view.state}`, columns)),
    ...(view.phone === null ? [] : [`Phone: ${view.phone}`]),
  ];
}

/** Splits `total` columns into `count` parts, the last taking what is left. */
function split(total: number, count: number): number[] {
  const each = Math.floor(total / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? total - each * (count - 1) : each,
  );
}

/** The invoice as lines of at most `columns` characters, joined with "\n". */
export function renderThermalText(view: InvoiceView, columns = THERMAL_COLUMNS): string {
  const { labels } = view;
  const rule = '-'.repeat(columns);
  const out: string[] = [];
  const add = (...lines: string[]) => {
    out.push(...lines);
  };

  add(...centre(view.business.name.toUpperCase(), columns));
  if (view.business.name !== view.supplier.legalName)
    add(...centre(view.supplier.legalName, columns));
  for (const line of view.supplier.addressLines) add(...centre(line, columns));
  add(...centre(view.supplier.state, columns));
  add(...centre(`GSTIN: ${view.supplier.gstin}`, columns));
  if (view.supplier.phone !== null) add(...centre(`Phone: ${view.supplier.phone}`, columns));
  add('', ...centre(view.title.text.toUpperCase(), columns));
  if (view.compositionNotice !== null) add(...centre(view.compositionNotice, columns));
  if (view.copyMark !== null) add(...centre(view.copyMark, columns));
  add(rule);

  const numberLabel = view.kind === 'tax_invoice' ? labels.invoiceNumber : labels.billNumber;
  add(...pair(`${numberLabel.text} ${view.number}`, `${labels.date.text} ${view.date}`, columns));
  add(...wrapText(`${labels.placeOfSupply.text}: ${view.placeOfSupply}`, columns));
  if (view.reverseCharge !== null) {
    add(...wrapText(`${labels.reverseCharge.text}: ${view.reverseCharge}`, columns));
  }
  add(...party(labels.billTo.text, view.buyer, columns));
  if (view.shipTo !== null) {
    add(...wrapText(`${labels.shipTo.text}: ${view.shipTo.addressLines.join(', ')}`, columns));
    add(...wrapText(`State: ${view.shipTo.state}`, columns));
  }
  add(rule);

  // Items: the name and size, then HSN and rate, then quantity × price and the amount.
  add(...pair(labels.description.text, labels.amount.text, columns));
  add(rule);
  for (const line of view.lines) {
    const name = line.variant === null ? line.description : `${line.description} ${line.variant}`;
    add(...wrapText(`${String(line.serial)}. ${name}`, columns));
    const meta = [
      line.hsn === '' ? null : `HSN ${line.hsn}`,
      line.rate === null ? null : `GST ${line.rate}`,
    ].filter((part) => part !== null);
    if (meta.length > 0) add(`   ${meta.join('  ')}`);
    add(...pair(`   ${line.quantity} ${line.uqc} x ${line.price}`, line.amount, columns));
    if (line.discount !== null) {
      add(...pair(`   ${labels.discount.text}`, `-${line.discount}`, columns));
    }
  }
  add(rule);

  for (const total of view.totals) {
    if (total.key === 'grandTotal') {
      add(rule, ...pair(total.label.text.toUpperCase(), `Rs ${total.amount}`, columns));
    } else add(...pair(total.label.text, total.amount, columns));
  }
  add(rule);

  if (view.taxSummary.length > 0) {
    add(labels.taxSummary.text);
    const widths = [6, 12, ...split(columns - 18, view.taxColumns.length)];
    add(row([labels.rate.text, 'Taxable', ...view.taxColumns.map((c) => c.label)], widths));
    for (const summary of view.taxSummary) {
      add(
        row(
          [
            summary.rate,
            summary.taxable,
            ...view.taxColumns.map((c) => String(summary.taxes[c.key])),
          ],
          widths,
        ),
      );
    }
    add(rule);
  }

  add(...wrapText(view.amountInWords, columns));
  for (const [title, lines] of [
    [labels.notes.text, view.notes],
    [labels.terms.text, view.terms],
  ] as const) {
    if (lines.length > 0) add('', `${title}:`, ...lines.flatMap((line) => wrapText(line, columns)));
  }
  add('', ...wrapText(view.signatory.forLine, columns));
  add(
    '',
    '',
    ...(view.signatory.name === null ? [] : [view.signatory.name]),
    labels.authorisedSignatory.text,
  );
  return out.join('\n');
}
