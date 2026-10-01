/** Formats a document number with its prefix, e.g. ("TR", 42) -> "TR-000042". */
export function formatDocumentNumber(prefix: string, value: number, digits = 6): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Document numbers start at 1, got ${String(value)}`);
  }
  return `${prefix}-${String(value).padStart(digits, '0')}`;
}
