import { toApiError } from './errors.js';

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Extra request headers, e.g. an `Idempotency-Key` so a retried POST is done once. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A file the API sent back, with the name its Content-Disposition gave (null without one). */
export interface DownloadedFile {
  readonly blob: Blob;
  readonly fileName: string | null;
}

export interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
  /** GET a file (a document, a CSV report) with the bearer token, as a blob. */
  download(path: string, options?: RequestOptions): Promise<DownloadedFile>;
  /** POST multipart/form-data (a file upload); the browser sets the boundary. */
  upload<T>(path: string, form: FormData): Promise<T>;
}

export interface ApiClientOptions {
  /** Where the API lives, e.g. "/api" (proxied to it) or "https://api.example.com". */
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  /** The signed-in session's bearer token, if any. */
  readonly getToken: () => string | null;
  /** Called when a signed-in request answers 401: the session has ended. */
  readonly onUnauthorized: () => void;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return `${baseUrl.replace(/\/$/, '')}${path}${search === '' ? '' : `?${search}`}`;
}

/** The JSON in a response body, or null when it is empty or not JSON (e.g. a proxy's HTML error page). */
export function parseJson(text: string): unknown {
  try {
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * The file name in a Content-Disposition header: the UTF-8 `filename*` when
 * present (names in any language), else the quoted `filename`; null without one.
 */
export function fileNameFrom(header: string | null): string | null {
  if (header === null) return null;
  const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(header)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed encoding: fall back to the plain name.
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1] ?? null;
}

interface Outgoing {
  readonly query?: Readonly<Record<string, QueryValue>> | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Sent as is: a JSON string or form data. */
  readonly body?: BodyInit;
  readonly contentType?: string;
  readonly accept: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** A small fetch wrapper: JSON in and out, bearer token, errors as ApiError. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  /** Sends the request and answers the response when it is OK; anything else becomes an ApiError. */
  async function send(method: string, path: string, init: Outgoing): Promise<Response> {
    const token = options.getToken();
    const headers: Record<string, string> = { ...init.headers, accept: init.accept };
    if (init.contentType !== undefined) headers['content-type'] = init.contentType;
    if (token !== null) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await options.fetch(buildUrl(options.baseUrl, path, init.query), {
        method,
        headers,
        body: init.body,
        signal: init.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw toApiError(0, null);
    }
    if (!response.ok) {
      if (response.status === 401 && token !== null) options.onUnauthorized();
      throw toApiError(response.status, parseJson(await response.text()));
    }
    return response;
  }

  async function request<T>(method: string, path: string, init: RequestOptions = {}): Promise<T> {
    const response = await send(method, path, {
      query: init.query,
      signal: init.signal,
      headers: init.headers,
      accept: 'application/json',
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), contentType: 'application/json' }),
    });
    return parseJson(await response.text()) as T;
  }

  return {
    get: (path, init) => request('GET', path, init),
    post: (path, body, init) => request('POST', path, { ...init, body: body ?? {} }),
    put: (path, body, init) => request('PUT', path, { ...init, body }),
    patch: (path, body, init) => request('PATCH', path, { ...init, body }),
    delete: (path, init) => request('DELETE', path, init),
    download: async (path, init = {}) => {
      const response = await send('GET', path, {
        query: init.query,
        signal: init.signal,
        accept: '*/*',
      });
      return {
        blob: await response.blob(),
        fileName: fileNameFrom(response.headers.get('content-disposition')),
      };
    },
    upload: async <T>(path: string, form: FormData) => {
      const response = await send('POST', path, { body: form, accept: 'application/json' });
      return parseJson(await response.text()) as T;
    },
  };
}
