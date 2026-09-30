const INDIAN_MOBILE = /^[6-9]\d{9}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalises a phone number to E.164. Bare 10-digit Indian mobiles and numbers
 * written with 0 or 91 in front get +91. Returns null when it isn't a valid number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '');
  if (E164.test(digits)) return digits;
  const national = digits.replace(/^(?:0|91)(?=\d{10}$)/, '');
  return INDIAN_MOBILE.test(national) ? `+91${national}` : null;
}

/** Lowercases and trims an email address. Returns null when it isn't a valid address. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}
