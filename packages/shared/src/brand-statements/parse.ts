import {
  MAX_STATEMENT_LINES,
  TYPED_LINE_KINDS,
  type ParsedStatementLine,
  type StatementDateFormat,
  type StatementLayout,
  type StatementLineKind,
  type StatementRowProblem,
  type StatementTypeRules,
} from './api.js';

/**
 * Reading a statement's rows with its template (P2-M34): pure, so the API and its tests
 * read files the same way. Cells arrive as text, from a CSV or an Excel sheet.
 */

/** A header or a template's column name, compared without regard to case or spacing. */
export function normalizeHeader(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A reference compared without regard to case, spaces or punctuation: "inv/0881" = "INV-0881". */
export function normalizeReference(text: string | null): string {
  return (text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Days from 1899-12-30, as Excel counts dates. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function isoOf(year: number, month: number, day: number): string | null {
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

const fullYear = (year: string) => (year.length === 2 ? 2000 + Number(year) : Number(year));

/**
 * A statement's date in the template's format, or an Excel day number (a date cell);
 * null when it is not a real day. A time after the date is ignored.
 */
export function parseStatementDate(text: string, format: StatementDateFormat): string | null {
  const value = text.trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?$/i, '');
  if (/^\d{5}(\.\d+)?$/.test(value)) {
    const days = Math.floor(Number(value));
    return new Date(EXCEL_EPOCH + days * 86_400_000).toISOString().slice(0, 10);
  }
  if (format === 'dd-mon-yyyy') {
    const match = /^(\d{1,2})[\s./-]*([A-Za-z]{3})[A-Za-z]*[\s./,-]*(\d{4}|\d{2})$/.exec(value);
    if (!match) return null;
    const month = MONTHS.indexOf(String(match[2]).toLowerCase()) + 1;
    return month === 0 ? null : isoOf(fullYear(String(match[3])), month, Number(match[1]));
  }
  if (format === 'yyyy-mm-dd') {
    const match = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(value);
    return match ? isoOf(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  }
  const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/.exec(value);
  if (!match) return null;
  const [first, second] = [Number(match[1]), Number(match[2])];
  const year = fullYear(String(match[3]));
  return format === 'dd-mm-yyyy' ? isoOf(year, second, first) : isoOf(year, first, second);
}

export type ParsedAmount =
  | { readonly kind: 'blank' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'amount'; readonly paise: number; readonly side: 'dr' | 'cr' | null };

/**
 * An amount as statements print it: ₹1,23,456.50, 1234.5, -1,234, (1,234.00) for a
 * negative, or with a Dr / Cr after it. At most two decimals; a dash alone is blank.
 */
export function parseStatementAmount(text: string): ParsedAmount {
  let value = text
    .trim()
    .replace(/^(₹|rs\.?|inr)\s*/i, '')
    .replaceAll(',', '')
    .replace(/\s+/g, ' ');
  if (value === '' || value === '-') return { kind: 'blank' };
  let side: 'dr' | 'cr' | null = null;
  const marked = /^(.*?)\s*(dr|cr)\.?$/i.exec(value);
  if (marked) {
    side = String(marked[2]).toLowerCase() as 'dr' | 'cr';
    value = String(marked[1]).trim();
  }
  let negative = false;
  const bracketed = /^\((.*)\)$/.exec(value);
  if (bracketed) {
    negative = true;
    value = String(bracketed[1]).trim();
  }
  const match = /^([+-])?(?:₹\s*)?(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return { kind: 'invalid' };
  const paise = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise > 1_00_00_00_00_000) return { kind: 'invalid' };
  if (match[1] === '-') negative = !negative;
  return { kind: 'amount', paise: negative && paise !== 0 ? -paise : paise, side };
}

/**
 * The kind of a line from its type text and the template's words for each kind (a word
 * names a kind when the text is that word or starts with it), else from its sign: a debit
 * is an invoice, a credit is `other` (a credit note or a payment: matched, never hidden).
 */
export function classifyLine(
  typeText: string | null,
  rules: StatementTypeRules,
  amountPaise: number,
): StatementLineKind {
  const text = normalizeHeader(typeText ?? '');
  if (text !== '') {
    for (const kind of TYPED_LINE_KINDS) {
      for (const word of rules[kind] ?? []) {
        const wanted = normalizeHeader(word);
        const next = text.charAt(wanted.length);
        if (wanted !== '' && text.startsWith(wanted) && !/[a-z0-9]/.test(next)) return kind;
      }
    }
  }
  return amountPaise > 0 ? 'invoice' : 'other';
}

export interface ParsedStatement {
  readonly lines: ParsedStatementLine[];
  readonly errors: StatementRowProblem[];
  readonly skipped: StatementRowProblem[];
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly openingBalancePaise: number | null;
}

const clip = (text: string, max: number): string | null => {
  const value = text.replace(/\s+/g, ' ').trim();
  return value === '' ? null : value.slice(0, max);
};

/**
 * Reads a statement's rows (as text) with its layout: the header after the rows to skip,
 * then one line per row with a date and an amount. Blank rows, totals and rows with no
 * date or no amount are skipped and listed; a row with a date and an unreadable amount
 * (or the reverse) is an error, as is a missing column.
 */
export function parseStatementRows(
  rows: readonly (readonly string[])[],
  layout: StatementLayout,
): ParsedStatement {
  const errors: StatementRowProblem[] = [];
  const skipped: StatementRowProblem[] = [];
  const lines: ParsedStatementLine[] = [];
  const headerIndex = layout.headerRowsToSkip;
  const header = (rows[headerIndex] ?? []).map(normalizeHeader);
  const columnOf = (name: string | null): number | null => {
    if (name === null) return null;
    const index = header.indexOf(normalizeHeader(name));
    if (index === -1) {
      errors.push({
        row: headerIndex + 1,
        column: name,
        message: `No column "${name}" in the header row (row ${String(headerIndex + 1)})`,
      });
    }
    return index;
  };
  const columns = {
    date: columnOf(layout.dateColumn),
    document: columnOf(layout.documentColumn),
    type: columnOf(layout.typeColumn),
    reference: columnOf(layout.referenceColumn),
    description: columnOf(layout.descriptionColumn),
    debit: layout.amountMode === 'debit_credit' ? columnOf(layout.debitColumn) : null,
    credit: layout.amountMode === 'debit_credit' ? columnOf(layout.creditColumn) : null,
    amount: layout.amountMode === 'signed' ? columnOf(layout.amountColumn) : null,
  };
  const empty = {
    lines,
    errors,
    skipped,
    periodFrom: null,
    periodTo: null,
    openingBalancePaise: null,
  };
  if (errors.length > 0) return empty;

  const cell = (row: readonly string[], index: number | null) =>
    index === null ? '' : (row[index] ?? '').trim();

  for (const [index, row] of rows.entries()) {
    if (index <= headerIndex) continue;
    const rowNumber = index + 1;
    if (row.every((value) => value.trim() === '')) continue;
    const dateText = cell(row, columns.date);
    const lineDate = parseStatementDate(dateText, layout.dateFormat);

    let amountPaise: number | null = null;
    let amountProblem: string | null = null;
    if (layout.amountMode === 'debit_credit') {
      const debit = parseStatementAmount(cell(row, columns.debit));
      const credit = parseStatementAmount(cell(row, columns.credit));
      if (debit.kind === 'invalid' || credit.kind === 'invalid') {
        amountProblem = 'The debit or credit is not an amount';
      } else if (debit.kind === 'amount' || credit.kind === 'amount') {
        amountPaise =
          (debit.kind === 'amount' ? Math.abs(debit.paise) : 0) -
          (credit.kind === 'amount' ? Math.abs(credit.paise) : 0);
      }
    } else {
      const amount = parseStatementAmount(cell(row, columns.amount));
      if (amount.kind === 'invalid') {
        amountProblem = 'The amount is not an amount';
      } else if (amount.kind === 'amount') {
        const magnitude = Math.abs(amount.paise);
        const debit =
          amount.side === null
            ? amount.paise >= 0 === (layout.signConvention === 'debit_positive')
            : amount.side === 'dr';
        amountPaise = debit ? magnitude : -magnitude;
      }
    }

    const typeText = clip(cell(row, columns.type), 60);
    const label = row
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .join(' ');
    if (lineDate === null) {
      if (
        amountProblem === null &&
        (dateText === '' || amountPaise === null || /total|balance/i.test(label))
      ) {
        skipped.push({ row: rowNumber, column: null, message: label.slice(0, 120) });
      } else {
        errors.push({
          row: rowNumber,
          column: layout.dateColumn,
          message: `"${dateText}" is not a date written ${layout.dateFormat.toUpperCase()}`,
        });
      }
      continue;
    }
    if (amountProblem !== null) {
      errors.push({ row: rowNumber, column: null, message: amountProblem });
      continue;
    }
    const kind = classifyLine(typeText, layout.typeRules, amountPaise ?? 0);
    if ((amountPaise === null || amountPaise === 0) && kind !== 'opening') {
      skipped.push({ row: rowNumber, column: null, message: label.slice(0, 120) });
      continue;
    }
    lines.push({
      rowNumber,
      lineDate,
      kind,
      documentNumber: clip(cell(row, columns.document), 60),
      typeText,
      reference: clip(cell(row, columns.reference), 120),
      description: clip(cell(row, columns.description), 300),
      amountPaise: amountPaise ?? 0,
    });
  }

  if (lines.length > MAX_STATEMENT_LINES) {
    errors.push({
      row: 0,
      column: null,
      message: `A statement has at most ${MAX_STATEMENT_LINES.toLocaleString('en-IN')} lines`,
    });
  }
  if (errors.length === 0 && lines.length === 0) {
    errors.push({
      row: 0,
      column: null,
      message: 'The file has no lines with a date and an amount',
    });
  }
  const dates = lines.map((line) => line.lineDate).sort();
  const openings = lines.filter((line) => line.kind === 'opening');
  return {
    lines,
    errors,
    skipped,
    periodFrom: dates[0] ?? null,
    periodTo: dates.at(-1) ?? null,
    openingBalancePaise:
      openings.length === 0 ? null : openings.reduce((sum, line) => sum + line.amountPaise, 0),
  };
}
