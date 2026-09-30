const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_FORMAT = /^[A-Z]{5}\d{4}[A-Z]$/;
const PINCODE_FORMAT = /^[1-9]\d{5}$/;

/** The 15th GSTIN character: a base-36 checksum of the first 14 (GSTN's published algorithm). */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let index = 0; index < 14; index++) {
    const product = BASE36.indexOf(first14.charAt(index)) * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36.charAt((36 - (sum % 36)) % 36);
}

/**
 * True for a well-formed GSTIN whose check character matches, so most typos are
 * caught before an invoice is issued. Expects uppercase.
 */
export function isValidGstin(gstin: string): boolean {
  return GSTIN_FORMAT.test(gstin) && gstinCheckCharacter(gstin.slice(0, 14)) === gstin.charAt(14);
}

/** The PAN embedded in a GSTIN (characters 3 to 12). */
export function panFromGstin(gstin: string): string {
  return gstin.slice(2, 12);
}

/** True for a well-formed PAN, e.g. AAPFU0939F. Expects uppercase. */
export function isValidPan(pan: string): boolean {
  return PAN_FORMAT.test(pan);
}

/** True for a 6-digit Indian PIN code (never starting with 0). */
export function isValidPincode(pincode: string): boolean {
  return PINCODE_FORMAT.test(pincode);
}
