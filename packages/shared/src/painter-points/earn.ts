import { assertPaise } from '../money.js';

/**
 * Painter points from invoices (roadmap P2-M36, MVP 3 spec §6.5): what an
 * invoice earns the painter or contractor tagged on it. Pure: the API loads the
 * rules and the invoice lines and posts the result.
 *
 * Exact integer arithmetic throughout: a line earns micro-points (millionths of
 * a point, rounded down), and the invoice earns their sum rounded down once, so
 * small lines still add up and the painter never gets a point the lines did not
 * make.
 */

/** Millionths of a point per point. */
export const MICRO_POINTS = 1_000_000;
/** A multiplier of ×1, in basis points. */
export const MULTIPLIER_ONE_BPS = 10_000;

export const EARN_BASES = ['per_rupee', 'per_litre'] as const;
export type EarnBasis = (typeof EARN_BASES)[number];

/**
 * A rule: `points` for every `per` of the line's taxable value in paise
 * (`per_rupee`, e.g. 1 point per ₹100 is points 1, per 10,000) or of its paint
 * in millilitres (`per_litre`, e.g. 2 points per litre is points 2, per 1,000),
 * times the multiplier.
 */
export interface EarnRule {
  readonly id: string;
  readonly basis: EarnBasis;
  readonly points: number;
  readonly per: number;
  /** Only lines of this brand; null for every brand. */
  readonly brandId: string | null;
  /** 10,000 = ×1, 15,000 = ×1.5. */
  readonly multiplierBps: number;
}

/** One invoice line, as far as points are concerned. */
export interface EarnLine {
  /** The invoice line's id. */
  readonly key: string;
  readonly brandId: string | null;
  readonly taxablePaise: number;
  /** Paint on the line in millilitres; 0 for anything not sold by volume. */
  readonly millilitres: number;
}

export interface LineEarning {
  readonly key: string;
  /** The rule the line earned by; null when none matched or it earned nothing. */
  readonly ruleId: string | null;
  /** A bigint: a large bill at a generous rate passes 2^53 millionths. */
  readonly microPoints: bigint;
}

export interface InvoiceEarning {
  /** Whole points, the lines' micro-points summed and rounded down once. */
  readonly points: number;
  readonly lines: LineEarning[];
}

/** Throws unless the rule can be applied: whole, positive numbers. */
export function assertEarnRule(rule: EarnRule): void {
  for (const [name, value] of [
    ['points', rule.points],
    ['per', rule.per],
    ['multiplierBps', rule.multiplierBps],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Earn rule ${name} must be a positive whole number`);
    }
  }
}

/** Micro-points one rule gives one line (0 when the rule does not cover its brand). */
export function lineMicroPoints(line: EarnLine, rule: EarnRule): bigint {
  assertPaise(line.taxablePaise);
  if (rule.brandId !== null && rule.brandId !== line.brandId) return 0n;
  const amount = rule.basis === 'per_rupee' ? line.taxablePaise : line.millilitres;
  if (amount <= 0) return 0n;
  return (
    (BigInt(amount) * BigInt(rule.points) * BigInt(rule.multiplierBps) * BigInt(MICRO_POINTS)) /
    (BigInt(rule.per) * BigInt(MULTIPLIER_ONE_BPS))
  );
}

/**
 * The best matching rule for a line: a rule for the line's brand wins over a
 * rule for every brand (so an owner can set a brand lower as well as higher);
 * among those, the one that earns most, then the lowest id, so the choice never
 * depends on the order the rules came in. Null when nothing earns.
 */
export function bestRuleFor(
  line: EarnLine,
  rules: readonly EarnRule[],
): { readonly rule: EarnRule; readonly microPoints: bigint } | null {
  const candidates = (brandOnly: boolean) =>
    rules
      .filter((rule) => (brandOnly ? rule.brandId !== null : rule.brandId === null))
      .map((rule) => ({ rule, microPoints: lineMicroPoints(line, rule) }))
      .filter((candidate) => candidate.microPoints > 0n)
      .sort((a, b) =>
        a.microPoints === b.microPoints
          ? a.rule.id.localeCompare(b.rule.id)
          : a.microPoints > b.microPoints
            ? -1
            : 1,
      );
  return candidates(true)[0] ?? candidates(false)[0] ?? null;
}

/** What an invoice earns under `rules`. */
export function earnInvoice(
  lines: readonly EarnLine[],
  rules: readonly EarnRule[],
): InvoiceEarning {
  rules.forEach(assertEarnRule);
  const earned = lines.map((line): LineEarning => {
    const best = bestRuleFor(line, rules);
    return { key: line.key, ruleId: best?.rule.id ?? null, microPoints: best?.microPoints ?? 0n };
  });
  const micro = earned.reduce((sum, line) => sum + line.microPoints, 0n);
  return { points: Number(micro / BigInt(MICRO_POINTS)), lines: earned };
}

const UNIT_MILLILITRES = { l: 1000, ml: 1 } as const;

/**
 * Millilitres of paint on a line of `quantity` packs of `packSize` `unit`
 * (both to 3 decimals, as stored), rounded to the nearest millilitre; 0 for
 * anything not measured by volume (kg, pieces).
 */
export function lineMillilitres(quantity: number, packSize: number, unit: string): number {
  const perUnit = (UNIT_MILLILITRES as Record<string, number | undefined>)[unit];
  if (perUnit === undefined || quantity <= 0) return 0;
  const thousandths = (value: number) => BigInt(Math.round(value * 1000));
  // quantity × packSize × perUnit, with both factors in thousandths.
  const scaled = thousandths(quantity) * thousandths(packSize) * BigInt(perUnit);
  return Number((scaled + 500_000n) / 1_000_000n);
}
