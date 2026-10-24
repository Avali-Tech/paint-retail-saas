import type { MistintView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { APEX, HYD, PUN, STORES, page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const can = (overrides: Partial<MistintView> = {}): MistintView => ({
  id: 'can-1',
  status: 'available',
  store: { id: HYD.id, code: HYD.code, name: HYD.name },
  variant: { id: 'variant-1l', sku: 'APX-1L', packSize: 1, unit: 'l', label: null },
  product: { id: APEX.id, name: APEX.name },
  brand: { name: 'Asian Paints' },
  quantity: 1,
  shadeCode: 'X110',
  shadeName: 'Ivory Mist',
  intendedShade: 'X101',
  reason: 'Typed X110 for X101',
  costPaise: 80_000,
  soldTaxablePaise: null,
  lossPaise: null,
  invoice: null,
  note: null,
  createdAt: '2026-10-20T05:00:00.000Z',
  createdBy: 'Suresh',
  resolvedAt: null,
  ...overrides,
});

const PUNE_CAN = can({
  id: 'can-2',
  store: { id: PUN.id, code: PUN.code, name: PUN.name },
  shadeName: null,
  intendedShade: null,
  costPaise: null,
});

function renderMistints(
  routes: Record<string, FakeHandler> = {},
  { member = OWNER, path = '/stock/mistints' }: { member?: unknown; path?: string } = {},
) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json(STORES),
      'GET /stores/directory': () => json(STORES.map(({ id, code, name }) => ({ id, code, name }))),
      'GET /mistinted-cans': () => json(page([can(), PUNE_CAN])),
      'GET /products': () => json(page([APEX])),
      ...routes,
    },
  });
}

const rows = () =>
  within(screen.getByRole('table', { name: 'Mistinted cans' }))
    .getAllByRole('row')
    .map((row) => row.textContent);

