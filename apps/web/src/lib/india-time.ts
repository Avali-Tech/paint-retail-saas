// Calendar days and wall-clock times in India, whatever the device's time zone.
// India Standard Time is UTC+05:30 all year (no daylight saving), so a fixed
// offset is exact.

const OFFSET_MS = (5 * 60 + 30) * 60_000;
/** The offset as ISO 8601 writes it. */
export const INDIA_OFFSET = '+05:30';

/** The India calendar day (YYYY-MM-DD) of a moment. */
export function indiaDay(iso: string): string {
  return new Date(Date.parse(iso) + OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's date in India (YYYY-MM-DD). */
export function todayInIndia(now: Date = new Date()): string {
  return indiaDay(now.toISOString());
}

/** A moment as a datetime-local input shows it in India: "2026-10-06T15:00". */
export function toIndiaInput(iso: string): string {
  return new Date(Date.parse(iso) + OFFSET_MS).toISOString().slice(0, 16);
}

/** A datetime-local value read as India time, with its offset: "2026-10-06T15:00:00+05:30". */
export function fromIndiaInput(value: string): string {
  return `${value}:00${INDIA_OFFSET}`;
}

/** True when the text is a datetime-local value ("2026-10-06T15:00"). */
export function isIndiaInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** True when the text is a calendar date (YYYY-MM-DD) that exists. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const moment = new Date(`${value}T00:00:00Z`);
  // 2026-02-30 rolls over to 2 March; 2026-13-01 is no date at all.
  return !Number.isNaN(moment.getTime()) && moment.toISOString().slice(0, 10) === value;
}

/** A calendar date moved by a number of days. */
export function addDays(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

/** Problems with the date range: each date must be a date, and "to" not before "from". */
export function dateRangeProblems(
  from: string,
  to: string,
): { from?: 'dateInvalid'; to?: 'dateInvalid' | 'rangeInvalid' } {
  const fromBad = from !== '' && !isDate(from);
  const toBad = to !== '' && !isDate(to);
  return {
    ...(fromBad ? { from: 'dateInvalid' as const } : {}),
    ...(toBad
      ? { to: 'dateInvalid' as const }
      : !fromBad && from !== '' && to !== '' && to < from
        ? { to: 'rangeInvalid' as const }
        : {}),
  };
}
