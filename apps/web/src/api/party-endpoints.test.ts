import { DEFAULT_CREDIT_RULES } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../test-support/fake-api.js';
import { createApiClient } from './client.js';
import { endpoints } from './endpoints.js';
import { ApiError, errorDetail } from './errors.js';
import type { PartyInput } from './parties.js';

function calls() {
  const api = fakeFetch({
    'GET /parties': () => json({ items: [], total: 0 }),
    'PATCH /things/1': () => json({ ok: true }),
    'DELETE /things/1': () => ({ status: 204 }),
  });
  const client = createApiClient({
    baseUrl: '/api',
    fetch: api.fetch,
    getToken: () => 'tok',
    onUnauthorized: () => undefined,
  });
  return { client, calls: endpoints(client), requests: api.requests };
}

const seen = (requests: ReturnType<typeof calls>['requests']) =>
  requests.map((request) => {
    const query = request.query.toString();
    return `${request.method} ${request.path}${query === '' ? '' : `?${query}`}`;
  });

describe('the API client', () => {
  it('sends PATCH with a body and DELETE without one', async () => {
    const { client, requests } = calls();
    await expect(client.patch('/things/1', { name: 'x' })).resolves.toEqual({ ok: true });
    await expect(client.delete('/things/1')).resolves.toBeNull();
    expect(requests.map((request) => [request.method, request.body])).toEqual([
      ['PATCH', { name: 'x' }],
      ['DELETE', undefined],
    ]);
  });

  it('reads extra fields of an error body', () => {
    const error = new ApiError(409, 'Duplicate', [], [], { existingPartyId: 'p1', count: 2 });
    expect(errorDetail(error, 'existingPartyId')).toBe('p1');
    expect(errorDetail(error, 'count')).toBeNull();
    expect(errorDetail(new Error('x'), 'existingPartyId')).toBeNull();
  });
});

const EARN_RULE = {
  name: 'Every brand',
  basis: 'value',
  points: 1,
  perPaise: 10_000,
  perMillilitres: null,
  brandId: null,
  multiplierBps: 10_000,
  validFrom: null,
  validUntil: null,
  isActive: true,
} as const;

describe('party, credit and loyalty endpoints', () => {
  it('calls each route with its query and body', async () => {
    const { calls: api, requests } = calls();
    const input: PartyInput = {
      kind: 'person',
      displayName: 'Ramesh',
      tags: [],
      roles: ['customer'],
    };
    await api.parties.list({ q: 'apex', limit: 50, offset: 0 });
    await Promise.allSettled([
      api.parties.get('p1'),
      api.parties.overview('p1'),
      api.parties.create(input),
      api.parties.update('p1', { isActive: false }),
      api.parties.stores(),
      api.credit.request({ partyId: 'p1', limitPaise: 100, creditDays: 30 }),
      api.credit.requests({ status: 'pending', limit: 50, offset: 0 }),
      api.credit.getRequest('r1'),
      api.credit.approve('r1'),
      api.credit.reject('r1', 'Too risky'),
      api.credit.hold('p1', 'Late'),
      api.credit.release('p1'),
      api.credit.rules(),
      api.credit.setRules(DEFAULT_CREDIT_RULES),
      api.loyalty.get('p1', { limit: 10, offset: 0 }),
      api.loyalty.enrol('p1'),
      api.loyalty.purchase('p1', { manualPurchasePaise: 100, reference: 'B1' }),
      api.loyalty.award('p1', { points: 5 }),
      api.loyalty.redeem('p1', { points: 5 }),
      api.loyalty.adjust('p1', { points: -5, reason: 'Fix' }),
      api.loyalty.settings(),
      api.loyalty.setSettings({
        earnPoints: 1,
        earnPerPaise: 10_000,
        tiers: [],
        expiryDays: null,
        minRedemptionPoints: 0,
      }),
      api.loyalty.earnRules(),
      api.loyalty.createEarnRule(EARN_RULE),
      api.loyalty.updateEarnRule('r1', EARN_RULE),
    ]);
    expect(seen(requests).sort()).toEqual(
      [
        'GET /parties?q=apex&limit=50&offset=0',
        'GET /parties/p1',
        'GET /parties/p1/overview',
        'POST /parties',
        'PATCH /parties/p1',
        'GET /stores',
        'POST /credit-requests',
        'GET /credit-requests?status=pending&limit=50&offset=0',
        'GET /credit-requests/r1',
        'POST /credit-requests/r1/approve',
        'POST /credit-requests/r1/reject',
        'POST /parties/p1/credit/hold',
        'POST /parties/p1/credit/release',
        'GET /credit-rules',
        'PUT /credit-rules',
        'GET /parties/p1/loyalty?limit=10&offset=0',
        'POST /parties/p1/loyalty',
        'POST /parties/p1/loyalty/purchases',
        'POST /parties/p1/loyalty/awards',
        'POST /parties/p1/loyalty/redemptions',
        'POST /parties/p1/loyalty/adjustments',
        'GET /loyalty-settings',
        'PUT /loyalty-settings',
        'GET /loyalty-earn-rules',
        'POST /loyalty-earn-rules',
        'PUT /loyalty-earn-rules/r1',
      ].sort(),
    );
    const body = (path: string) =>
      requests.find((request) => request.method === 'POST' && request.path === path)?.body;
    expect(body('/credit-requests/r1/reject')).toEqual({ reason: 'Too risky' });
    expect(body('/parties/p1/credit/hold')).toEqual({ reason: 'Late' });
    expect(body('/parties/p1/loyalty')).toEqual({});
  });
});
