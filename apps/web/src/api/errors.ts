/** A problem with one field, as the API reports Zod validation issues. */
export interface FieldIssue {
  /** Field path, e.g. "phone" or "variants.0.sku". */
  readonly path: string;
  readonly message: string;
}

export interface BusinessChoice {
  readonly id: string;
  readonly name: string;
}

/** Any failed API call: the HTTP status (0 when the server could not be reached) and a message to show. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    message: string,
    readonly issues: readonly FieldIssue[] = [],
    /** Sent with 409 on sign-in when the person belongs to several businesses. */
    readonly organizations: readonly BusinessChoice[] = [],
  ) {
    super(message);
  }
}

const FALLBACK_MESSAGES: Record<number, string> = {
  0: 'Cannot reach the server. Check your internet connection and try again.',
  401: 'Please sign in again.',
  403: 'You do not have permission to do this.',
  404: 'Not found.',
  429: 'Too many attempts. Please wait a moment and try again.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function messageFrom(status: number, body: unknown): string {
  const message = isRecord(body) ? body.message : undefined;
  if (typeof message === 'string' && message !== '') return message;
  if (Array.isArray(message) && message.length > 0) return message.map(String).join('. ');
  return FALLBACK_MESSAGES[status] ?? 'Something went wrong. Please try again.';
}

function listOf<T>(value: unknown, isItem: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const parsed = isRecord(item) ? isItem(item) : null;
    return parsed === null ? [] : [parsed];
  });
}

/**
 * Turns an error response ({ statusCode, message, issues?, organizations? })
 * into an ApiError, coping with bodies that are missing or not JSON.
 */
export function toApiError(status: number, body: unknown): ApiError {
  const record = isRecord(body) ? body : {};
  const issues = listOf<FieldIssue>(record.issues, (item) =>
    typeof item.path === 'string' && typeof item.message === 'string'
      ? { path: item.path, message: item.message }
      : null,
  );
  const organizations = listOf<BusinessChoice>(record.organizations, (item) =>
    typeof item.id === 'string' && typeof item.name === 'string'
      ? { id: item.id, name: item.name }
      : null,
  );
  return new ApiError(status, messageFrom(status, body), issues, organizations);
}

/** The message to show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
