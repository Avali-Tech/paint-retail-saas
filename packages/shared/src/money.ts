/**
 * Money is always stored and calculated as whole paise (1 rupee = 100 paise),
 * never as floating-point rupees, so totals never drift by a paisa.
 */
export type Paise = number;

const RUPEE_AMOUNT = /^(?<sign>-)?(?<whole>\d+)(?:\.(?<fraction>\d{1,2}))?$/;

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Throws unless `value` is a whole number of paise within the safe integer range. */
export function assertPaise(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Paise must be a safe whole number, got ${String(value)}`);
  }
}

/**
 * Parses a rupee amount typed by a user or read from a file into paise.
 * Accepts Indian digit grouping ("8,50,000.50") and up to 2 decimal places.
 */
export function rupeesToPaise(rupees: string): Paise {
  const match = RUPEE_AMOUNT.exec(rupees.trim().replaceAll(',', ''));
  if (!match?.groups) {
    throw new TypeError(`Invalid rupee amount: "${rupees}"`);
  }
  const { sign, whole = '', fraction = '' } = match.groups;
  const magnitude = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  assertPaise(magnitude);
  return sign && magnitude !== 0 ? -magnitude : magnitude;
}

/** Plain decimal rupees for APIs and exports, for example 123450 -> "1234.50". */
export function paiseToRupees(paise: Paise): string {
  assertPaise(paise);
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  const whole = Math.trunc(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${sign}${String(whole)}.${fraction}`;
}

/** Display format with the rupee sign and Indian grouping, for example "₹8,50,000.00". */
export function formatINR(paise: Paise): string {
  return inrFormatter.format(paiseToRupees(paise) as Intl.StringNumericLiteral);
}

/** Adds paise amounts, throwing if any input or the total is not a safe whole number. */
export function sumPaise(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const amount of amounts) {
    assertPaise(amount);
    total += amount;
  }
  assertPaise(total);
  return total;
}
