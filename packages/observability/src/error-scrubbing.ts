// Removes secrets and personal data from error reports before they leave the
// server or the browser (Sentry's beforeSend / beforeBreadcrumb). Used by the API
// and the web app so both follow the same rules:
//   - request bodies, headers, cookies and query strings are never sent;
//   - values under sensitive keys (passwords, OTP/TOTP and recovery codes, 2FA secrets,
//     tokens, auth headers, bodies, phone, email…) are replaced;
//   - free text (error messages) has tokens, emails, phone numbers, 6-digit codes and
//     credentials in URLs masked.

export const FILTERED = '[Filtered]';

/**
 * Keys whose values are never sent, at any depth. "otp" also matches TOTP, "auth"
 * matches Authorization and 2FA settings; whole bodies and payloads go too.
 */
const SENSITIVE_KEY =
  /pass(word|code|phrase)?|pwd|secret|token|otp|auth|cookie|session|credential|api[-_]?key|^code$|codes$|recovery|backup[-_]?code|verification[-_]?code|mfa|2fa|two[-_]?factor|pin$|phone|mobile|email|gstin|^pan$|address|^body$|payload|form[-_]?data|^data$/i;

const MAX_DEPTH = 8;

/** Replacements applied in order: credentials in URLs before emails (user:pass@host looks like one). */
const TEXT_RULES: readonly (readonly [RegExp, string])[] = [
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${FILTERED}@`],
  [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, `$1 ${FILTERED}`],
  [
    /\b(password|passcode|t?otp|code|codes|recovery[-_ ]?codes?|token|secret|api[-_]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
    `$1$2${FILTERED}`,
  ],
  [/[^\s@<>"'(),;:[\]/]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi, '[email]'],
  // Indian mobile numbers, with or without +91 and a space in the middle.
  [/(?<![\d+])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]'],
  // Six digits on their own (sign-in codes), but not document numbers such as SC-000123.
  [/(?<![\d-])\d{6}(?!\d)/g, '[code]'],
];

/** Masks secrets and personal data in free text such as an error message. */
export function redactText(text: string): string {
  return TEXT_RULES.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

/** Drops the query string and fragment, which can carry codes, tokens or search terms. */
export function stripQuery(url: string): string {
  return url.replace(/[?#].*$/s, '');
}

/** Copies a value with sensitive keys filtered and every string redacted. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? FILTERED : scrubValue(item, depth + 1),
    ]),
  );
}

function filterSensitiveKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? FILTERED : value]),
  );
}

function scrubRecord<T>(record: T | undefined): T | undefined {
  return record === undefined ? undefined : (scrubValue(record) as T);
}

/** The parts of a Sentry breadcrumb that are scrubbed. */
export interface ScrubbableBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/** The parts of a Sentry event that are scrubbed; everything else passes through. */
export interface ScrubbableEvent {
  message?: string;
  logentry?: { message?: string; params?: unknown[] };
  exception?: { values?: { value?: string }[] };
  request?: { url?: string; method?: string };
  user?: { id?: string | number };
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  tags?: Record<string, unknown>;
  breadcrumbs?: ScrubbableBreadcrumb[];
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  const data = scrubRecord(breadcrumb.data);
  if (data && typeof data.url === 'string') data.url = stripQuery(data.url);
  return {
    ...breadcrumb,
    ...(breadcrumb.message === undefined ? {} : { message: redactText(breadcrumb.message) }),
    ...(data === undefined ? {} : { data }),
  };
}

/**
 * Returns a copy of the event that is safe to send: only the request's method and
 * path, only the user's id, and scrubbed messages, tags, extras, contexts and breadcrumbs.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const { request, user, logentry, exception, breadcrumbs, ...rest } = event;
  const scrubbed: ScrubbableEvent = {
    ...rest,
    ...(event.message === undefined ? {} : { message: redactText(event.message) }),
    ...(event.extra === undefined ? {} : { extra: scrubRecord(event.extra) }),
    ...(event.contexts === undefined ? {} : { contexts: scrubRecord(event.contexts) }),
    // Tags are short labels (request id, route, status): filtered by key only, so ids stay intact.
    ...(event.tags === undefined ? {} : { tags: filterSensitiveKeys(event.tags) }),
  };
  if (request) {
    scrubbed.request = {
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.url === undefined ? {} : { url: redactText(stripQuery(request.url)) }),
    };
  }
  if (user?.id !== undefined) scrubbed.user = { id: user.id };
  if (logentry) {
    // Parameters are the raw values that were formatted into the message.
    scrubbed.logentry =
      logentry.message === undefined ? {} : { message: redactText(logentry.message) };
  }
  if (exception) {
    scrubbed.exception = {
      ...exception,
      ...(exception.values === undefined
        ? {}
        : {
            values: exception.values.map((value) =>
              value.value === undefined ? value : { ...value, value: redactText(value.value) },
            ),
          }),
    };
  }
  if (breadcrumbs) scrubbed.breadcrumbs = breadcrumbs.map(scrubBreadcrumb);
  return scrubbed as T;
}

/**
 * Sentry's `dataCollection` option with everything personal switched off: no user
 * details, cookies, headers, bodies, query strings, local variables or query data.
 */
export const PRIVATE_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
} as const satisfies Record<string, unknown>;
