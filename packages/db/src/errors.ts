/** PostgreSQL error codes. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

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

/** The constraint a unique violation broke, or null if `error` is not a unique violation. */
export function uniqueViolationConstraint(error: unknown): string | null {
  const pgError = pgErrorOf(error);
  return pgError?.code === UNIQUE_VIOLATION ? String(pgError.constraint) : null;
}

/** True when `error` is a check constraint violation on one of the given constraints. */
export function isCheckViolation(error: unknown, constraints: readonly string[]): boolean {
  const pgError = pgErrorOf(error);
  return pgError?.code === CHECK_VIOLATION && constraints.includes(String(pgError.constraint));
}
