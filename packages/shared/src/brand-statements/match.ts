import type {
  StatementLineKind,
  StatementLineStatus,
  StatementSummary,
  StatementTolerance,
} from './api.js';
import { normalizeReference } from './parse.js';

/**
 * Matching a statement's lines with our records (P2-M34): pure and deterministic, so a
 * run gives the same pairs whatever order the rows arrive in, and running it again on
 * its own result changes nothing. Members' matches and explanations are fixed inputs: a
 * run never moves them.
 */

export interface MatchLine {
  readonly id: string;
  readonly rowNumber: number;
  readonly lineDate: string;
  readonly kind: StatementLineKind;
  readonly documentNumber: string | null;
  readonly reference: string | null;
  readonly amountPaise: number;
}

export interface MatchRecord {
  /** Unique: `grn:<id>` or `benefit_receipt:<id>`. */
  readonly key: string;
  readonly date: string;
  /** References it may be named by: a GRN's supplier invoice number, a receipt's reference. */
  readonly references: readonly (string | null)[];
  /** Signed as the statement shows it. */
  readonly amountPaise: number;
}

/** A line a member settled: matched to a record, or explained (no record). */
export interface FixedSettlement {
  readonly lineId: string;
  readonly recordKey: string | null;
}

export interface MatchInput {
  readonly lines: readonly MatchLine[];
  readonly records: readonly MatchRecord[];
  readonly fixed: readonly FixedSettlement[];
  /** Pairs a member unmatched: never proposed again. */
  readonly rejected: readonly { readonly lineId: string; readonly recordKey: string }[];
  /** Records settling a line of another statement. */
  readonly elsewhere: ReadonlySet<string>;
  readonly tolerance: StatementTolerance;
}

export interface AutoMatch {
  readonly lineId: string;
  readonly recordKey: string;
  /** Line amount − record amount. */
  readonly differencePaise: number;
  /** `reference` when found by its number, `amount` by date window and amount. */
  readonly by: 'reference' | 'amount';
}

const DAY = 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Lines never matched: openings (the balance brought forward) and our payments ([PO-92]). */
export const unmatchable = (kind: StatementLineKind) => kind === 'opening' || kind === 'payment';

/**
 * The automatic pairs for a statement. Lines are taken in date order (then row), each
 * paired with at most one record of the same sign (a debit with a GRN, a credit with
 * scheme money) and each record used once:
 * 1. by reference: a record named by the line's document number or reference, whatever
 *    the amount (a difference beyond the tolerance shows it partly matched); of several,
 *    the closest amount, then date, then key;
 * 2. then by date window and amount: a record dated within the window whose amount is
 *    within the tolerance; the closest amount, then date, then key.
 */
export function matchStatement(input: MatchInput): AutoMatch[] {
  const { tolerance } = input;
  const fixedLines = new Set(input.fixed.map((settled) => settled.lineId));
  const used = new Set<string>(input.elsewhere);
  for (const settled of input.fixed) if (settled.recordKey !== null) used.add(settled.recordKey);
  const rejected = new Set(input.rejected.map((pair) => `${pair.lineId}|${pair.recordKey}`));

  const lines = input.lines
    .filter((line) => !fixedLines.has(line.id) && !unmatchable(line.kind))
    .toSorted((a, b) => compare(a.lineDate, b.lineDate) || a.rowNumber - b.rowNumber);
  const records = input.records
    .map((record) => ({
      ...record,
      names: new Set(record.references.map(normalizeReference).filter((name) => name !== '')),
    }))
    .toSorted((a, b) => compare(a.date, b.date) || compare(a.key, b.key));

  const best = <T extends (typeof records)[number]>(line: MatchLine, candidates: T[]) =>
    candidates
      .map((record) => ({
        record,
        gap: Math.abs(line.amountPaise - record.amountPaise),
        days: daysApart(line.lineDate, record.date),
      }))
      .sort((a, b) => a.gap - b.gap || a.days - b.days || compare(a.record.key, b.record.key))[0]
      ?.record;

  const open = (line: MatchLine) =>
    records.filter(
      (record) =>
        !used.has(record.key) &&
        Math.sign(record.amountPaise) === Math.sign(line.amountPaise) &&
        !rejected.has(`${line.id}|${record.key}`),
    );

  const matches: AutoMatch[] = [];
  const take = (line: MatchLine, record: MatchRecord, by: AutoMatch['by']) => {
    used.add(record.key);
    matches.push({
      lineId: line.id,
      recordKey: record.key,
      differencePaise: line.amountPaise - record.amountPaise,
      by,
    });
  };

  const left: MatchLine[] = [];
  for (const line of lines) {
    const names = [line.documentNumber, line.reference]
      .map(normalizeReference)
      .filter((name) => name !== '');
    const named = best(
      line,
      open(line).filter((record) => names.some((name) => record.names.has(name))),
    );
    if (named) take(line, named, 'reference');
    else left.push(line);
  }
  for (const line of left) {
    const near = best(
      line,
      open(line).filter(
        (record) =>
          daysApart(line.lineDate, record.date) <= tolerance.dateWindowDays &&
          Math.abs(line.amountPaise - record.amountPaise) <= tolerance.amountTolerancePaise,
      ),
    );
    if (near) take(line, near, 'amount');
  }
  return matches.sort((a, b) => compare(a.lineId, b.lineId));
}

