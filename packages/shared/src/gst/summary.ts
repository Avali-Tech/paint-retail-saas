import { roundDiv, toPaise } from './arith.js';
import type { AppliedRate, TaxHeads, TaxNature } from './types.js';

/** A line's tax heads with the rate it was taxed at (null on a bill of supply). */
export interface TaxedLine extends TaxHeads {
  readonly rate: AppliedRate | null;
}

/** One row of the invoice's tax summary: everything taxed at one nature, rate and cess. */
export interface TaxSummaryRow extends TaxHeads {
  readonly nature: TaxNature;
  readonly rateBasisPoints: number;
  readonly cessBasisPoints: number;
  readonly taxPaise: number;
}

export interface DocumentTotals extends TaxHeads {
  readonly taxPaise: number;
  /** Taxable value plus tax, before the round-off. */
  readonly totalPaise: number;
  /** Whole-rupee adjustment, from −49 to +50 paise; 0 when round-off is off. */
  readonly roundOffPaise: number;
  /** What the buyer pays (or is refunded): total plus round-off. */
  readonly payablePaise: number;
}

export const taxOf = (heads: TaxHeads) =>
  heads.cgstPaise + heads.sgstPaise + heads.igstPaise + heads.cessPaise;

function addHeads(a: TaxHeads, b: TaxHeads): TaxHeads {
  return {
    taxablePaise: a.taxablePaise + b.taxablePaise,
    cgstPaise: a.cgstPaise + b.cgstPaise,
    sgstPaise: a.sgstPaise + b.sgstPaise,
    igstPaise: a.igstPaise + b.igstPaise,
    cessPaise: a.cessPaise + b.cessPaise,
  };
}

export const ZERO_HEADS: TaxHeads = {
  taxablePaise: 0,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 0,
  cessPaise: 0,
};

/** The tax summary, one row per nature, rate and cess, ordered by rate, then cess, then nature. */
export function summarize(lines: readonly TaxedLine[]): TaxSummaryRow[] {
  const groups = new Map<string, TaxSummaryRow>();
  for (const line of lines) {
    if (line.rate === null) continue;
    const { nature, rateBasisPoints, cessBasisPoints } = line.rate;
    const key = `${nature}|${String(rateBasisPoints)}|${String(cessBasisPoints)}`;
    const heads = addHeads(groups.get(key) ?? ZERO_HEADS, line);
    groups.set(key, { nature, rateBasisPoints, cessBasisPoints, ...heads, taxPaise: taxOf(heads) });
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.rateBasisPoints - b.rateBasisPoints ||
      a.cessBasisPoints - b.cessBasisPoints ||
      a.nature.localeCompare(b.nature),
  );
}

/** Adds up the lines and applies the round-off to the nearest rupee (half a rupee rounds up). */
export function documentTotals(lines: readonly TaxHeads[], roundOff: boolean): DocumentTotals {
  const heads = lines.reduce(addHeads, ZERO_HEADS);
  const taxPaise = taxOf(heads);
  const totalPaise = heads.taxablePaise + taxPaise;
  const payablePaise = roundOff ? toPaise(roundDiv(BigInt(totalPaise), 100n) * 100n) : totalPaise;
  return {
    ...heads,
    taxPaise,
    totalPaise,
    roundOffPaise: payablePaise - totalPaise,
    payablePaise,
  };
}
