import type { EstimateRequest, EstimateView } from '@paint/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from '../test-support/inventory-fixtures.js';
import {
  OWNER,
  json,
  profile,
  type FakeHandler,
  type FakeRequest,
} from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { AMP, KPH } from '../pos/test-support/pos-fixtures.js';
import { QUOTE } from '../orders/test-support/order-fixtures.js';
import {
  APCOLITE,
  ESTIMATE,
  PAINT_PRODUCTS,
  PRIMER,
  PUTTY,
  ROYALE,
  TRACTOR,
} from './test-support/estimate-fixtures.js';

const location = () => screen.getByTestId('location').textContent;
const READER = profile(['stores:read', 'sales:read', 'parties:read', 'catalog:read']);

const SUMMARY = {
  id: ESTIMATE.id,
  number: ESTIMATE.number,
  status: 'draft',
  storeId: AMP.id,
  partyId: PARTY.id,
  partyName: 'Apex Builders',
  projectId: null,
  title: 'Reddy residence',
  totalNetAreaSqft: 1350.5,
  quotationId: null,
  createdAt: '2026-10-08T05:00:00.000Z',
};

/** The estimate as the server would store it from a request. */
const stored = (request: FakeRequest, id = 'estimate-new'): EstimateView => {
  const body = request.body as EstimateRequest;
  return { ...ESTIMATE, id, number: 'ES-000008', storeId: body.storeId, title: body.title ?? null };
};

const routes = (overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /stores': () => json([AMP, KPH]),
  'GET /parties': () => json(page([PARTY])),
  'GET /products': (request) => {
    const q = String(request.query.get('q')).toLowerCase();
    const type = request.query.get('type');
    return json(
      page(
        PAINT_PRODUCTS.filter(
          (product) =>
            product.name.toLowerCase().includes(q) && (type === null || product.type === type),
        ),
      ),
    );
  },
  'GET /products/:id': (request) =>
    json(PAINT_PRODUCTS.find((product) => request.path.endsWith(product.id))),
  'GET /estimates/:id': () => json(ESTIMATE),
  'POST /estimates': (request) => json(stored(request), 201),
  'PUT /estimates/:id': (request) => json(stored(request, String(request.path.split('/')[2]))),
  'POST /estimates/:id/compute': (request) =>
    json({ ...ESTIMATE, id: request.path.split('/')[2], number: 'ES-000008' }),
  'POST /estimates/:id/convert': () => json({ ...QUOTE, id: 'quote-9', number: 'QT-000099' }),
  'GET /quotations/:id': () => json({ ...QUOTE, id: 'quote-9', number: 'QT-000099' }),
  ...overrides,
});

type User = ReturnType<typeof renderApp>['user'];

/** Opens a product slot, searches and chooses. */
async function chooseProduct(user: User, slot: string, search: string, name: string) {
  await user.click(screen.getByRole('button', { name: `Change: ${slot}` }));
  await user.type(screen.getByRole('searchbox', { name: `Search products for ${slot}` }), search);
  await user.click(await screen.findByRole('button', { name: `Choose Asian Paints ${name}` }));
  // The list goes with the chosen button: the focus is back on "Change".
  await waitFor(() => {
    expect(screen.getByRole('button', { name: `Change: ${slot}` })).toHaveFocus();
  });
}

/** Types a room's measures (fireEvent: many fields, kept quick). */
function fillRoom(legend: string, values: Record<string, string>) {
  const room = screen.getByRole('group', { name: legend });
  for (const [field, value] of Object.entries(values)) {
    fireEvent.change(within(room).getByRole('textbox', { name: field }), { target: { value } });
  }
}