/** Where a line stands, from how it was settled. */
export function lineStatus(
  line: { readonly kind: StatementLineKind },
  settlement: { readonly explained: boolean; readonly differencePaise: number | null } | null,
  tolerance: StatementTolerance,
): StatementLineStatus {
  if (settlement?.explained) return 'explained';
  if (settlement && settlement.differencePaise !== null) {
    return Math.abs(settlement.differencePaise) <= tolerance.amountTolerancePaise
      ? 'matched'
      : 'partial';
  }
  return line.kind === 'payment' ? 'untracked' : 'unmatched';
}

export interface SummaryLine {
  readonly kind: StatementLineKind;
  readonly amountPaise: number;
  readonly status: StatementLineStatus;
  /** Line − record, for a matched or partial line. */
  readonly differencePaise: number | null;
}

export interface SummaryRecord {
  readonly amountPaise: number;
  readonly inPeriod: boolean;
  /** Settles a line of this statement. */
  readonly matched: boolean;
  /** Settles a line of another statement. */
  readonly elsewhere: boolean;
}

/**
 * The period's figures: the brand's movement (its lines, the opening left out) against
 * ours (the records its lines settle, and ours in the period no line settles). The
 * difference always equals the amount differences, plus the brand's lines we do not
 * have (unmatched, explained, untracked), less our records it does not show.
 */
export function statementSummary(
  lines: readonly SummaryLine[],
  records: readonly SummaryRecord[],
  balances: {
    readonly openingBalancePaise: number | null;
    readonly printedClosingPaise: number | null;
  },
): StatementSummary {
  const counts: Record<StatementLineStatus, number> = {
    matched: 0,
    partial: 0,
    unmatched: 0,
    explained: 0,
    untracked: 0,
  };
  const sums: Record<StatementLineStatus, number> = { ...counts };
  let brand = 0;
  let differences = 0;
  for (const line of lines) {
    if (line.kind === 'opening') continue;
    counts[line.status] += 1;
    sums[line.status] += line.amountPaise;
    brand += line.amountPaise;
    differences += line.differencePaise ?? 0;
  }
  const ourUnmatched = records.filter(
    (record) => !record.matched && !record.elsewhere && record.inPeriod,
  );
  const ourUnmatchedPaise = ourUnmatched.reduce((sum, record) => sum + record.amountPaise, 0);
  const ours =
    records
      .filter((record) => record.matched)
      .reduce((sum, record) => sum + record.amountPaise, 0) + ourUnmatchedPaise;
  return {
    counts,
    brandMovementPaise: brand,
    ourMovementPaise: ours,
    differencePaise: brand - ours,
    amountDifferencesPaise: differences,
    unmatchedLinesPaise: sums.unmatched,
    explainedLinesPaise: sums.explained,
    untrackedLinesPaise: sums.untracked,
    ourUnmatchedPaise,
    ourUnmatchedCount: ourUnmatched.length,
    openingBalancePaise: balances.openingBalancePaise,
    brandClosingPaise:
      balances.openingBalancePaise === null ? null : balances.openingBalancePaise + brand,
    printedClosingPaise: balances.printedClosingPaise,
  };
}
