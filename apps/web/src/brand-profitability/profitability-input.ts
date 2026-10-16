// What people type for brand profitability's rates, read into the API's units.

/** A percentage a year as basis points, when it is one (0 to 100, two decimals at most). */
export function costOfMoneyBps(value: string): number | undefined {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value.trim())) return undefined;
  const bps = Math.round(Number(value) * 100);
  return bps <= 10_000 ? bps : undefined;
}

/** Rupees a point as paise, when they are (₹0 to ₹1,000, two decimals at most). */
export function pointValuePaise(value: string): number | undefined {
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(value.trim())) return undefined;
  const paise = Math.round(Number(value) * 100);
  return paise <= 100_000 ? paise : undefined;
}

/** Hundredths as people type them: 1200 → "12", 950 → "9.5" (basis points as %, paise as ₹). */
export const hundredths = (value: number) => String(value / 100);
