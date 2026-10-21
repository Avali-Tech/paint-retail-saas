import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FreeStock } from '../api/stock.js';
import { json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { AMP, KPH } from './test-support/pos-fixtures.js';
import { renderPos, scanBox } from './test-support/pos-render.js';

beforeEach(() => {
  vi.spyOn(window, 'print').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const free = (store: typeof AMP, available: number): FreeStock => ({
  store: { id: store.id, code: store.code, name: store.name },
  available,
});
const PUNE = { id: 'store-pun', code: 'PUN', name: 'Pune' } as unknown as typeof AMP;

/** A counter at Ameerpet with one 20 l Apex on the bill. */
async function scanned(
  routes: Record<string, FakeHandler>,
  member?: Parameters<typeof renderPos>[1],
) {
  const view = renderPos(routes, member);
  await view.user.type(await scanBox(), 'APX-20L{Enter}');
  await screen.findByRole('list', { name: 'Bill' });
  return view;
}

describe('PosPage: stock free at other stores', () => {
  it('says what this store is short of and where it is free, and asks for it to be sent', async () => {
    let body: unknown;
    const { user, requests } = await scanned({
      'GET /stock/free-elsewhere': () => json([free(KPH, 40), free(PUNE, 3)]),
      'POST /transfers': (request) => {
        body = request.body;
        return json({ id: 'tr-1', number: 'TR-000007', status: 'requested' }, 201);
      },
    });
    const alert = await screen.findByText('Only 0 free at this store for 1 on the bill');
    const list = screen.getByRole('list', { name: 'Free at other stores' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Kukatpally: 40 free', 'Pune: 3 free']);
    expect(
      requests.find((request) => request.path === '/stock/free-elsewhere')?.query.get('variantId'),
    ).toBe('v-apex-20');
    expect(alert).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Request transfer here' }));
    const dialog = screen.getByRole('dialog', { name: 'Request stock from another store' });
    const quantity = within(dialog).getByRole('textbox', { name: 'Quantity' });
    expect(quantity).toHaveValue('1');
    // More than the chosen store has free is refused before asking.
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'From' }),
      'Pune: 3 free',
    );
    for (const typed of ['abc', '0', '4']) {
      await user.clear(quantity);
      await user.type(quantity, typed);
      await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a quantity from 1 to 3');
    }
    await user.clear(quantity);
    await user.type(quantity, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a quantity from 1 to 3');
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText(
        'Transfer TR-000007 requested: it waits for the other store to approve it',
      ),
    ).toBeInTheDocument();
    expect(body).toEqual({
      fromStoreId: 'store-pun',
      toStoreId: AMP.id,
      lines: [{ variantId: 'v-apex-20', quantity: 2 }],
    });
  });

  it('shows nothing while this store has enough', async () => {
    const { requests } = await scanned({
      'GET /stock/free-elsewhere': () => json([free(AMP, 5), free(KPH, 40)]),
    });
    await waitFor(() => {
      expect(requests.some((request) => request.path === '/stock/free-elsewhere')).toBe(true);
    });
    expect(screen.queryByText(/free at this store/)).toBeNull();
  });

  it('says when no store has it free', async () => {
    await scanned({ 'GET /stock/free-elsewhere': () => json([]) });
    expect(await screen.findByText('No other store has it free either.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request transfer here' })).toBeNull();
  });

  it('asks nothing of staff who cannot see stock', async () => {
    const seller = profile(['stores:read', 'catalog:read', 'sales:read', 'billing:issue'], {
      allStores: false,
      storeIds: [AMP.id],
    });
    const { requests } = await scanned({}, seller);
    expect(requests.some((request) => request.path === '/stock/free-elsewhere')).toBe(false);
  });
});
