import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, type FakeHandler, type FakeRequest } from '../test-support/fake-api.js';
import { page, product, variant } from '../test-support/inventory-fixtures.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { document, draftLine } from '../pos/test-support/pos-fixtures.js';
import { PRODUCTS, lookupIn, renderPos, scanBox } from '../pos/test-support/pos-render.js';
import { PASTEL, tintRecord } from './test-support/tint-fixtures.js';

// The tint panel at the counter (spec §6.3, §7 Round 5 demo).

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = 'Asian Paints Apex Pastel Base 4 l';
const APEX_NAME = 'Asian Paints Apex Ultima 20 l';

/** The lines of the last draft saved (POST or PUT /invoices). */
const savedLines = (requests: readonly FakeRequest[]) =>
  (
    requests.findLast(
      (request) =>
        (request.method === 'POST' || request.method === 'PUT') &&
        request.path.startsWith('/invoices'),
    )?.body as { lines: { unitPricePaise: number; tint?: object }[] } | undefined
  )?.lines ?? [];

/** The counter with the pastel base on sale and a shade history answering `history`. */
function counter(
  history: FakeHandler = () => json(page([])),
  routes: Record<string, FakeHandler> = {},
) {
  return renderPos({
    'GET /products/lookup': lookupIn([...PRODUCTS, PASTEL]),
    'GET /tint-records': history,
    ...routes,
  });
}

async function openTint(user: ReturnType<typeof renderPos>['user'], name = BASE) {
  await user.click(await screen.findByRole('button', { name: `Tint ${name}` }));
  return screen.findByRole('dialog', { name: `Tint ${name}` });
}

/** Colorants: XY loose by the ml (dosable), XY by the litre can and a discontinued red (not). */
const COLORANTS = product({
  id: 'p-colorant',
  name: 'Universal colorant',
  type: 'colorant',
  variants: [
    variant({ id: 'clr-xy-ml', sku: 'CLR-XY-ML', packSize: 1, unit: 'ml', label: 'XY' }),
    variant({ id: 'clr-xy-1l', sku: 'CLR-XY-1L', packSize: 1, unit: 'l', label: 'XY' }),
    variant({
      id: 'clr-red-g',
      sku: 'CLR-RED-G',
      packSize: 1,
      unit: 'g',
      label: 'Red',
      isActive: false,
    }),
  ],
});

