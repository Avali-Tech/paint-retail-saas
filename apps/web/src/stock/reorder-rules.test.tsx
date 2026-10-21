import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { APEX, STORES, page, rule } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { checkLevels } from './ReorderRulesPage.js';

const location = () => screen.getByTestId('location').textContent;

function renderRules(
  routes: Record<string, FakeHandler> = {},
  { member = OWNER, path = '/stock/reorder-rules' } = {},
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /reorder-rules': () => json(page([rule()])),
      'GET /products': () => json(page([APEX])),
      ...routes,
    },
  });
}

describe('checkLevels', () => {
  it('accepts minimum ≤ reorder level ≤ maximum', () => {
    expect(checkLevels('0', '5', '20')).toEqual({
      minQuantity: 0,
      reorderLevel: 5,
      maxQuantity: 20,
    });
  });

  it('refuses levels the API would refuse', () => {
    expect(checkLevels('', '5', '20')).toBe('stock.rules.levelInvalid');
    expect(checkLevels('1', 'x', '20')).toBe('stock.rules.levelInvalid');
    expect(checkLevels('1', '5', '')).toBe('stock.rules.levelInvalid');
    expect(checkLevels('-1', '5', '20')).toBe('stock.rules.levelInvalid');
    expect(checkLevels('0', '-5', '20')).toBe('stock.rules.levelInvalid');
    expect(checkLevels('0', '0', '0')).toBe('stock.rules.maxInvalid');
    expect(checkLevels('6', '5', '20')).toBe('stock.rules.orderInvalid');
    expect(checkLevels('1', '25', '20')).toBe('stock.rules.orderInvalid');
  });
});

