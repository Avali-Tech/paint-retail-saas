import { CASH_DENOMINATIONS_PAISE } from '@paint/shared';

// Day-end arithmetic for the register screens: pure, so it is tested on its own.

/** What the cashier typed against each note and coin, by paise value ("50000"). */
export type CountTexts = Readonly<Record<string, string>>;

const MAX_COUNT = 100_000;

/**
 * The typed counts as numbers (blank is none), with the denominations whose
 * text is not a whole number. Only notes and coins counted are kept.
 */
export function readCounts(texts: CountTexts): {
  readonly counts: Record<string, number>;
  readonly invalid: string[];
} {
  const counts: Record<string, number> = {};
  const invalid: string[] = [];
  for (const value of CASH_DENOMINATIONS_PAISE) {
    const key = String(value);
    const text = (texts[key] ?? '').trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text) || Number(text) > MAX_COUNT) {
      invalid.push(key);
      continue;
    }
    if (Number(text) > 0) counts[key] = Number(text);
  }
  return { counts, invalid };
}

/** Short (counted less than expected), over, or balanced. */
export type VarianceKind = 'short' | 'over' | 'balanced';

export function varianceKind(variancePaise: number): VarianceKind {
  if (variancePaise < 0) return 'short';
  return variancePaise > 0 ? 'over' : 'balanced';
}

/** Badge and alert colours: a shortfall is the worry. */
export const VARIANCE_TONE: Readonly<Record<VarianceKind, 'danger' | 'warning' | 'success'>> = {
  short: 'danger',
  over: 'warning',
  balanced: 'success',
};
