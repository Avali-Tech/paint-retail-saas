import type { SalesOrderView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler, type FakeRequest } from '../test-support/fake-api.js';
import { page } from '../test-support/inventory-fixtures.js';
import { OVERVIEW, PARTY } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { AMP, APEX, KPH } from '../pos/test-support/pos-fixtures.js';
import { lookupIn } from '../pos/test-support/pos-render.js';
import { ORDER, QUOTE, orderLine } from '../orders/test-support/order-fixtures.js';
import { PASTEL, tintRecord } from './test-support/tint-fixtures.js';

// The tint panel on quotation and order lines (spec §6.3): a line's tint is sent with
// the line on every save, and read back with it when a draft is edited.

const BASE = 'Asian Paints Apex Pastel Base 4 l';
const location = () => screen.getByTestId('location').textContent;
const posted = (requests: readonly FakeRequest[]) =>
  requests.filter((request) => request.method === 'POST' && request.path === '/tint-records');
const linesOf = (request: FakeRequest | undefined) =>
  (request?.body as { lines: { tint?: { shadeCode: string } }[] }).lines;

const PASTEL_LINE = orderLine({
  id: 'ol-pastel',
  lineNo: 1,
  variantId: 'v-pastel-4',
  sku: 'APB-4L',
  description: BASE,
  quantity: 2,
  unitPricePaise: 205_000,
  discountBps: null,
  tint: tintRecord({ note: 'Match the old wall' }),
});
/** A draft order: a tinted base, an untinted one and a paint that is not tinted. */
const TINTED_ORDER: SalesOrderView = {
  ...ORDER,
  lines: [
    PASTEL_LINE,
    orderLine({
      ...PASTEL_LINE,
      id: 'ol-plain',
      lineNo: 2,
      unitPricePaise: 200_000,
      tint: undefined,
    }),
    orderLine({ id: 'ol-apex', lineNo: 3 }),
  ],
};

const routes = (overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /stores': () => json([AMP, KPH]),
  'GET /parties': () => json(page([PARTY])),
  'GET /parties/:id/overview': () => json(OVERVIEW),
  'GET /projects': () => json(page([])),
  'GET /products/lookup': lookupIn([APEX, PASTEL]),
  'GET /sales-orders/:id': () => json(TINTED_ORDER),
  'GET /tint-records': () => json(page([tintRecord()])),
  ...overrides,
});

async function tintFirstLine(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: `Tint ${BASE}` }));
  const dialog = await screen.findByRole('dialog', { name: `Tint ${BASE}` });
  // The bill-to's shades are offered first.
  await user.click(await within(dialog).findByRole('button', { name: 'Use X 132' }));
  await user.click(within(dialog).getByRole('button', { name: 'Apply tint' }));
  expect(await screen.findByText('Shade X 132 · Ivory Mist · tinting ₹50.00')).toBeVisible();
}

async function chooseBillToAndScan(user: ReturnType<typeof renderApp>['user']) {
  await screen.findByRole('option', { name: 'AMP · Ameerpet' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'AMP · Ameerpet');
  await user.click(screen.getByRole('button', { name: 'Choose Bill to' }));
  await user.type(
    screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
    'Apex',
  );
  await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
  await user.type(screen.getByRole('combobox', { name: 'Scan or search' }), 'APB-4L{Enter}');
}

describe('tints on quotation and order lines', { timeout: 30_000 }, () => {
  it('sends the shade with the new order’s line, in the one save', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/new',
      routes: routes({ 'POST /sales-orders': () => json(ORDER, 201) }),
    });
    await chooseBillToAndScan(user);
    await tintFirstLine(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(location()).toBe('/sales-orders/order-1');
    });
    const order = requests.find((request) => request.path === '/sales-orders');
    expect(order?.body).toMatchObject({
      lines: [
        {
          variantId: 'v-pastel-4',
          unitPricePaise: 205_000,
          tint: { shadeCode: 'X 132', brandId: 'brand-asian', machine: 'Counter 1' },
        },
      ],
    });
    expect(posted(requests)).toEqual([]);
    expect(requests.find((request) => request.path === '/tint-records')?.query.get('partyId')).toBe(
      PARTY.id,
    );
  });

  it('sends quotation lines’ shades too', async () => {
    const { user, requests } = renderApp({
      path: '/quotations/new',
      routes: routes({
        'POST /quotations': () => json(QUOTE, 201),
        'GET /quotations/:id': () => json(QUOTE),
      }),
    });
    await chooseBillToAndScan(user);
    await tintFirstLine(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(location()).toBe(`/quotations/${QUOTE.id}`);
    });
    expect(
      linesOf(requests.find((request) => request.path === '/quotations'))[0]?.tint?.shadeCode,
    ).toBe('X 132');
  });

  it('edits a draft with its tints read from its lines, and sends them back on save', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1/edit',
      routes: routes({ 'PUT /sales-orders/:id': () => json(TINTED_ORDER) }),
    });
    expect(await screen.findByText('Shade X 132 · Ivory Mist · tinting ₹50.00')).toBeVisible();
    const lines = within(screen.getByRole('list', { name: 'Bill' })).getAllByRole('listitem');
    expect(lines).toHaveLength(3);
    // The untinted base is looked up: its product is tintable. The plain paint is not.
    expect(
      await within(found(lines[1])).findByRole('button', { name: `Tint ${BASE}` }),
    ).toBeVisible();
    await waitFor(() => {
      expect(requests.filter((request) => request.path === '/products/lookup')).toHaveLength(2);
    });
    expect(within(found(lines[2])).queryByRole('button', { name: /^Tint / })).toBeNull();
    expect(within(found(lines[0])).getByText(/₹2,050\.00 each/)).toBeVisible();
    expect(requests.some((request) => request.path === '/tint-records')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(location()).toBe('/sales-orders/order-1');
    });
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.body).toMatchObject({
      lines: [
        {
          unitPricePaise: 205_000,
          // The note read with the line goes back unchanged.
          tint: { shadeCode: 'X 132', tintChargePaise: 5_000, note: 'Match the old wall' },
        },
        { unitPricePaise: 200_000 },
        { unitPricePaise: 500_000 },
      ],
    });
    expect(linesOf(put).map((line) => line.tint?.shadeCode ?? null)).toEqual(['X 132', null, null]);
  });
});
