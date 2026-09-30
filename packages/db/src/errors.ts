/** PostgreSQL error code for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

interface PgError {
  code?: unknown;
  constraint?: unknown;
}

function pgErrorOf(error: unknown): PgError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  // Drizzle wraps the driver error in `cause`.
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null ? cause : error;
}

/**
 * True when `error` is a unique constraint violation, optionally on one of the
 * given constraints. Use it to turn "already exists" into a 409 instead of a 500.
 */
export function isUniqueViolation(error: unknown, constraints?: readonly string[]): boolean {
  const pgError = pgErrorOf(error);
  if (pgError?.code !== UNIQUE_VIOLATION) return false;
  return constraints === undefined || constraints.includes(String(pgError.constraint));
}
