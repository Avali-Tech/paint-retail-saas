import { en, type Messages } from '../i18n/en.js';

/** A problem with one field, as the API reports Zod validation issues. */
export interface FieldIssue {
  /** Field path, e.g. "phone" or "variants.0.sku". */
  readonly path: string;
  readonly message: string;
}

export interface BusinessChoice {
  readonly id: string;
  readonly name: string;
  /** Its sign-in link name, so a branded sign-in page can offer its own business first. */
  readonly slug?: string;
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
    /** The whole error body, for extra fields such as a duplicate's existingPartyId. */
    readonly body: Readonly<Record<string, unknown>> = {},
    /** Set when the server gave no message: the app explains it in the person's language. */
    readonly fallback: ErrorText | null = null,
  ) {
    super(message);
  }
}

/** The app's own explanations of failed calls, by kind (see `errors` in i18n/en.ts). */
export type ErrorTexts = Messages['errors'];
export type ErrorText = keyof ErrorTexts;

let texts: ErrorTexts = en.errors;

/** Switches the app's own error explanations to the person's language (the I18nProvider does). */
export function setErrorTexts(next: ErrorTexts): void {
  texts = next;
}

const FALLBACKS: Readonly<Record<number, ErrorText>> = {
  0: 'offline',
  401: 'signIn',
  403: 'forbidden',
  404: 'notFound',
  429: 'tooMany',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The server's message, or null when it sent none. */
function messageFrom(body: unknown): string | null {
  const message = isRecord(body) ? body.message : undefined;
  if (typeof message === 'string' && message !== '') return message;
  if (Array.isArray(message) && message.length > 0) return message.map(String).join('. ');
  return null;
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
      ? {
          id: item.id,
          name: item.name,
          ...(typeof item.slug === 'string' ? { slug: item.slug } : {}),
        }
      : null,
  );
  const message = messageFrom(body);
  if (message !== null) return new ApiError(status, message, issues, organizations, record);
  const fallback = FALLBACKS[status] ?? 'generic';
  return new ApiError(status, texts[fallback], issues, organizations, record, fallback);
}

/** A string field of an error body (e.g. existingPartyId on a duplicate), if present. */
export function errorDetail(error: unknown, field: string): string | null {
  if (!(error instanceof ApiError)) return null;
  const value = error.body[field];
  return typeof value === 'string' ? value : null;
}

/** The message to show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return texts.generic;
  return error.fallback === null ? error.message : texts[error.fallback];
}

/**
 * The message to show with what the API said about each field, for a form with no place
 * for them, e.g. "Cannot record the payment: Enter the cheque number and the date on it".
 */
export function errorWithIssues(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof ApiError) || error.issues.length === 0) return message;
  return `${message}: ${error.issues.map((issue) => issue.message).join('. ')}`;
}
