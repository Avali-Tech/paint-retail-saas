/** The value, failing the test with a clear message when it is missing. */
export function found<T>(value: T | null | undefined, what = 'element'): T {
  if (value === null || value === undefined) throw new Error(`Expected a ${what}`);
  return value;
}
