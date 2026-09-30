/**
 * GST rate slabs in percent. Paints are 18% (HSN 3208-3210). Kept as data so a
 * change in law is a one-line change. Stored in the database as basis points.
 */
export const GST_RATES_PERCENT = [0, 5, 12, 18, 28, 40] as const;

/** 18% -> 1800 basis points. */
export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100);
}

export function basisPointsToPercent(basisPoints: number): number {
  return basisPoints / 100;
}

const HSN_FORMAT = /^\d{4}(?:\d{2}){0,2}$/;

/** True for a 4, 6 or 8-digit HSN code, e.g. 3209 or 32091090. */
export function isValidHsn(hsn: string): boolean {
  return HSN_FORMAT.test(hsn);
}

/** True when a numeric GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) has a correct check digit. */
export function isValidGtin(code: string): boolean {
  if (!/^(?:\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = Array.from({ length: code.length }, (_, index) => Number(code.charAt(index)));
  const check = digits.pop();
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const INTERNAL_CODE = /^[A-Za-z0-9-]{4,48}$/;

/**
 * True for a barcode we can store: any 4-48 character internal code, except
 * that numbers shaped like EAN/UPC must have a valid check digit, which
 * catches most scanner and typing mistakes.
 */
export function isValidBarcode(code: string): boolean {
  if (/^(?:\d{8}|\d{12,14})$/.test(code)) return isValidGtin(code);
  return INTERNAL_CODE.test(code);
}
