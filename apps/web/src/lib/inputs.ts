import { paiseToRupees, rupeesToPaise } from '@paint/shared';

/** "1,250.50" -> 125050 paise; null when it is not a rupee amount. */
export function parseRupees(text: string): number | null {
  try {
    return rupeesToPaise(text);
  } catch {
    return null;
  }
}

/** 125050 -> "1250.50" for an input; "" for no amount. */
export function rupeesInput(paise: number | null): string {
  return paise === null ? '' : paiseToRupees(paise);
}

/** "a, b ,,c" -> ["a", "b", "c"]. */
export function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** A trimmed form value, or null when it was left empty (PATCH clears the field). */
export function optional(text: string): string | null {
  const value = text.trim();
  return value === '' ? null : value;
}

/** A decimal number typed by a person ("1.5", " -2 "); null when it is not one. */
export function parseNumber(text: string): number | null {
  const value = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  return Number(value);
}
