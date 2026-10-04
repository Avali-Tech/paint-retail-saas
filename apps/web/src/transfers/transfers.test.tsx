import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TransferSummary } from '../api/transfers.js';
import { CASHIER, OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { APEX, STORES, page, variant } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { checkRequest } from './NewTransferPage.js';
import { parseNonNegative } from './quantity.js';
import { transfer } from './test-support/fixtures.js';

const summary = (overrides: Partial<TransferSummary> = {}): TransferSummary => {
  const { id, number, status, from, to, requestedAt } = transfer();
  return { id, number, status, from, to, requestedAt, lineCount: 2, ...overrides };
};

const location = () => screen.getByTestId('location').textContent;

function renderList(routes: Record<string, FakeHandler> = {}, member = OWNER, path = '/transfers') {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /transfers': () => json(page([summary()])),
      ...routes,
    },
  });
}

describe('parseNonNegative', () => {
  it('reads 0 or more with at most 3 decimals', () => {
    expect(parseNonNegative(' 2 ')).toBe(2);
    expect(parseNonNegative('0')).toBe(0);
    expect(parseNonNegative('1.125')).toBe(1.125);
    expect(parseNonNegative('1.1255')).toBeNull();
    expect(parseNonNegative('-1')).toBeNull();
    expect(parseNonNegative('')).toBeNull();
  });
});