describe('ReorderRulesPage', () => {
  it('links to suggestions from sales, for the store in view', async () => {
    renderRules();
    expect(await screen.findByRole('link', { name: 'Suggest from sales' })).toHaveAttribute(
      'href',
      '/stock/reorder-rules/suggestions',
    );
  });

  it('opens suggestions for the chosen store', async () => {
    renderRules({}, { path: '/stock/reorder-rules?store=store-hyd' });
    expect(await screen.findByRole('link', { name: 'Suggest from sales' })).toHaveAttribute(
      'href',
      '/stock/reorder-rules/suggestions?store=store-hyd',
    );
  });

  it('lists the rules, filtered by store and search in the address', async () => {
    const { user, requests } = renderRules();
    const table = await screen.findByRole('table', { name: 'Reorder rules' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'ProductStoreMinimumReorder atOrder up toActions',
      'Asian Paints Apex UltimaAPX-1L · 1 lHYD2520EditRemove',
    ]);
    await screen.findByRole('option', { name: 'PUN · Pune' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    await user.type(screen.getByRole('searchbox', { name: 'Search by product or SKU' }), 'apx');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('apx');
    });
    expect(requests.at(-1)?.query.get('storeId')).toBe('store-pun');
    expect(location()).toBe('/stock/reorder-rules?store=store-pun&q=apx');
  });

  it('sets levels for a product at a store', async () => {
    let body: unknown;
    const { user } = renderRules(
      {
        'PUT /reorder-rules': (request) => {
          body = request.body;
          return json({ saved: 1 });
        },
      },
      { path: '/stock/reorder-rules?store=store-pun' },
    );
    await user.click(await screen.findByRole('button', { name: 'Set reorder levels' }));
    const dialog = screen.getByRole('dialog', { name: 'Set reorder levels' });
    expect(within(dialog).getByRole('combobox', { name: 'Store' })).toHaveValue('store-pun');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Store' }), '');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a store');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Store' }),
      'HYD · Hyderabad',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Add the product these levels are for',
    );
    await user.type(within(dialog).getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await within(dialog).findByRole('button', { name: 'Add APX-1L' }));
    await user.click(within(dialog).getByRole('button', { name: 'Choose another product' }));
    await user.type(within(dialog).getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await within(dialog).findByRole('button', { name: 'Add APX-4L' }));
    expect(dialog).toHaveTextContent('APX-4L Asian Paints Apex Ultima 4 l');
    await user.type(within(dialog).getByRole('textbox', { name: 'Minimum' }), '6');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reorder at' }), '4');
    await user.type(within(dialog).getByRole('textbox', { name: 'Order up to' }), '12');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Use minimum ≤ reorder level ≤ order up to',
    );
    await user.clear(within(dialog).getByRole('textbox', { name: 'Minimum' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Minimum' }), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(body).toEqual({
      rules: [
        {
          storeId: 'store-hyd',
          variantId: 'variant-4l',
          minQuantity: 2,
          reorderLevel: 4,
          maxQuantity: 12,
        },
      ],
    });
    expect(await screen.findByText('Reorder levels saved')).toBeInTheDocument();
  });

  it('edits and removes a rule', async () => {
    const bodies: unknown[] = [];
    const { user, requests } = renderRules({
      'PUT /reorder-rules': (request) => {
        bodies.push(request.body);
        return json({ saved: 1 });
      },
      'DELETE /reorder-rules/:storeId/:variantId': () => ({ status: 204 }),
    });
    await user.click(await screen.findByRole('button', { name: 'Edit levels of APX-1L at HYD' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit levels of APX-1L at HYD' });
    expect(within(dialog).queryByRole('combobox', { name: 'Store' })).toBeNull();
    const max = within(dialog).getByRole('textbox', { name: 'Order up to' });
    expect(max).toHaveValue('20');
    await user.clear(max);
    await user.type(max, '30');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(bodies).toEqual([
      {
        rules: [
          {
            storeId: 'store-hyd',
            variantId: 'variant-1l',
            minQuantity: 2,
            reorderLevel: 5,
            maxQuantity: 30,
          },
        ],
      },
    ]);

    await user.click(screen.getByRole('button', { name: 'Remove the rule for APX-1L at HYD' }));
    const confirm = screen.getByRole('dialog', { name: 'Remove the rule for APX-1L at HYD' });
    expect(confirm).toHaveTextContent('The product will no longer show as low at this store.');
    await user.click(within(confirm).getByRole('button', { name: 'Remove rule' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(
      requests.some(
        (request) =>
          request.method === 'DELETE' && request.path === '/reorder-rules/store-hyd/variant-1l',
      ),
    ).toBe(true);
    expect(await screen.findByText('Rule removed')).toBeInTheDocument();
  });

  it('says when there are no rules, or none match', async () => {
    renderRules({ 'GET /reorder-rules': () => json(page([])) });
    expect(await screen.findByText('No reorder rules yet')).toBeInTheDocument();
  });

  it('says when no rule matches the filters', async () => {
    renderRules(
      { 'GET /reorder-rules': () => json(page([])) },
      { path: '/stock/reorder-rules?store=store-hyd' },
    );
    expect(await screen.findByText('No rules match these filters')).toBeInTheDocument();
  });

  it('pages through many rules', async () => {
    const { user } = renderRules({ 'GET /reorder-rules': () => json(page([rule()], 60)) });
    const pages = await screen.findByRole('navigation', { name: 'Reorder rule pages' });
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(location()).toBe('/stock/reorder-rules?offset=50');
    });
  });

  it('is read-only for staff who cannot change stock settings', async () => {
    renderRules({}, { member: CASHIER });
    const table = await screen.findByRole('table', { name: 'Reorder rules' });
    expect(within(table).getAllByRole('row')[0]).toHaveTextContent(
      'ProductStoreMinimumReorder atOrder up to',
    );
    expect(screen.queryByRole('button', { name: 'Set reorder levels' })).toBeNull();
  });

  it('shows a loading problem', async () => {
    renderRules({ 'GET /reorder-rules': () => json({ message: 'Down' }, 503) });
    expect(await screen.findByText('Could not load reorder rules')).toBeInTheDocument();
  });
});
