import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError, errorMessage } from '../api/errors.js';

/**
 * Shows an API failure on a form: field issues next to their fields (when the
 * form has that field), everything else as the form's message.
 */
export function showApiError<T extends FieldValues>(
  error: unknown,
  fields: readonly Path<T>[],
  setError: UseFormSetError<T>,
): string | null {
  if (error instanceof ApiError) {
    const unmatched = error.issues.filter((issue) => {
      const field = fields.find((name) => name === issue.path);
      if (field === undefined) return true;
      setError(field, { type: 'server', message: issue.message });
      return false;
    });
    if (error.issues.length > 0 && unmatched.length === 0) return null;
  }
  return errorMessage(error);
}