const tier = (name: string) => screen.getByRole('region', { name });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EstimatesPage', { timeout: 30_000 }, () => {
  it('lists estimates with filters and pages, and starts a new one', async () => {
    const { user, requests } = renderApp({
      path: '/estimates',
      routes: routes({
        'GET /estimates': (request) =>
          request.query.get('offset') === '0'
            ? json({
                items: [
                  SUMMARY,
                  {
                    ...SUMMARY,
                    id: 'e2',
                    number: 'ES-000002',
                    status: 'converted',
                    partyName: null,
                    title: null,
                  },
                ],
                total: 51,
                totalCapped: false,
                nextCursor: 'cursor-2',
              })
            : json({ items: [], total: 0, totalCapped: false, nextCursor: null }),
      }),
    });
    const table = await screen.findByRole('table', { name: 'Estimates' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('ES-000007Apex BuildersReddy residence1,350.5 sq ftDraft');
    expect(second).toHaveTextContent('ES-000002——1,350.5 sq ftQuoted');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Quoted');
    await user.type(screen.getByRole('searchbox', { name: 'Number, title or customer' }), 'ES');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('ES');
    });
    expect(requests.at(-1)?.query.get('status')).toBe('converted');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('cursor')).toBe('cursor-2');
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });
    expect(await screen.findByText('No estimates here')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'New estimate' }));
    await waitFor(() => {
      expect(location()).toBe('/estimates/new');
    });
  });

  it('hides "New estimate" from readers and shows a failure', async () => {
    renderApp({
      path: '/estimates',
      routes: routes({
        'GET /auth/me': () => json(READER),
        'GET /estimates': () => json({ message: 'Down' }, 500),
      }),
    });
    expect(await screen.findByText('Could not load the estimates')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'New estimate' })).not.toBeInTheDocument();
  });
});

