import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../test-support/fake-api.js';
import { createApiClient } from './client.js';
import { endpoints } from './endpoints.js';

describe('tax endpoints', () => {
  it('calls each route with its body', async () => {
    const fake = fakeFetch({});
    const api = endpoints(
      createApiClient({
        baseUrl: '/api',
        fetch: fake.fetch,
        getToken: () => 'tok',
        onUnauthorized: () => undefined,
      }),
    );
    await Promise.allSettled([
      api.tax.categories(),
      api.tax.options(),
      api.tax.createCategory({ name: 'Adhesives 18%', rateBps: 1800 }),
      api.tax.updateCategory('c1', { isDefault: true }),
      api.tax.addRate('c1', { rateBps: 500, effectiveFrom: '2030-01-01' }),
      api.tax.registrations(),
      api.tax.setBusiness('Sharma Paints'),
      api.tax.setStore('s1', { registrationType: 'unregistered', stateCode: '36' }),
    ]);
    expect(fake.requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ['GET', '/tax-categories', undefined],
      ['GET', '/tax-categories/options', undefined],
      ['POST', '/tax-categories', { name: 'Adhesives 18%', rateBps: 1800 }],
      ['PATCH', '/tax-categories/c1', { isDefault: true }],
      ['POST', '/tax-categories/c1/rates', { rateBps: 500, effectiveFrom: '2030-01-01' }],
      ['GET', '/gst-registrations', undefined],
      ['PUT', '/gst-registrations/business', { legalName: 'Sharma Paints' }],
      [
        'PUT',
        '/gst-registrations/stores/s1',
        { registrationType: 'unregistered', stateCode: '36' },
      ],
    ]);
  });
});
