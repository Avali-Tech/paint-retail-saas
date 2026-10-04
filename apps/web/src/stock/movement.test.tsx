import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { APEX, STORES, page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { checkMovement, takesCost, type Line } from './MovementPage.js';

const location = () => screen.getByTestId('location').textContent;

function renderMovement(routes: Record<string, FakeHandler> = {}, path = '/stock/movements/new') {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /stores': () => json(STORES),
      'GET /products': () => json(page([APEX])),
      'GET /stock': () => json(page([])),
      ...routes,
    },
  });
}

const line = (quantity: string, unitCost = ''): Line => ({
  variantId: 'v1',
  sku: 'APX-1L',
  name: 'Apex',
  quantity,
  unitCost,
});

describe('checkMovement', () => {
  it('needs a reason except for opening stock, and at least one line', () => {
    expect(checkMovement('adjustment', ' x ', [])).toEqual({
      note: 'stock.movement.noteRequired',
      lines: 'stock.movement.noLines',
    });
    expect(checkMovement('opening', '', [line('5')])).toEqual({});
    // A note on opening stock is optional, but the API wants 3+ characters when there is one.
    expect(checkMovement('opening', ' ab ', [line('5')])).toEqual({
      note: 'stock.movement.noteShort',
    });
  });

  it('checks each quantity and cost', () => {
    expect(checkMovement('opening', '', [line('0')])).toEqual({
      'line-v1': 'stock.movement.quantityInvalid',
    });
    expect(checkMovement('damage', 'Broken', [line('-1')])).toEqual({
      'line-v1': 'stock.movement.positive',
    });
    expect(checkMovement('adjustment', 'Recount', [line('-1', 'abc')])).toEqual({});
    expect(checkMovement('adjustment', 'Recount', [line('2', 'abc')])).toEqual({
      'cost-v1': 'products.form.priceInvalid',
    });
  });

  it('takes a cost only for stock coming in', () => {
    expect(takesCost('opening', 2)).toBe(true);
    expect(takesCost('adjustment', -2)).toBe(false);
    expect(takesCost('damage', 2)).toBe(false);
  });
});

