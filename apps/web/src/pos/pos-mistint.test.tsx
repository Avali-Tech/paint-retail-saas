import type { MistintView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test-support/fake-api.js';
import { APEX, AMP } from './test-support/pos-fixtures.js';
import { renderPos } from './test-support/pos-render.js';

beforeEach(() => {
  vi.spyOn(window, 'print').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const CAN: MistintView = {
  id: 'can-1',
  status: 'available',
  store: { id: AMP.id, code: AMP.code, name: AMP.name },
  variant: { id: 'v-apex-20', sku: 'APX-20L', packSize: 20, unit: 'l', label: null },
  product: { id: APEX.id, name: APEX.name },
  brand: { name: 'Asian Paints' },
  quantity: 1,
  shadeCode: 'X110',
  shadeName: 'Ivory Mist',
  intendedShade: 'X101',
  reason: 'Typed X110 for X101',
  costPaise: 800_000,
  soldTaxablePaise: null,
  lossPaise: null,
  invoice: null,
  note: null,
  createdAt: '2026-10-20T05:00:00.000Z',
  createdBy: 'Suresh',
  resolvedAt: null,
};

const pickUp = (can: MistintView) =>
  renderPos(
    {
      'GET /mistinted-cans/:id': () => json(can),
      'GET /products/:id': () => json(APEX),
    },
    undefined,
    '/pos?mistint=can-1',
  );

describe('PosPage: a mistinted can sent to the counter', () => {
  it('adds it whole, with its shade, and bills it as the can', async () => {
    const { user, requests } = pickUp(CAN);
    const offer = await screen.findByText('Mistinted APX-20L, tinted X110, sent to the counter');
    expect(offer).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add to the bill' }));

    const line = await screen.findByRole('listitem', { name: 'Asian Paints Apex Ultima 20 l' });
    expect(within(line).getByText('Mistinted can: X110')).toBeInTheDocument();
    expect(within(line).getByRole('textbox', { name: /^Quantity of/ })).toBeDisabled();
    expect(within(line).getByRole('button', { name: /^One more/ })).toBeDisabled();
    expect(screen.queryByText(/sent to the counter/)).toBeNull();
    await waitFor(() => {
      const draft = requests.find(
        (request) => request.method === 'POST' && request.path === '/invoices',
      );
      expect(draft?.body).toMatchObject({
        lines: [{ variantId: 'v-apex-20', quantity: 1, mistintCanId: 'can-1' }],
      });
    });
  });

  it('says why it cannot be sold here', async () => {
    const gone = pickUp({ ...CAN, status: 'sold' });
    expect(await screen.findByText('It is already sold or written off.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to the bill' })).toBeNull();
    gone.unmount();

    const away = pickUp({ ...CAN, store: { id: 'store-kph', code: 'KPH', name: 'Kukatpally' } });
    expect(await screen.findByText('It is at KPH: sell it from there.')).toBeInTheDocument();
    away.unmount();

    renderPos(
      {
        'GET /mistinted-cans/:id': () => json(CAN),
        'GET /products/:id': () =>
          json({
            ...APEX,
            variants: APEX.variants.map((v) => ({ ...v, sellingPricePaise: null })),
          }),
      },
      undefined,
      '/pos?mistint=can-1',
    );
    expect(await screen.findByText('The product has no selling price.')).toBeInTheDocument();
  });
});