describe('MistintsPage', () => {
  it('lists every branch’s cans waiting to be sold, with their shade, cost and ways to sell or write off', async () => {
    renderMistints();
    await screen.findByRole('table', { name: 'Mistinted cans' });
    expect(rows()).toEqual([
      'ProductStoreQuantityShade it isWhat happenedCostActions',
      'Asian Paints Apex UltimaAPX-1L · 1 lHYD1X110 · Ivory MistWanted X101Typed X110 for X101Suresh · 20 Oct 2026₹800.00Sell at the counter Write off',
      'Asian Paints Apex UltimaAPX-1L · 1 lPUN1X110Typed X110 for X101Suresh · 20 Oct 2026—Sell at the counter Write off',
    ]);
    expect(screen.getAllByRole('link', { name: 'Sell at the counter' })[0]).toHaveAttribute(
      'href',
      '/pos?mistint=can-1',
    );
  });

  it('shows sold and written-off cans with their loss, by status and store in the address', async () => {
    const { user, requests } = renderMistints(
      {
        'GET /mistinted-cans': (request) =>
          json(
            page(
              request.query.get('status') === 'written_off'
                ? [
                    can({
                      status: 'written_off',
                      note: 'Spilled',
                      lossPaise: 80_000,
                      resolvedAt: '2026-10-21T05:00:00.000Z',
                    }),
                  ]
                : [
                    can({
                      status: 'sold',
                      lossPaise: 30_000,
                      soldTaxablePaise: 50_000,
                      invoice: { id: 'inv-1', number: 'AMP/26-27/000009' },
                    }),
                    // Sold, but its cost was never known: no loss to give.
                    can({
                      id: 'can-3',
                      status: 'sold',
                      costPaise: null,
                      lossPaise: null,
                      soldTaxablePaise: 40_000,
                    }),
                  ],
            ),
          ),
      },
      { path: '/stock/mistints?status=sold' },
    );
    await screen.findByRole('link', { name: 'AMP/26-27/000009' });
    expect(rows()[1]).toContain('₹300.00');
    expect(rows()[2]).toContain('——');
    expect(screen.queryByRole('link', { name: 'Sell at the counter' })).toBeNull();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Written off');
    expect(await screen.findByText('Spilled')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'PUN · Pune');
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/mistinted-cans').at(-1);
      expect(last?.query.get('status')).toBe('written_off');
      expect(last?.query.get('storeId')).toBe(PUN.id);
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Waiting to be sold');
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/mistinted-cans').at(-1);
      expect(last?.query.get('status')).toBe('available');
    });
  });

  it('records a mistinted can, asking for what it needs first', async () => {
    let body: unknown;
    const { user } = renderMistints({
      'POST /mistinted-cans': (request) => {
        body = request.body;
        return json(can(), 201);
      },
    });
    await user.click(await screen.findByRole('button', { name: '+ Mistinted can' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a mistinted can' });
    await user.click(within(dialog).getByRole('button', { name: 'Record it' }));
    expect(
      within(dialog).getByText(
        'Choose the store and product, and give the shade it is and what went wrong',
      ),
    ).toBeInTheDocument();

    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Store' }),
      'HYD · Hyderabad',
    );
    await user.type(within(dialog).getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await within(dialog).findByRole('button', { name: 'Add APX-4L' }));
    await user.click(within(dialog).getByRole('button', { name: 'Change' }));
    await user.type(within(dialog).getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await within(dialog).findByRole('button', { name: 'Add APX-1L' }));
    await user.click(within(dialog).getByRole('button', { name: 'Record it' }));
    expect(within(dialog).getByText(/Choose the store and product/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /^Shade it is/ }), ' X110 ');
    await user.type(
      within(dialog).getByRole('textbox', { name: /^What went wrong/ }),
      'Typed X110 for X101',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record it' }));
    expect(await screen.findByText('Mistinted APX-1L recorded')).toBeInTheDocument();
    expect(body).toEqual({
      storeId: HYD.id,
      variantId: 'variant-1l',
      quantity: 1,
      shadeCode: 'X110',
      reason: 'Typed X110 for X101',
    });
  });

  it('records the shade names too, and the quantity must be a number', async () => {
    let body: unknown;
    const { user } = renderMistints({
      'POST /mistinted-cans': (request) => {
        body = request.body;
        return json(can(), 201);
      },
    });
    await user.click(await screen.findByRole('button', { name: '+ Mistinted can' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a mistinted can' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Store' }),
      'HYD · Hyderabad',
    );
    await user.type(within(dialog).getByRole('searchbox', { name: 'Add a product' }), 'apex');
    await user.click(await within(dialog).findByRole('button', { name: 'Add APX-1L' }));
    const quantity = within(dialog).getByRole('textbox', { name: 'Quantity' });
    await user.clear(quantity);
    await user.type(quantity, 'x');
    await user.type(within(dialog).getByRole('textbox', { name: /^Shade it is/ }), 'X110');
    await user.type(within(dialog).getByRole('textbox', { name: 'Shade name' }), 'Ivory Mist');
    await user.type(within(dialog).getByRole('textbox', { name: 'Shade that was wanted' }), 'X101');
    await user.type(
      within(dialog).getByRole('textbox', { name: /^What went wrong/ }),
      'Machine over-dosed',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record it' }));
    expect(within(dialog).getByText(/Choose the store and product/)).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Record it' }));
    await waitFor(() => {
      expect(body).toMatchObject({ quantity: 2, shadeName: 'Ivory Mist', intendedShade: 'X101' });
    });
  });

  it('writes a can off with a reason', async () => {
    let note: unknown;
    const { user } = renderMistints({
      'POST /mistinted-cans/:id/write-off': (request) => {
        note = request.body;
        return json(can({ status: 'written_off' }));
      },
    });
    await screen.findByRole('table', { name: 'Mistinted cans' });
    const [first] = screen.getAllByRole('button', { name: 'Write off' }) as [HTMLElement];
    await user.click(first);
    const dialog = screen.getByRole('dialog', { name: 'Write off mistinted APX-1L?' });
    await user.click(within(dialog).getByRole('button', { name: 'Write off' }));
    expect(within(dialog).getByText('Say why it is written off')).toBeInTheDocument();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Why it is written off' }),
      'Spilled',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Write off' }));
    expect(await screen.findByText('Mistinted APX-1L written off')).toBeInTheDocument();
    expect(note).toEqual({ note: 'Spilled' });
  });

  it('only reads for staff of other stores without the permissions, without costs', async () => {
    const reader = profile(['stores:read', 'inventory:read'], {
      allStores: false,
      storeIds: [PUN.id],
    });
    renderMistints({}, { member: reader });
    await screen.findByRole('table', { name: 'Mistinted cans' });
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Mistinted can' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sell at the counter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write off' })).toBeNull();
  });

  it('says when there are none, and when they cannot load', async () => {
    const empty = renderMistints({ 'GET /mistinted-cans': () => json(page([])) });
    expect(await screen.findByText('No mistinted cans here')).toBeInTheDocument();
    empty.unmount();
    renderMistints({ 'GET /mistinted-cans': () => json({ message: 'Down' }, 500) });
    expect(await screen.findByText('Could not load mistinted cans')).toBeInTheDocument();
  });

  it('pages through many', async () => {
    const { user, requests } = renderMistints({
      'GET /mistinted-cans': () => json(page([can()], 120)),
    });
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => {
      const last = requests.filter((request) => request.path === '/mistinted-cans').at(-1);
      expect(last?.query.get('offset')).toBe('50');
    });
    expect(screen.getByText('51–100 of 120')).toBeInTheDocument();
  });
});
