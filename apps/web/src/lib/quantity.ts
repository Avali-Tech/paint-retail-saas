/**
 * A stock quantity typed by a person ("2", " 1.5 ", "-3"), with at most three
 * decimals as the API stores them; null when it is not one.
 */
export function parseQuantity(text: string): number | null {
  const value = text.trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(value)) return null;
  return Number(value);
}

/** A quantity that must be above zero (an order, a transfer); null otherwise. */
export function parsePositiveQuantity(text: string): number | null {
  const quantity = parseQuantity(text);
  return quantity !== null && quantity > 0 ? quantity : null;
}