describe('the tint panel at the counter', { timeout: 30_000 }, () => {
  it('takes a dose from a loose colorant in stock (round 8a)', async () => {
    const { user, requests } = counter(undefined, {
      'GET /products': (request) =>
        json(page(request.query.get('type') === 'colorant' ? [COLORANTS] : [])),
    });
    await user.type(await scanBox(), 'APB-4L{Enter}');
    const dialog = await openTint(user);
    await user.type(within(dialog).getByRole('textbox', { name: /^Shade code/ }), 'X 132');
    await user.type(within(dialog).getByRole('textbox', { name: 'Colorant 1' }), 'XY');
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount 1' }), '10');
    const from = await within(dialog).findByRole('combobox', { name: 'Colorant 1 taken from' });
    expect(
      within(from)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Not taken from stock', 'Universal colorant · XY · 1 ml']);
    await user.selectOptions(from, 'Universal colorant · XY · 1 ml');
    await user.click(within(dialog).getByRole('button', { name: 'Apply tint' }));
    await waitFor(() => {
      expect(savedLines(requests)[0]?.tint).toMatchObject({
        formula: [{ colorant: 'XY', amount: 10, unit: 'ml', colorantVariantId: 'clr-xy-ml' }],
      });
    });

    // Opened again, the dose still names it; choosing "not from stock" drops it.
    await user.click(screen.getByRole('button', { name: `Edit the tint of ${BASE}` }));
    const again = await screen.findByRole('dialog', { name: `Tint ${BASE}` });
    const chosen = within(again).getByRole('combobox', { name: 'Colorant 1 taken from' });
    expect(chosen).toHaveValue('clr-xy-ml');
    await user.selectOptions(chosen, 'Not taken from stock');
    await user.click(within(again).getByRole('button', { name: 'Apply tint' }));
    await waitFor(() => {
      expect(
        (savedLines(requests)[0]?.tint as { formula: object[] }).formula[0],
      ).not.toHaveProperty('colorantVariantId');
    });
    expect(savedLines(requests)[0]?.tint).toMatchObject({
      formula: [{ colorant: 'XY', amount: 10, unit: 'ml' }],
    });
  });

  it('tints a base with its formula and machine, prices the charge in, and records it on the saved line', async () => {
    const { user, requests } = counter();
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await user.type(box, 'APB-4L{Enter}');
    await screen.findByRole('listitem', { name: BASE });
    // Only a tintable product's line has a tint panel.
    expect(screen.queryByRole('button', { name: `Tint ${APEX_NAME}` })).toBeNull();

    const dialog = await openTint(user);
    expect(
      within(dialog).getByText('Choose the customer, or search by shade, name or mobile'),
    ).toBeVisible();
    // Removing the only colorant leaves an empty row to type in.
    await user.type(within(dialog).getByRole('textbox', { name: 'Colorant 1' }), 'Old');
    await user.click(within(dialog).getByRole('button', { name: 'Remove colorant 1' }));
    expect(within(dialog).getByRole('textbox', { name: 'Colorant 1' })).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Apply tint' }));
    expect(within(dialog).getByText('Enter the shade code (up to 40 characters)')).toBeVisible();

    const field = (name: RegExp) => within(dialog).getByRole('textbox', { name });
    await user.type(field(/^Shade code/), 'x  132');
    await user.type(field(/^Shade name/), 'Ivory Mist');
    await user.type(field(/^Machine/), 'Counter 1');
    await user.type(field(/^Tinting charge/), '50');
    await user.type(field(/^Colorant cost/), 'abc');
    await user.type(within(dialog).getByRole('textbox', { name: 'Colorant 1' }), 'XY');
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount 1' }), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Apply tint' }));
    expect(within(dialog).getByText('Enter an amount in rupees')).toBeVisible();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Give each colorant a name and an amount above zero (up to 3 decimals)',
    );

    await user.clear(field(/^Colorant cost/));
    await user.type(field(/^Colorant cost/), '30');
    await user.clear(within(dialog).getByRole('textbox', { name: 'Amount 1' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount 1' }), '12.5');
    await user.click(within(dialog).getByRole('button', { name: 'Add colorant' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Colorant 2' }), 'Fast Red');
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount 2' }), '3');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Unit 2' }), 'shots');
    await user.click(within(dialog).getByRole('button', { name: 'Add colorant' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove colorant 3' }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply tint' }));

    const line = screen.getByRole('listitem', { name: BASE });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(within(line).getByText('Shade X 132 · Ivory Mist · tinting ₹50.00')).toBeVisible();
    expect(within(line).getByText(/₹2,050\.00 each/)).toBeVisible();

    // Saved: the draft's line carries the tinted price and the tint itself.
    await waitFor(() => {
      expect(savedLines(requests)[1]?.tint).toBeDefined();
    });
    expect(savedLines(requests)[1]).toEqual({
      variantId: 'v-pastel-4',
      quantity: 1,
      unitPricePaise: 205_000,
      tint: {
        shadeCode: 'X 132',
        shadeName: 'Ivory Mist',
        machine: 'Counter 1',
        tintChargePaise: 5_000,
        colorantCostPaise: 3_000,
        formula: [
          { colorant: 'XY', amount: 12.5, unit: 'ml' },
          { colorant: 'Fast Red', amount: 3, unit: 'shot' },
        ],
      },
    });
    expect(
      requests.some((request) => request.method === 'POST' && request.path === '/tint-records'),
    ).toBe(false);

    // Edit: the form opens filled; removing the tint takes the charge off.
    await user.click(screen.getByRole('button', { name: `Edit the tint of ${BASE}` }));
    const again = await screen.findByRole('dialog', { name: `Tint ${BASE}` });
    expect(within(again).getByRole('textbox', { name: /^Shade code/ })).toHaveValue('X 132');
    expect(within(again).getByRole('textbox', { name: 'Colorant 2' })).toHaveValue('Fast Red');
    await user.click(within(again).getByRole('button', { name: 'Remove tint' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // A line in another shade is another row.
    const plain = screen.getByRole('listitem', { name: BASE });
    expect(within(plain).queryByText(/Shade X 132/)).toBeNull();
    expect(within(plain).getByText(/₹2,000\.00 each/)).toBeVisible();
    // Re-saved without its tint: the line is untinted on the server too.
    await waitFor(() => {
      expect(savedLines(requests)[1]).toEqual({
        variantId: 'v-pastel-4',
        quantity: 1,
        unitPricePaise: 200_000,
      });
    });
  });

  it('keeps the tint panel working on the line that takes a removed line’s place and focus', async () => {
    const { user } = counter();
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await user.type(box, 'APB-4L{Enter}');
    await screen.findByRole('listitem', { name: BASE });
    await user.click(screen.getByRole('button', { name: `Remove ${APEX_NAME}` }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Remove ${BASE}` })).toHaveFocus();
    });
    const dialog = await openTint(user);
    expect(within(dialog).getByRole('textbox', { name: /^Shade code/ })).toBeVisible();
  });

  it('finds the shade billed at Ameerpet for a repeat order at Kukatpally, and searches wider', async () => {
    const history = vi.fn<(request: FakeRequest) => ReturnType<FakeHandler>>((request) => {
      const q = request.query.get('q');
      if (q === 'oops') return json({ message: 'Down' }, 500);
      if (q === 'teal') return json(page([]));
      return json(
        page([
          tintRecord(),
          tintRecord({
            id: 'tint-2',
            shadeCode: 'L 101',
            shadeName: null,
            tintChargePaise: 0,
            party: null,
            document: {
              kind: 'quotation',
              id: 'q1',
              number: null,
              status: 'draft',
              date: '2026-10-01',
            },
          }),
        ]),
      );
    });
    const { user, requests } = counter(history, {
      'GET /parties': () => json(page([PARTY])),
      'GET /parties/:id/overview': () => json({ message: 'Down' }, 500),
    });
    const box = await scanBox();
    await user.type(box, 'APB-4L{Enter}');
    await user.click(screen.getByRole('button', { name: 'Find customer' }));
    await user.type(screen.getByRole('textbox', { name: 'Customer mobile' }), '9876543210{Enter}');
    expect(await screen.findByText('Apex Builders · +919876543210')).toBeInTheDocument();

    const dialog = await openTint(user);
    const shades = within(dialog).getByRole('region', { name: 'Same shade as last time' });
    expect(await within(shades).findByText('X 132 · Ivory Mist')).toBeVisible();
    expect(history.mock.calls[0]?.[0].query.toString()).toBe(`partyId=${PARTY.id}&limit=20`);
    expect(within(shades).getByText('On Apex Pastel Base 4 l · tinting ₹50.00')).toBeVisible();
    expect(
      within(shades).getByText(
        'Deccan Contractors · Ameerpet · 14 Sept 2026 · Invoice AMP/26-27/000042',
      ),
    ).toBeVisible();
    // A draft quotation's shade, nobody's, no charge: no number, no party.
    expect(within(shades).getByText('Ameerpet · 1 Oct 2026')).toBeVisible();

    await user.click(within(shades).getByRole('button', { name: 'Use X 132' }));
    expect(within(dialog).getByRole('textbox', { name: /^Shade code/ })).toHaveValue('X 132');
    expect(within(dialog).getByRole('textbox', { name: /^Machine/ })).toHaveValue('Counter 1');

    // A search looks across every customer; Enter does not apply the tint.
    const search = within(dialog).getByRole('searchbox', { name: /^Search shades/ });
    await user.type(search, 'teal{Enter}');
    expect(await within(shades).findByText('No shade found')).toBeVisible();
    expect(history.mock.calls.at(-1)?.[0].query.toString()).toBe('q=teal&limit=20');
    await user.clear(search);
    await user.type(search, 'oops');
    expect(await within(shades).findByText('Could not load the shade history')).toBeVisible();
    expect(screen.getByRole('dialog', { name: `Tint ${BASE}` })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Apply tint' }));
    const line = screen.getByRole('listitem', { name: BASE });
    expect(
      await within(line).findByText('Shade X 132 · Ivory Mist · tinting ₹50.00'),
    ).toBeVisible();
    await waitFor(() => {
      expect(savedLines(requests)[0]?.tint).toMatchObject({
        brandId: 'brand-asian',
        shadeCode: 'X 132',
      });
    });

    // Cancel leaves the line as it was.
    await user.click(screen.getByRole('button', { name: `Edit the tint of ${BASE}` }));
    await user.click(
      within(await screen.findByRole('dialog', { name: `Tint ${BASE}` })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(within(line).getByText('Shade X 132 · Ivory Mist · tinting ₹50.00')).toBeVisible();
  });

  it('resumes a bill held on another device with the tints on its lines', async () => {
    const held = document({
      id: 'far-1',
      lines: [
        draftLine({
          id: 'far-line',
          variantId: 'v-pastel-4',
          unitPricePaise: 205_000,
          quantity: 2,
          tint: tintRecord({ note: 'Match the old wall' }),
        }),
      ],
    });
    const { user, requests } = counter(undefined, {
      'GET /invoices': () =>
        json({
          items: [
            {
              id: 'far-1',
              kind: 'invoice',
              status: 'draft',
              storeId: held.storeId,
              number: null,
              issuedOn: null,
              buyerName: null,
              totalPaise: 0,
            },
          ],
          total: 1,
        }),
      'GET /invoices/:id': () => json(held),
    });
    await scanBox();
    await user.click(await screen.findByRole('button', { name: 'Held (1)' }));
    await user.click(
      await screen.findByRole('button', { name: 'Resume the bill of Walk-in customer' }),
    );
    const line = await screen.findByRole('listitem', { name: 'Item 1 (held on another device)' });
    expect(within(line).getByText('Shade X 132 · Ivory Mist · tinting ₹50.00')).toBeVisible();
    await user.click(
      within(line).getByRole('button', {
        name: 'Edit the tint of Item 1 (held on another device)',
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Tint Item 1 (held on another device)',
    });
    expect(within(dialog).getByRole('textbox', { name: /^Tinting charge/ })).toHaveValue('50.00');
    // Re-saved: the note read with the line goes back unchanged.
    await user.click(within(dialog).getByRole('button', { name: 'Apply tint' }));
    await waitFor(() => {
      expect(savedLines(requests)[0]?.tint).toMatchObject({
        shadeCode: 'X 132',
        note: 'Match the old wall',
      });
    });
  });
});
