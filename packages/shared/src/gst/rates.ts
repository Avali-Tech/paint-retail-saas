import { GstError } from './errors.js';
import type { AppliedRate, GstRate } from './types.js';

const ISO_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** Throws unless `date` is an ISO `YYYY-MM-DD` date. */
export function checkDate(date: string, what: string): void {
  if (!ISO_DATE.test(date)) {
    throw new GstError('invalid_date', `${what} must be YYYY-MM-DD, got "${date}"`);
  }
}

function checkRate(rate: GstRate): void {
  checkDate(rate.effectiveFrom, 'effectiveFrom');
  if (rate.effectiveTo !== null) {
    checkDate(rate.effectiveTo, 'effectiveTo');
    if (rate.effectiveTo < rate.effectiveFrom) {
      throw new GstError('invalid_date', `Rate for ${rate.categoryCode} ends before it starts`);
    }
  }
  const valid = (bps: number) => Number.isSafeInteger(bps) && bps >= 0;
  if (
    !valid(rate.rateBasisPoints) ||
    rate.rateBasisPoints > 10_000 ||
    !valid(rate.cessBasisPoints)
  ) {
    throw new GstError('invalid_rate', `Invalid rate for ${rate.categoryCode}`);
  }
  if (rate.nature !== 'taxable' && rate.rateBasisPoints + rate.cessBasisPoints > 0) {
    throw new GstError('invalid_rate', `A ${rate.nature} category cannot carry a rate`);
  }
}

/**
 * The rate for `categoryCode` on `date` (ISO, matched inclusively at both ends).
 * Every row for the category is validated first.
 * Throws when no row covers the date, or when two rows overlap on it, since an
 * ambiguous table must never silently pick a rate.
 */
export function rateOn(rates: readonly GstRate[], categoryCode: string, date: string): AppliedRate {
  checkDate(date, 'Invoice date');
  const rows = rates.filter((rate) => rate.categoryCode === categoryCode);
  // Every row of the category is checked, not just the match, so a bad table fails early.
  rows.forEach(checkRate);
  const matches = rows.filter(
    (rate) => rate.effectiveFrom <= date && (rate.effectiveTo === null || date <= rate.effectiveTo),
  );
  const [match, ...others] = matches;
  if (!match) throw new GstError('no_rate', `No GST rate for ${categoryCode} on ${date}`);
  if (others.length > 0) {
    throw new GstError(
      'overlapping_rates',
      `${String(matches.length)} GST rates for ${categoryCode} on ${date}`,
    );
  }
  return {
    nature: match.nature,
    rateBasisPoints: match.rateBasisPoints,
    cessBasisPoints: match.cessBasisPoints,
  };
}
