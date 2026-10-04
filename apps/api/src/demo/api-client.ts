import type { NestFastifyApplication } from '@nestjs/platform-fastify';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

/** A failed API call during seeding, with what the API said. */
export class DemoApiError extends Error {
  override readonly name = 'DemoApiError';

  constructor(
    readonly method: Method,
    readonly url: string,
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`${method} ${url} answered ${String(statusCode)}: ${body}`);
  }
}

/** Something the API answered; most answers carry an id. */
export type Answer = Record<string, unknown> & { id: string };

/**
 * Calls the real API in-process (no network), exactly as the web app would,
 * so validation, business rules, numbering, notifications, row-level security
 * and the audit log all apply to the demo data.
 */
export class DemoApi {
  constructor(private readonly app: NestFastifyApplication) {}

  /** A client that acts as the member signed in with `token`. */
  as(token: string): MemberApi {
    return new MemberApi(this, token);
  }

  /** Signed-out calls: sign-up and sign-in. */
  get public(): MemberApi {
    return new MemberApi(this, null);
  }

  async request<T = Answer>(
    method: Method,
    url: string,
    token: string | null,
    payload?: object,
  ): Promise<T> {
    const response = await this.app.inject({
      method,
      url,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
    if (response.statusCode >= 400) {
      throw new DemoApiError(method, url, response.statusCode, response.body);
    }
    return (response.body === '' ? {} : JSON.parse(response.body)) as T;
  }
}

/** API calls as one member (or signed out). */
export class MemberApi {
  constructor(
    private readonly api: DemoApi,
    private readonly token: string | null,
  ) {}

  get<T = Answer>(url: string): Promise<T> {
    return this.api.request<T>('GET', url, this.token);
  }

  post<T = Answer>(url: string, payload: object = {}): Promise<T> {
    return this.api.request<T>('POST', url, this.token, payload);
  }

  put<T = Answer>(url: string, payload: object): Promise<T> {
    return this.api.request<T>('PUT', url, this.token, payload);
  }

  patch<T = Answer>(url: string, payload: object): Promise<T> {
    return this.api.request<T>('PATCH', url, this.token, payload);
  }
}