describe('MovementPage', () => {
  it('records opening stock found by search, with a cost', async () => {
    let body: unknown;
    const { user } = renderMovement(
      {
        'POST /stock/movements': (request) => {
          body = request.body;
          return json(page([]), 201);
        },
      },
      '/stock/movements/new?store=store-hyd&type=opening',
    );
    expect(await screen.findByRole('combobox', { name: 'What happened' })).toHaveDisplayValue(
      'Opening stock',
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Store' })).toHaveDisplayValue('HYD · Hyderabad');
    });
    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await screen.findByRole('button', { name: 'Add APX-4L' }));
    expect(screen.queryByRole('button', { name: 'Add APX-4L' })).toBeNull();
    const quantity = screen.getByRole('textbox', { name: 'Quantity of APX-4L' });
    await user.type(quantity, '6');
    await user.type(screen.getByRole('textbox', { name: 'Cost per unit of APX-4L (₹)' }), '1200');
    await user.click(screen.getByRole('button', { name: 'Save movement' }));
    await waitFor(() => {
      expect(location()).toBe('/stock?store=store-hyd');
    });
    expect(body).toEqual({
      storeId: 'store-hyd',
      type: 'opening',
      lines: [{ variantId: 'variant-4l', quantity: 6, unitCostPaise: 120_000 }],
    });
    expect(await screen.findByText('Stock updated')).toBeInTheDocument();
  });

  it('writes off damage for a scanned barcode, with a reason', async () => {
    let body: unknown;
    const { user } = renderMovement({
      'GET /products/lookup': () => json({ product: APEX, variant: APEX.variants[0] }),
      'POST /stock/movements': (request) => {
        body = request.body;
        return json(page([]), 201);
      },
    });
    const type = await screen.findByRole('combobox', { name: 'What happened' });
    await user.selectOptions(type, 'Damaged or expired');
    await user.click(screen.getByRole('button', { name: 'Save movement' }));
    expect(screen.getByText('Choose a store', { selector: '.ui-field__error' })).toBeVisible();
    expect(screen.getByText('Say why stock is being adjusted or written off')).toBeVisible();
    expect(screen.getByText('Add at least one product')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    const finder = screen.getByRole('searchbox', { name: 'Add a product' });
    await user.type(finder, '8901234567890{Enter}');
    expect(await screen.findByText('APX-1L')).toBeInTheDocument();
    expect(finder).toHaveValue('');
    // Damaged stock is written off at its average cost: no cost to enter.
    expect(screen.queryByRole('textbox', { name: /Cost per unit/ })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Quantity of APX-1L' }), '-1');
    await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Tins dented in delivery');
    await user.click(screen.getByRole('button', { name: 'Save movement' }));
    expect(screen.getByText('Enter a positive quantity')).toBeVisible();
    const quantity = screen.getByRole('textbox', { name: 'Quantity of APX-1L' });
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Save movement' }));
    await waitFor(() => {
      expect(body).toEqual({
        storeId: 'store-pun',
        type: 'damage',
        note: 'Tins dented in delivery',
        lines: [{ variantId: 'variant-1l', quantity: 2 }],
      });
    });
  });

  it('adjusts counts both ways, sending a cost only for stock coming in', async () => {
    let body: unknown;
    let attempts = 0;
    const { user } = renderMovement({
      'POST /stock/movements': (request) => {
        attempts += 1;
        body = request.body;
        return attempts === 1
          ? json({ message: 'Not enough stock of APX-1L at HYD' }, 409)
          : json(page([]), 201);
      },
    });
    await screen.findByRole('option', { name: 'HYD · Hyderabad' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'HYD · Hyderabad');
    await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Recount');
    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await screen.findByRole('button', { name: 'Add APX-1L' }));
    await user.click(screen.getByRole('button', { name: 'Add APX-4L' }));
    expect(screen.getAllByText('Use a minus sign to remove stock')).toHaveLength(2);
    await user.type(screen.getByRole('textbox', { name: 'Quantity of APX-1L' }), '-3');
    // Stock going out leaves at its average cost: no cost to type.
    expect(screen.queryByRole('textbox', { name: 'Cost per unit of APX-1L (₹)' })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Quantity of APX-4L' }), '1.5');
    await user.click(screen.getByRole('button', { name: 'Save movement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough stock of APX-1L at HYD');
    await user.click(screen.getByRole('button', { name: 'Remove APX-1L' }));
    await user.click(screen.getByRole('button', { name: 'Save movement' }));
    await waitFor(() => {
      expect(attempts).toBe(2);
    });
    expect(body).toEqual({
      storeId: 'store-hyd',
      type: 'adjustment',
      note: 'Recount',
      lines: [{ variantId: 'variant-4l', quantity: 1.5 }],
    });
  });

  it('ignores a type in the address it does not know', async () => {
    renderMovement({}, '/stock/movements/new?type=sale');
    const type = await screen.findByRole('combobox', { name: 'What happened' });
    expect(type).toHaveDisplayValue('Adjustment (more or fewer than recorded)');
    fireEvent.change(type, { target: { value: 'sale' } });
    expect(type).toHaveDisplayValue('Adjustment (more or fewer than recorded)');
  });

  it('offers only open stores to record a movement at', async () => {
    renderMovement({
      'GET /stores': () => json([STORES[0], { ...STORES[1], isActive: false }]),
    });
    expect(await screen.findByRole('option', { name: 'HYD · Hyderabad' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'PUN · Pune' })).toBeNull();
  });
});

describe('ProductPicker', () => {
  it('offers pack sizes no longer sold where old stock is corrected', async () => {
    const { user, requests } = renderMovement({
      'GET /products': () =>
        json(page([{ ...APEX, variants: [{ ...APEX.variants[1], isActive: false }] }])),
    });
    await user.type(await screen.findByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await screen.findByRole('button', { name: 'Add APX-4L' }));
    expect(screen.getByRole('textbox', { name: 'Quantity of APX-4L' })).toBeInTheDocument();
    expect(
      requests.find((request) => request.path === '/products')?.query.get('includeInactive'),
    ).toBe('true');
  });

  it('leaves out and refuses what is no longer sold on other documents', async () => {
    let calls = 0;
    const { user } = renderApp({
      path: '/transfers/new',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /stores': () => json(STORES),
        'GET /products': () =>
          json(page([{ ...APEX, variants: [{ ...APEX.variants[1], isActive: false }] }])),
        'GET /products/lookup': () => {
          calls += 1;
          return calls === 1
            ? json({ product: APEX, variant: { ...APEX.variants[1], isActive: false } })
            : json({ product: { ...APEX, isActive: false }, variant: APEX.variants[0] });
        },
      },
    });
    const finder = await screen.findByRole('searchbox', { name: 'Add a product' });
    await user.type(finder, 'apex');
    expect(await screen.findByText('No products found')).toBeInTheDocument();
    await user.clear(finder);
    await user.type(finder, 'APX-4L{Enter}');
    expect(await screen.findByText('APX-4L is no longer sold')).toBeInTheDocument();
    await user.clear(finder);
    await user.type(finder, 'APX-1L{Enter}');
    expect(await screen.findByText('APX-1L is no longer sold')).toBeInTheDocument();
  });

  it('offers active pack sizes not yet chosen, and says when nothing matches', async () => {
    const { user } = renderApp({
      path: '/transfers/new',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /stores': () => json(STORES),
        'GET /products': (request) =>
          json(
            page(
              request.query.get('q') === 'none'
                ? []
                : [
                    {
                      ...APEX,
                      variants: [APEX.variants[0], { ...APEX.variants[1], isActive: false }],
                    },
                  ],
            ),
          ),
      },
    });
    const finder = await screen.findByRole('searchbox', { name: 'Add a product' });
    await user.type(finder, 'a');
    await user.type(finder, 'pex');
    const add = await screen.findByRole('button', { name: 'Add APX-1L' });
    expect(add.closest('li')).toHaveTextContent('APX-1L Asian Paints Apex Ultima 1 l');
    expect(screen.queryByRole('button', { name: 'Add APX-4L' })).toBeNull();
    await user.clear(finder);
    await user.type(finder, 'none');
    expect(await screen.findByText('No products found')).toBeInTheDocument();
  });

  it('explains a scanned code it cannot add', async () => {
    let calls = 0;
    const { user } = renderMovement({
      'GET /products/lookup': () => {
        calls += 1;
        if (calls === 1) return json({ product: APEX, variant: APEX.variants[0] });
        if (calls === 2) return json({ product: APEX, variant: APEX.variants[0] });
        if (calls === 3) return json({ message: 'Not Found' }, 404);
        return json({ message: 'Server error' }, 500);
      },
    });
    const finder = await screen.findByRole('searchbox', { name: 'Add a product' });
    await user.type(finder, '{Enter}');
    expect(calls).toBe(0);
    await user.type(finder, 'APX-1L{Enter}');
    await screen.findByRole('textbox', { name: 'Quantity of APX-1L' });
    await user.type(finder, 'APX-1L{Enter}');
    expect(await screen.findByText('APX-1L is already on the list')).toBeInTheDocument();
    await user.clear(finder);
    expect(screen.queryByText('APX-1L is already on the list')).toBeNull();
    await user.type(finder, 'XYZ{Enter}');
    expect(await screen.findByText('No product has the code “XYZ”')).toBeInTheDocument();
    await user.type(finder, '{Enter}');
    expect(await screen.findByText('Server error')).toBeInTheDocument();
    await user.type(finder, 'z');
    expect(screen.queryByText('Server error')).toBeNull();
  });
});
