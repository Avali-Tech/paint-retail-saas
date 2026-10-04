import { ApiError } from './errors.js';

/** The error, when it is a 409 Conflict from the API (e.g. a duplicate record); otherwise null. */
export function conflictOf(error: unknown): ApiError | null {
  return error instanceof ApiError && error.status === 409 ? error : null;
}
