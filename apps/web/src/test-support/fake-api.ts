import { PERMISSIONS, type Permission } from '@paint/shared';
import type { Dashboard, Profile, SessionGrant } from '../api/types.js';

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Sent as is instead of JSON, e.g. a file's bytes for a download. */
  raw?: string;
  headers?: Record<string, string>;
}
export type FakeAnswer = FakeResponse | Promise<FakeResponse>;
export type FakeHandler = (request: FakeRequest) => FakeAnswer;

/** Answers with JSON and a status (200 by default). */
export const json = (body: unknown, status = 200) => ({ status, body });

/**
 * A fetch that never touches the network: "GET /auth/me" style routes answer
 * from handlers, anything else is 404. Every request is recorded.
 */
export function fakeFetch(routes: Record<string, FakeHandler>) {
  const requests: FakeRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, 'http://app.test');
    const path = url.pathname.replace(/^\/api/, '');
    const method = init.method ?? 'GET';
    const request: FakeRequest = {
      method,
      path,
      query: url.searchParams,
      // JSON is parsed; form data (an upload) is kept as sent.
      body:
        typeof init.body === 'string'
          ? JSON.parse(init.body)
          : init.body instanceof FormData
            ? init.body
            : undefined,
      headers: init.headers as Record<string, string>,
    };
    requests.push(request);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const handler =
      routes[`${method} ${path}`] ??
      Object.entries(routes).find(([key]) => {
        const [routeMethod, pattern] = key.split(' ');
        if (routeMethod !== method || !pattern?.includes(':')) return false;
        return new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`).test(path);
      })?.[1];
    const answer: FakeResponse = handler
      ? await handler(request)
      : json({ statusCode: 404, message: 'Not Found' }, 404);
    const text = answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body));
    return new Response(answer.status === 204 ? null : text, {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  };
  return { fetch, requests };
}

export const GRANT: SessionGrant = {
  token: 'session-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  organizationId: '00000000-0000-4000-8000-000000000001',
};

export function profile(
  permissions: readonly Permission[] = PERMISSIONS,
  overrides: Partial<Profile> = {},
): Profile {
  return {
    memberId: 'member-1',
    user: { id: 'user-1', fullName: 'Anil Kumar', phone: '+919876543210', email: null },
    organization: { id: GRANT.organizationId, name: 'ABC Paints' },
    role: { key: 'owner', name: 'Owner' },
    permissions: [...permissions],
    allStores: true,
    storeIds: [],
    ...overrides,
  };
}

export const OWNER = profile();
export const CASHIER = profile(['stores:read', 'parties:read', 'catalog:read', 'inventory:read'], {
  role: { key: 'store_employee', name: 'Store Employee' },
  allStores: false,
});

const store = (id: string, code: string, name: string, valuePaise: number) => ({
  store: { id, code, name },
  stock: { valuePaise, units: 13, skus: 2, uncostedSkus: 0 },
  lowStock: { outOfStock: 1, belowMinimum: 1, reorder: 1 },
  transfers: { awaitingApproval: 0, toDispatch: 1, incoming: 1 },
  purchaseOrders: { open: 2, dueValuePaise: 600_000 },
});

export const DASHBOARD: Dashboard = {
  generatedAt: '2026-10-01T10:00:00.000Z',
  stores: [
    store('store-hyd', 'HYD', 'Hyderabad', 2_400_000),
    {
      ...store('store-pun', 'PUN', 'Pune', 187_000_000),
      purchaseOrders: { open: 0, dueValuePaise: 0 },
    },
  ],
  totals: {
    stock: { valuePaise: 189_400_000, units: 26, skus: 4, uncostedSkus: 1 },
    lowStock: { outOfStock: 2, belowMinimum: 2, reorder: 2 },
    transfers: { awaitingApproval: 0, toDispatch: 2, incoming: 2 },
    purchaseOrders: { open: 2, dueValuePaise: 600_000 },
  },
  leads: [
    { stage: 'new', count: 1, valuePaise: 100_000 },
    { stage: 'contacted', count: 0, valuePaise: 0 },
    { stage: 'qualified', count: 2, valuePaise: 0 },
  ],
  opportunities: [
    { stage: 'discovery', count: 1, valuePaise: 500_000, weightedValuePaise: 100_000 },
    { stage: 'proposal', count: 0, valuePaise: 0, weightedValuePaise: 0 },
  ],
  projects: [
    { stage: 'identified', count: 0, valuePaise: 0 },
    { stage: 'survey', count: 0, valuePaise: 0 },
  ],
  followUps: { overdue: 1, today: 2 },
};
