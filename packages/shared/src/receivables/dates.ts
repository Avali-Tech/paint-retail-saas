// Calendar arithmetic on India business dates ("2026-10-11"), with no clock and no time zone:
// a business date is a day, so it is counted as one in UTC, where no day is ever skipped.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * Day numbers already worked out. The engines ask for the same few thousand dates
 * millions of times (a scheme checks each GRN line's day against its period), and
 * parsing and checking a date is most of their time. Cleared when it grows past
 * DAY_CACHE_LIMIT, so it stays small whatever runs.
 */
const dayCache = new Map<string, number>();
export const DAY_CACHE_LIMIT = 20_000;

/** The day number of an ISO date (days since 1970-01-01); throws on anything else. */
export function dayNumber(iso: string): number {
  const known = dayCache.get(iso);
  if (known !== undefined) return known;
  const match = ISO_DATE.exec(iso);
  const time = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  if (!match || new Date(time).toISOString().slice(0, 10) !== iso) {
    throw new RangeError(`Invalid date "${iso}"`);
  }
  if (dayCache.size >= DAY_CACHE_LIMIT) dayCache.clear();
  dayCache.set(iso, time / DAY_MS);
  return time / DAY_MS;
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** The ISO date `days` after `iso` (before it when negative). */
export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10);
}
