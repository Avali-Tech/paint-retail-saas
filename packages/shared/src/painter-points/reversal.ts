import { assertPaise } from '../money.js';
import type { EarnLine, InvoiceEarning } from './earn.js';

/**
 * Taking painter points back (P2-M36, spec §6.5). A credit note takes back the
 * invoice's points in proportion to the value it credits, line by line: each
 * line weighs what it earned, so returning a double-points brand takes back
 * more than returning the same value of hardware.
 *
 * Reversal is cumulative: the points taken back after a note are the invoice's
 * points times everything credited so far (rounded half up), less what the
 * earlier notes' share was. So any number of partial notes that credit the
 * whole invoice take back exactly what it earned, never a point more or less.
 */

/** An invoice line with the weight its points are spread by. */
export interface WeightedLine {
  readonly key: string;
  readonly taxablePaise: number;
  readonly weight: bigint;
}

/** Taxable value a credit note credits against one invoice line. */
export interface CreditedLine {
  /** The invoice line's id (the note line's source line). */
  readonly key: string;
  readonly creditedTaxablePaise: number;
}

/**
 * Weights for an invoice's lines: what each earned; when no line earned
 * anything (the rules that earned them are gone), the lines' taxable value.
 */
export function weighLines(lines: readonly EarnLine[], earning: InvoiceEarning): WeightedLine[] {
  const earned = new Map(earning.lines.map((line) => [line.key, line.microPoints]));
  const byEarning = lines.map((line) => ({
    key: line.key,
    taxablePaise: line.taxablePaise,
    weight: earned.get(line.key) ?? 0n,
  }));
  if (byEarning.some((line) => line.weight > 0n)) return byEarning;
  return byEarning.map((line) => ({
    ...line,
    weight: BigInt(Math.max(line.taxablePaise, 0)),
  }));
}

/**
 * The points that should have been taken back once `credited` (every note so
 * far, any order, a line may repeat) is credited against an invoice that
 * earned `earnedPoints`. Never more than earned; exactly earned once every
 * line is credited in full.
 */
export function reversalTarget(
  earnedPoints: number,
  lines: readonly WeightedLine[],
  credited: readonly CreditedLine[],
): number {
  if (!Number.isSafeInteger(earnedPoints) || earnedPoints < 0) {
    throw new RangeError('Earned points must be a whole number, not negative');
  }
  const creditedByLine = new Map<string, number>();
  for (const line of credited) {
    assertPaise(line.creditedTaxablePaise);
    creditedByLine.set(
      line.key,
      (creditedByLine.get(line.key) ?? 0) + Math.max(line.creditedTaxablePaise, 0),
    );
  }
  let total = 0n;
  let share = 0n;
  for (const line of lines) {
    if (line.weight <= 0n || line.taxablePaise <= 0) continue;
    total += line.weight;
    const creditedPaise = Math.min(creditedByLine.get(line.key) ?? 0, line.taxablePaise);
    share += (line.weight * BigInt(creditedPaise)) / BigInt(line.taxablePaise);
  }
  if (earnedPoints === 0 || total === 0n) return 0;
  // Half up: (2·earned·share + total) / (2·total).
  const target = (2n * BigInt(earnedPoints) * share + total) / (2n * total);
  return Math.min(earnedPoints, Number(target));
}

/**
 * What one reversal posts: the step from the earlier notes' target to this
 * one's, but never more than the painter has left. Points already spent are
 * not clawed back (the balance never goes below zero); the shortfall is
 * forgiven, reported and not carried to later earnings.
 */
export function pointsToTakeBack(input: {
  readonly targetBefore: number;
  readonly targetNow: number;
  readonly balance: number;
}): { readonly points: number; readonly forgiven: number } {
  const due = Math.max(input.targetNow - input.targetBefore, 0);
  const points = Math.min(due, Math.max(input.balance, 0));
  return { points, forgiven: due - points };
}