describe('EstimatePage', { timeout: 60_000 }, () => {
  it('turns a 3-room estimate into a quotation', async () => {
    const { user, requests } = renderApp({ path: '/estimates/new', routes: routes() });
    expect(await screen.findByRole('heading', { name: 'New estimate', level: 1 })).toBeVisible();
    await screen.findByRole('option', { name: 'AMP · Ameerpet' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'AMP · Ameerpet');
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Reddy residence' },
    });

    fillRoom('Room 1', { Room: 'Hall', 'Length (ft)': '14', 'Width (ft)': '12' });
    await user.click(
      within(screen.getByRole('group', { name: 'Hall' })).getByRole('checkbox', {
        name: 'Paint the ceiling too',
      }),
    );
    expect(
      within(screen.getByRole('group', { name: 'Hall' })).getByRole('status'),
    ).toHaveTextContent('651 sq ft to paint');
    await user.click(screen.getByRole('button', { name: 'Add room' }));
    fillRoom('Room 2', { Room: 'Bedroom', 'Length (ft)': '12', 'Width (ft)': '10', Coats: '3' });
    await user.selectOptions(
      within(screen.getByRole('group', { name: 'Bedroom' })).getByRole('combobox', {
        name: 'Condition',
      }),
      'New',
    );
    await user.click(screen.getByRole('button', { name: 'Add room' }));
    fillRoom('Room 3', { Room: 'Kitchen', 'Length (ft)': '10', 'Width (ft)': '8', Windows: '2' });
    expect(screen.getByText('Total: 1,361 sq ft')).toBeVisible();

    await chooseProduct(user, 'Good', 'tractor', 'Tractor Emulsion');
    expect(within(tier('Good')).getByText('27.34 L of paint')).toBeVisible();
    expect(
      within(tier('Good'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '27.34 L of paint',
      '1 × Asian Paints Tractor Emulsion 20 l₹4,000.00',
      '2 × Asian Paints Tractor Emulsion 4 l₹1,800.00',
    ]);
    await chooseProduct(user, 'Better', 'apcolite', 'Apcolite Premium');
    await chooseProduct(user, 'Best', 'royale', 'Royale Luxury');
    expect(within(tier('Best')).getByText('₹18,100.00')).toBeVisible();
    await chooseProduct(user, 'primer', 'primer', 'Wall Primer');
    await chooseProduct(user, 'putty', 'putty', 'Wall Putty');
    expect(within(tier('Good')).getByText('3.14 L of primer')).toBeVisible();
    expect(within(tier('Good')).getByText('29.62 kg of putty')).toBeVisible();

    // A quotation needs the customer.
    await user.click(
      within(tier('Better')).getByRole('button', { name: 'Make quotation: Better' }),
    );
    expect(screen.getByText('Choose the customer to make a quotation')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Choose Customer' }));
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'Apex',
    );
    await user.click(await screen.findByRole('button', { name: `Choose ${PARTY.displayName}` }));

    await user.click(
      within(tier('Better')).getByRole('button', { name: 'Make quotation: Better' }),
    );
    await waitFor(() => {
      expect(location()).toBe('/quotations/quote-9');
    });
    expect(await screen.findByText('Quotation QT-000099 made')).toBeVisible();
    // A new page: the focus starts on its heading.
    const quote = await screen.findByRole('heading', { level: 1, name: /^Quotation QT-000099/ });
    await waitFor(() => {
      expect(quote).toHaveFocus();
    });
    const create = found(
      requests.find((request) => request.method === 'POST' && request.path === '/estimates'),
    );
    expect(create.headers['Idempotency-Key']).toEqual(expect.any(String));
    const body = create.body as EstimateRequest;
    expect(body).toMatchObject({
      storeId: AMP.id,
      partyId: PARTY.id,
      title: 'Reddy residence',
      wastageBps: 500,
    });
    expect(body.surfaces.map((surface) => [surface.room, surface.kind])).toEqual([
      ['Hall', 'interior_wall'],
      ['Hall', 'ceiling'],
      ['Bedroom', 'interior_wall'],
      ['Kitchen', 'interior_wall'],
    ]);
    expect(body.options).toEqual([
      { tier: 'good', productId: TRACTOR.id, primerProductId: PRIMER.id, puttyProductId: PUTTY.id },
      {
        tier: 'better',
        productId: APCOLITE.id,
        primerProductId: PRIMER.id,
        puttyProductId: PUTTY.id,
      },
      { tier: 'best', productId: ROYALE.id, primerProductId: PRIMER.id, puttyProductId: PUTTY.id },
    ]);
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(
      expect.arrayContaining([
        'POST /estimates/estimate-new/compute',
        'POST /estimates/estimate-new/convert',
      ]),
    );
    expect(requests.find((request) => request.path.endsWith('/convert'))?.body).toEqual({
      tier: 'better',
    });
  });

  it('says what stops a save, and keeps the rooms as typed once saved', async () => {
    const { user, requests } = renderApp({ path: '/estimates/new', routes: routes() });
    await screen.findByRole('heading', { name: 'New estimate', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Save estimate' }));
    // The empty option, and the problem.
    expect(screen.getAllByText('Choose a store')).toHaveLength(2);
    await screen.findByRole('option', { name: 'AMP · Ameerpet' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'AMP · Ameerpet');
    await user.click(screen.getByRole('button', { name: 'Save estimate' }));
    expect(screen.getByText('Fix the rooms marked above')).toBeVisible();
    expect(screen.getByText('Enter the length, width and height in feet')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Room 1' }));
    // The room went with its button: the focus moves to "Add room".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add room' })).toHaveFocus();
    });
    await user.click(screen.getByRole('button', { name: 'Save estimate' }));
    expect(screen.getByText('Add a room')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add room' }));
    fillRoom('Room 2', { Room: '', 'Length (ft)': '10', 'Width (ft)': '9' });
    expect(screen.getByText('Give the room a name')).toBeVisible();
    fillRoom('Room', { Room: 'Study', Doors: 'x' });
    expect(screen.getByText('Doors and windows: whole numbers, less than the walls')).toBeVisible();
    fillRoom('Study', { Doors: '1', Coats: '9' });
    expect(screen.getByText('Coats: 1 to 5')).toBeVisible();
    fillRoom('Study', { Coats: '' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Wastage %' }), {
      target: { value: '60' },
    });
    expect(screen.getAllByText('Wastage: 0 to 50 %')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save estimate' }));
    expect(screen.getAllByText('Wastage: 0 to 50 %')).toHaveLength(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Wastage %' }), {
      target: { value: '10' },
    });

    // A paint without coverage cannot be priced; removing it empties the tier.
    await chooseProduct(user, 'Good', 'ace', 'Ace Exterior');
    expect(
      within(tier('Good')).getByText('Set the coverage of this paint in the catalogue to price it'),
    ).toBeVisible();
    await chooseProduct(user, 'Good', 'old', 'Old Emulsion');
    expect(
      within(tier('Good')).getByText('This paint has no pack with a price on sale'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove: Good' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Change: Good' })).toHaveFocus();
    });
    expect(
      within(tier('Good')).getByText('Choose a paint for a tier to see its packs'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change: Better' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search products for Better' }), 'zz');
    expect(await screen.findByText('No products found')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save estimate' }));
    expect(await screen.findByText('Estimate saved')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe('/estimates/estimate-new');
    });
    expect(screen.getByRole('heading', { name: 'Estimate ES-000008', level: 1 })).toBeVisible();
    // Still the rooms as typed, not as read back.
    expect(
      within(screen.getByRole('group', { name: 'Study' })).getByRole('textbox', {
        name: 'Width (ft)',
      }),
    ).toHaveValue('9');
    expect(
      (
        requests.find((request) => request.method === 'POST' && request.path === '/estimates')
          ?.body as EstimateRequest
      ).wastageBps,
    ).toBe(1000);

    // Saving again updates it.
    await user.click(screen.getByRole('button', { name: 'Save estimate' }));
    await waitFor(() => {
      expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    });
    expect(requests.find((request) => request.method === 'PUT')?.path).toBe(
      '/estimates/estimate-new',
    );
    await waitFor(() => {
      expect(requests.filter((request) => request.path.endsWith('/compute'))).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save estimate' })).toBeEnabled();
    });
    expect(location()).toBe('/estimates/estimate-new');
  });

  it('edits and saves a saved estimate, and shows what the server refuses', async () => {
    const { user, requests } = renderApp({
      path: `/estimates/${ESTIMATE.id}`,
      routes: routes({
        'POST /estimates/:id/convert': () =>
          json({ message: 'Estimate ES-000007 is converted' }, 409),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Estimate ES-000007', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Reddy residence');
    expect(screen.getByRole('textbox', { name: 'Customer' })).toHaveValue('Apex Builders');
    const hall = screen.getByRole('group', { name: 'Hall' });
    expect(within(hall).getByRole('checkbox', { name: 'Paint the ceiling too' })).toBeChecked();
    expect(within(tier('Good')).getByText('11.39 L of paint')).toBeVisible();
    expect(
      within(tier('Better')).getByText('Choose a paint for a tier to see its packs'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save estimate' }));
    expect(await screen.findByText('Estimate saved')).toBeVisible();
    expect(requests.find((request) => request.method === 'PUT')?.path).toBe(
      `/estimates/${ESTIMATE.id}`,
    );
    await user.click(within(tier('Best')).getByRole('button', { name: 'Make quotation: Best' }));
    expect(await screen.findByText('Estimate ES-000007 is converted')).toBeVisible();
    expect(location()).toBe(`/estimates/${ESTIMATE.id}`);

    // A broken room stops the quotation before anything is sent.
    const sent = requests.length;
    fillRoom('Hall', { 'Height (ft)': '' });
    await user.click(within(tier('Best')).getByRole('button', { name: 'Make quotation: Best' }));
    expect(screen.getByText('Fix the rooms marked above')).toBeVisible();
    expect(requests).toHaveLength(sent);
  });

  it('shows where a converted estimate went', async () => {
    const { user } = renderApp({
      path: `/estimates/${ESTIMATE.id}`,
      routes: routes({
        'GET /estimates/:id': () =>
          json({
            ...ESTIMATE,
            status: 'converted',
            quotationId: 'quote-9',
            quotationNumber: 'QT-000099',
            convertedTier: 'best',
          }),
      }),
    });
    expect(
      await screen.findByText('This estimate became quotation QT-000099 (Best).'),
    ).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Open the quotation' }));
    await waitFor(() => {
      expect(location()).toBe('/quotations/quote-9');
    });
  });

  it('lets a reader look but not save or quote', async () => {
    renderApp({
      path: `/estimates/${ESTIMATE.id}`,
      routes: routes({ 'GET /auth/me': () => json(READER) }),
    });
    await screen.findByRole('heading', { name: 'Estimate ES-000007', level: 1 });
    expect(screen.queryByRole('button', { name: 'Save estimate' })).not.toBeInTheDocument();
    expect(
      within(tier('Good')).getByRole('button', { name: 'Make quotation: Good' }),
    ).toBeDisabled();
  });

  it('shows a failure to load an estimate', async () => {
    renderApp({
      path: '/estimates/missing',
      routes: routes({ 'GET /estimates/:id': () => json({ message: 'Not Found' }, 404) }),
    });
    expect(await screen.findByText('Could not load the estimate')).toBeVisible();
  });
});
