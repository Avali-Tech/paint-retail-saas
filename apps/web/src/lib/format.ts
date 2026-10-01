import { formatINR, type Paise } from '@paint/shared';

// Indian formats: lakh/crore grouping (12,34,567), rupees from paise, and dates
// and times in India time whatever the device's time zone.

export const INDIA_TIME_ZONE = 'Asia/Kolkata';

/** 1234567 -> "12,34,567" (Indian grouping). */
export function formatNumber(value: number, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** 85000050 paise -> "₹8,50,000.50". */
export function formatMoney(paise: Paise): string {
  return formatINR(paise);
}

const LAKH = 100_000;
const CRORE = 10_000_000;

/**
 * Short rupee amounts for tiles: "₹999", "₹8,500", "₹8.5 L", "₹1.25 Cr".
 * Whole rupees below a lakh; one or two decimals above.
 */
export function formatCompactMoney(paise: Paise, locale = 'en-IN'): string {
  const rupees = paise / 100;
  const sign = rupees < 0 ? '-' : '';
  const amount = Math.abs(rupees);
  const short = (value: number, unit: string) =>
    `${sign}₹${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)} ${unit}`;
  if (amount >= CRORE) return short(amount / CRORE, 'Cr');
  if (amount >= LAKH) return short(amount / LAKH, 'L');
  return `${sign}₹${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount)}`;
}

/** "2026-10-01T09:30:00Z" -> "1 Oct 2026" (India time). */
export function formatDate(iso: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: INDIA_TIME_ZONE,
  }).format(new Date(iso));
}

/** "2026-10-01T09:30:00Z" -> "1 Oct 2026, 3:00 pm" (India time). */
export function formatDateTime(iso: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: INDIA_TIME_ZONE,
  }).format(new Date(iso));
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
];

/** "5 minutes ago", "yesterday"; the full date after a week. */
export function formatRelativeTime(iso: string, now = Date.now(), locale = 'en-IN'): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Math.abs(seconds) >= 7 * 86_400) return formatDate(iso, locale);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return format.format(0, 'second');
}
