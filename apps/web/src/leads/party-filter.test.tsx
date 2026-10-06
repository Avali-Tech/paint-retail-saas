import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json } from '../test-support/fake-api.js';
import { page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { crmRoutes, party } from './test-support/fixtures.js';

const location = () => screen.getByTestId('location').textContent;

// The customer 360's "See all" opens these lists kept to one party (?party=).
describe.each([
  ['/leads', '/leads'],
  ['/opportunities', '/opportunities'],
  ['/projects', '/projects'],
])('%s for one party', { timeout: 30_000 }, (path, api) => {
  it('lists only that party’s records, and goes back to everyone’s', async () => {
    const { user, requests } = renderApp({
      path: `${path}?party=party-9`,
      routes: {
        ...crmRoutes(),
        'GET /parties/:id': () => json(party()),
        [`GET ${api}`]: () => json(page([])),
        'GET /opportunities/pipeline': () => json([]),
      },
    });
    expect(await screen.findByText('For Meera Reddy only')).toBeVisible();
    const lists = () => requests.filter((request) => request.path === api);
    expect(lists().at(-1)?.query.get('partyId')).toBe('party-9');

    await user.click(screen.getByRole('button', { name: 'Show everyone’s' }));
    await waitFor(() => {
      expect(location()).toBe(path);
    });
    await waitFor(() => {
      expect(lists().at(-1)?.query.has('partyId')).toBe(false);
    });
    expect(screen.queryByText('For Meera Reddy only')).toBeNull();
  });
});