describe('TransfersPage', () => {
  it('lists transfers with their route, status and products', async () => {
    renderList();
    const table = await screen.findByRole('table', { name: 'Transfers' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['NumberFrom → toStatusRequestedProducts', 'TR-000001HYD → PUNRequested1 Oct 20262']);
    expect(within(table).getByRole('link', { name: 'TR-000001' })).toHaveAttribute(
      'href',
      '/transfers/transfer-1',
    );
    expect(screen.getByRole('link', { name: '+ Transfer' })).toHaveAttribute(
      'href',
      '/transfers/new',
    );
    const sections = screen.getByRole('navigation', { name: 'Stock sections' });
    expect(within(sections).getByRole('link', { name: 'Transfers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('filters by status, direction and store in the address', async () => {
    const { user, requests } = renderList({
      'GET /transfers': (request) =>
        json(request.query.has('status') ? page([]) : page([summary()], 120)),
    });
    expect(await screen.findByRole('navigation', { name: 'Transfer pages' })).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Direction' }),
      'Coming to my stores',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'In transit');
    expect(await screen.findByText('No transfers match these filters')).toBeInTheDocument();
    expect(location()).toBe('/transfers?direction=incoming&store=store-pun&status=in_transit');
    const last = requests.filter((request) => request.path === '/transfers').at(-1);
    expect(Object.fromEntries(last?.query ?? [])).toEqual({
      status: 'in_transit',
      direction: 'incoming',
      storeId: 'store-pun',
      limit: '50',
      offset: '0',
    });
  });

  it('invites a first transfer, and hides "+ Transfer" from staff who cannot move stock', async () => {
    renderList({ 'GET /transfers': () => json(page([])) }, CASHIER);
    expect(await screen.findByText('No transfers yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Transfer' })).toBeNull();
  });
});

describe('checkRequest', () => {
  const line = (quantity: string) => ({
    item: {
      variantId: 'v1',
      sku: 'A',
      name: 'A',
      product: APEX,
      variant: variant(),
    },
    quantity,
  });
  it('wants two different stores, products and quantities above zero', () => {
    expect(checkRequest('', '', [])).toEqual({
      from: 'transfers.form.chooseStore',
      to: 'transfers.form.chooseStore',
      lines: 'workflow.noLines',
    });
    expect(checkRequest('s1', 's1', [line('0')])).toEqual({
      to: 'transfers.form.sameStore',
      'line-v1': 'transfers.form.quantityInvalid',
    });
    expect(checkRequest('s1', 's2', [line('2.5')])).toEqual({});
  });
});

describe('NewTransferPage', () => {
  const routes = (extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
    'GET /products': () => json(page([APEX])),
    'GET /transfers/:id': () => json(transfer()),
    ...extra,
  });

  it('requests stock for a store from another and opens the new transfer', async () => {
    const { user, requests } = renderList(
      routes({ 'POST /transfers': () => json(transfer(), 201) }),
      OWNER,
      '/transfers/new',
    );
    const submit = await screen.findByRole('button', { name: 'Send request' });
    await screen.findAllByRole('option', { name: 'PUN · Pune' });
    await user.click(submit);
    expect(screen.getAllByText('Choose a store', { selector: 'p' })).toHaveLength(2);
    expect(screen.getByText('Add at least one product')).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /From store/ }),
      'HYD · Hyderabad',
    );
    const to = screen.getByRole('combobox', { name: /To store/ });
    expect(within(to).queryByRole('option', { name: 'HYD · Hyderabad' })).toBeNull();
    await user.selectOptions(to, 'PUN · Pune');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), ' Wedding season ');

    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await screen.findByRole('button', { name: 'Add APX-1L' }));
    await user.click(await screen.findByRole('button', { name: 'Add APX-4L' }));
    const quantity = screen.getByRole('textbox', { name: 'Quantity of APX-1L' });
    await user.type(screen.getByRole('textbox', { name: 'Quantity of APX-4L' }), '1');
    await user.click(submit);
    expect(
      await screen.findByText('Enter a quantity above zero, with at most 3 decimals'),
    ).toBeVisible();
    await user.type(quantity, '6');
    await user.click(screen.getByRole('button', { name: 'Remove APX-4L' }));
    await user.click(submit);

    await waitFor(() => {
      expect(location()).toBe('/transfers/transfer-1');
    });
    expect(await screen.findByText('Transfer TR-000001 requested')).toBeInTheDocument();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      fromStoreId: 'store-hyd',
      toStoreId: 'store-pun',
      note: 'Wedding season',
      lines: [{ variantId: 'variant-1l', quantity: 6 }],
    });
  });

  it('explains that someone at one store has no other store to ask', async () => {
    const member = profile(undefined, { allStores: false, storeIds: ['store-pun'] });
    renderList(
      routes({ 'GET /stores': () => json(STORES.filter((store) => store.id === 'store-pun')) }),
      member,
      '/transfers/new',
    );
    expect(
      await screen.findByText(/You work at one store, so there is no other store to choose here/),
    ).toBeInTheDocument();
  });

  it('only requests for a store the member works at, and shows the API’s refusal', async () => {
    const member = profile(undefined, { allStores: false, storeIds: ['store-pun'] });
    const { user, requests } = renderList(
      routes({
        'POST /transfers': () => json({ statusCode: 400, message: 'Unknown product variant' }, 400),
      }),
      member,
      '/transfers/new',
    );
    await screen.findAllByRole('option', { name: 'PUN · Pune' });
    await user.selectOptions(screen.getByRole('combobox', { name: /To store/ }), 'PUN · Pune');
    await user.selectOptions(screen.getByRole('combobox', { name: /From store/ }), 'PUN · Pune');
    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await screen.findByRole('button', { name: 'Add APX-1L' }));
    await user.type(screen.getByRole('textbox', { name: 'Quantity of APX-1L' }), '1');
    const submit = screen.getByRole('button', { name: 'Send request' });
    await user.click(submit);
    expect(screen.getByText('Choose two different stores')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /To store/ }), 'HYD · Hyderabad');
    await user.click(submit);
    expect(screen.getByText('One of the stores you work at')).toBeInTheDocument();
    expect(requests.some((request) => request.method === 'POST')).toBe(false);

    await user.selectOptions(
      screen.getByRole('combobox', { name: /From store/ }),
      'HYD · Hyderabad',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /To store/ }), 'PUN · Pune');
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown product variant');
    expect(location()).toBe('/transfers/new');
  });
});
