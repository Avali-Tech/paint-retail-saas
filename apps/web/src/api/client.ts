import { toApiError } from './errors.js';

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
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

/** A small fetch wrapper: JSON in and out, bearer token, errors as ApiError. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  async function request<T>(method: string, path: string, init: RequestOptions = {}): Promise<T> {
    const token = options.getToken();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (token !== null) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await options.fetch(buildUrl(options.baseUrl, path, init.query), {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw toApiError(0, null);
    }

    const body = parseJson(await response.text());
    if (!response.ok) {
      if (response.status === 401 && token !== null) options.onUnauthorized();
      throw toApiError(response.status, body);
    }
    return body as T;
  }

  return {
    get: (path, init) => request('GET', path, init),
    post: (path, body, init) => request('POST', path, { ...init, body: body ?? {} }),
    put: (path, body, init) => request('PUT', path, { ...init, body }),
  };
}
