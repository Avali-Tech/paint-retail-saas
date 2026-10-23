import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Party } from '../api/parties.js';
import { page } from '../test-support/inventory-fixtures.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { OVERVIEW, PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { AMP, APEX, KPH, ROLLER } from '../pos/test-support/pos-fixtures.js';
import { lookupIn } from '../pos/test-support/pos-render.js';
import {
  LINE_TINT,
  ORDER,
  QUOTE,
  SENT_QUOTE,
  WITHIN_LIMIT,
} from './test-support/order-fixtures.js';

const location = () => screen.getByTestId('location').textContent;
const READER = profile(['stores:read', 'sales:read']);
const LAKSHMI: Party = {
  ...PARTY,
  id: 'party-lakshmi',
  displayName: 'Lakshmi',
  roles: ['customer'],
};
const RAMESH: Party = {
  ...PARTY,
  id: 'painter-1',
  displayName: 'Ramesh Painter',
  roles: ['painter'],
};

const editorRoutes = (
  overrides: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /stores': () => json([AMP, KPH]),
  'GET /parties': (request) => {
    const q = String(request.query.get('q')).toLowerCase();
    return json(
      page([PARTY, LAKSHMI, RAMESH].filter((party) => party.displayName.toLowerCase().includes(q))),
    );
  },
  'GET /projects': () =>
    json(page([{ id: 'project-1', number: 'PRJ-000001', name: 'Madhapur Villa' }])),
  'GET /products/lookup': lookupIn([APEX, ROLLER]),
  'GET /quotations/:id': () => json(QUOTE),
  'GET /sales-orders/:id': () => json(ORDER),
  'GET /sales-orders/:id/credit-check': () => json({ approval: 'none' }),
  'GET /sales-orders/:id/availability': () => json({ lines: [] }),
  ...overrides,
});

/** Opens a party field's picker, searches and chooses. */
async function choose(
  user: ReturnType<typeof renderApp>['user'],
  button: string,
  search: string,
  name: string,
) {
  await user.click(screen.getByRole('button', { name: button }));
  await user.type(
    screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
    search,
  );
  await user.click(await screen.findByRole('button', { name: `Choose ${name}` }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QuotationsPage', { timeout: 30_000 }, () => {
  it('lists quotes with filters and pages, and starts a new one', async () => {
    const { user, requests } = renderApp({
      path: '/quotations',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /quotations': (request) =>
          request.query.get('offset') === '0'
            ? json({
                items: [
                  {
                    id: 'quote-2',
                    number: 'QT-000042',
                    version: 2,
                    status: 'sent',
                    storeId: AMP.id,
                    billToPartyId: PARTY.id,
                    billToName: 'Apex Builders',
                    projectId: null,
                    validUntil: '2026-10-22',
                    totalPaise: 15_000_00,
                    createdAt: '2026-10-08T05:00:00.000Z',
                  },
                ],
                total: 51,
                totalCapped: false,
                nextCursor: 'cursor-2',
              })
            : json({ items: [], total: 0, totalCapped: false, nextCursor: null }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Quotations' });
    const [, row] = within(table).getAllByRole('row');
    expect(row).toHaveTextContent('QT-000042v2Apex Builders22 Oct 2026₹15,000.00Sent');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Accepted');
    await user.type(screen.getByRole('searchbox', { name: 'Number or customer' }), 'QT');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('QT');
    });
    expect(requests.at(-1)?.query.get('status')).toBe('accepted');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('cursor')).toBe('cursor-2');
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });
    expect(await screen.findByText('No quotations here')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'New quotation' }));
    await waitFor(() => {
      expect(location()).toBe('/quotations/new');
    });
  });

  it('hides "New quotation" from readers and shows a failure', async () => {
    renderApp({
      path: '/quotations',
      routes: {
        'GET /auth/me': () => json(READER),
        'GET /quotations': () => json({ message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the quotations')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'New quotation' })).toBeNull();
  });
});

describe('quotation editor', { timeout: 30_000 }, () => {
  it('checks the fields, then saves a new quote for any product and opens it', async () => {
    let attempts = 0;
    const { user, requests } = renderApp({
      path: '/quotations/new',
      routes: editorRoutes({
        'POST /quotations': () => {
          attempts += 1;
          return attempts === 1
            ? json({ statusCode: 400, message: 'The store is not registered for GST' }, 400)
            : json(QUOTE, 201);
        },
      }),
    });
    expect(await screen.findByRole('heading', { name: 'New quotation', level: 1 })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getAllByText('This is required')).toHaveLength(2);
    expect(screen.getByText('Add at least one item')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'AMP · Ameerpet');
    await choose(user, 'Choose Bill to', 'Apex', 'Apex Builders');
    expect(screen.getByRole('textbox', { name: /^Bill to/ })).toHaveValue('Apex Builders');
    // Only a painter, contractor or architect is an influencer.
    await choose(user, 'Choose Influencer', 'Lak', 'Lakshmi');
    expect(screen.getByText('Lakshmi is not a painter, contractor or architect')).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }));
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'Ram',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Ramesh Painter' }));
    expect(screen.getByRole('textbox', { name: /^Influencer/ })).toHaveValue('Ramesh Painter');
    await user.selectOptions(
      await screen
        .findByRole('option', { name: 'PRJ-000001 · Madhapur Villa' })
        .then(() => screen.getByRole('combobox', { name: /^Site/ })),
      'PRJ-000001 · Madhapur Villa',
    );
    expect(requests.find((request) => request.path === '/projects')?.query.get('partyId')).toBe(
      PARTY.id,
    );

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Site office');
    await user.type(screen.getByRole('textbox', { name: 'Address' }), 'Plot 12');
    fireEvent.change(screen.getByLabelText(/^Valid until/), { target: { value: '2000-01-01' } });
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'After 5 pm');
    // A paint and a hardware line on the same grid as the counter.
    const scan = screen.getByRole('combobox', { name: 'Scan or search' });
    await user.type(scan, 'APX-20L{Enter}');
    await user.type(scan, 'ROL-9{Enter}');
    await user.type(scan, '+');
    expect(screen.getByText('Items total ₹10,970.00')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Choose the state the goods go to')).toBeVisible();
    expect(screen.getByText('Choose today or a later day')).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: /^State/ }), '36 · Telangana');
    fireEvent.change(screen.getByLabelText(/^Valid until/), { target: { value: '2099-01-01' } });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The store is not registered for GST')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByRole('heading', { name: 'Quotation QT-000042 v1', level: 1 }),
    ).toBeVisible();
    expect(location()).toBe('/quotations/quote-1');
    const posts = requests.filter((request) => request.method === 'POST');
    expect(posts[0]?.headers['Idempotency-Key']).toBe(posts[1]?.headers['Idempotency-Key']);
    expect(posts[1]?.body).toEqual({
      storeId: AMP.id,
      billToPartyId: PARTY.id,
      influencerPartyId: 'painter-1',
      projectId: 'project-1',
      shipTo: { name: 'Site office', address: 'Plot 12', stateCode: '36' },
      note: 'After 5 pm',
      validUntil: '2099-01-01',
      lines: [
        { variantId: 'v-apex-20', quantity: 1, unitPricePaise: 1_045_000 },
        { variantId: 'v-roller-9', quantity: 2, unitPricePaise: 26_000 },
      ],
    });
  });

  it('edits a draft (removing the influencer, changing the bill-to clears the site)', async () => {
    const { user, requests } = renderApp({
      path: '/quotations/quote-1/edit',
      routes: editorRoutes({
        // Still valid whenever the test runs: a past date cannot be saved.
        'GET /quotations/:id': () => json({ ...QUOTE, validUntil: '2099-01-01' }),
        'PUT /quotations/:id': () => json(QUOTE),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Edit QT-000042', level: 1 })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Bill' })).toHaveTextContent('Godrej Hinge 4 inch');
    await user.click(screen.getByRole('button', { name: 'Remove Influencer' }));
    await choose(user, 'Change Bill to', 'Lak', 'Lakshmi');
    expect(screen.getByRole('combobox', { name: /^Site/ })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Change Bill to' }));
    await user.click(screen.getByRole('button', { name: 'Change Bill to' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(location()).toBe('/quotations/quote-1');
    });
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.path).toBe('/quotations/quote-1');
    expect(put?.body).toMatchObject({ billToPartyId: 'party-lakshmi', validUntil: '2099-01-01' });
    expect(put?.body).not.toHaveProperty('influencerPartyId');
    expect(put?.body).not.toHaveProperty('projectId');
  });

  it('cancels back to the list or the quote, and refuses to edit a sent one', async () => {
    const first = renderApp({ path: '/quotations/new', routes: editorRoutes() });
    await first.user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(location()).toBe('/quotations');
    first.unmount();

    const second = renderApp({ path: '/quotations/quote-1/edit', routes: editorRoutes() });
    await second.user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(location()).toBe('/quotations/quote-1');
    second.unmount();

    renderApp({
      path: '/quotations/quote-2/edit',
      routes: editorRoutes({ 'GET /quotations/:id': () => json(SENT_QUOTE) }),
    });
    expect(
      await screen.findByText('QT-000042 is no longer a draft, so it cannot be edited.'),
    ).toBeVisible();
  });
});

describe('QuotationPage', { timeout: 30_000 }, () => {
  it('shows a draft with its facts, sends it, prints and shares it', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const { user, requests } = renderApp({
      path: '/quotations/quote-1',
      routes: editorRoutes({
        'POST /quotations/:id/send': () => json({ ...QUOTE, status: 'sent' }),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Quotation QT-000042 v1', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('Valid until 22 Oct 2026')).toBeVisible();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(details).toHaveTextContent('InfluencerRamesh Painter');
    expect(within(details).getByRole('link', { name: 'Madhapur Villa' })).toHaveAttribute(
      'href',
      '/projects/project-1',
    );
    expect(details).toHaveTextContent('Site office, Plot 12, Madhapur, 36 · Telangana');
    expect(details).toHaveTextContent('NoteDelivery after 5 pm');
    expect(screen.getByRole('table', { name: 'Lines' })).toHaveTextContent('Godrej Hinge 4 inch');
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/quotations/quote-1/edit',
    );
    await waitFor(() => {
      expect(details).toHaveTextContent('StoreAMP · Ameerpet');
    });
    expect(screen.getByRole('link', { name: 'Share on WhatsApp' })).toHaveAttribute(
      'href',
      `https://wa.me/919876543210?text=${encodeURIComponent(
        'ABC Paints: quotation QT-000042 v1 for ₹15,000.00, valid until 22 Oct 2026. The PDF follows in this chat.',
      )}`,
    );
    expect(
      within(screen.getByRole('region', { name: 'Versions' })).getByText('v1'),
    ).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Print' }));
    const layer = screen.getByTestId('quotation-print');
    expect(print).toHaveBeenCalledTimes(1);
    expect(layer).toHaveTextContent('Quotation');
    expect(layer).toHaveTextContent('Ameerpet');
    expect(layer).toHaveTextContent('GSTIN 36AABCU9603R1ZO');
    expect(layer).toHaveTextContent('Madhapur Villa');
    expect(layer).toHaveTextContent('Rupees Fifteen Thousand Only');
    expect(layer).toHaveTextContent('This is a quotation, not a tax invoice.');
    expect(layer).toHaveTextContent('CGST₹1,144.07');
    expect(layer).not.toHaveTextContent('IGST');

    await user.click(screen.getByRole('button', { name: 'Mark as sent' }));
    expect(await screen.findByText('Quotation marked as sent')).toBeVisible();
    expect(requests.at(-1)?.method).toBe('GET');
    expect(requests.some((request) => request.path === '/quotations/quote-1/send')).toBe(true);
  });

  it('accepts, revises to a new version and converts a sent quote', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    let revised = false;
    const { user, requests } = renderApp({
      path: '/quotations/quote-2',
      routes: editorRoutes({
        'GET /quotations/:id': (request) =>
          json(
            request.path.endsWith('quote-3')
              ? { ...SENT_QUOTE, id: 'quote-3', version: 3, status: 'draft' }
              : SENT_QUOTE,
          ),
        'POST /quotations/:id/accept': () =>
          json({ statusCode: 409, message: 'It has expired' }, 409),
        'POST /quotations/:id/revise': () => {
          revised = true;
          return json({ ...SENT_QUOTE, id: 'quote-3', version: 3, status: 'draft' });
        },
        'POST /quotations/:id/convert': () => json(ORDER, 201),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Quotation QT-000042 v2', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Share on WhatsApp' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^https:\/\/wa\.me\/\?text=/),
    );
    expect(screen.getByRole('link', { name: 'v1' })).toHaveAttribute('href', '/quotations/quote-1');
    await user.click(screen.getByRole('button', { name: 'Print' }));
    const layer = screen.getByTestId('quotation-print');
    expect(layer).not.toHaveTextContent('GSTIN');
    expect(layer).not.toHaveTextContent('Site and delivery');
    expect(layer).toHaveTextContent('IGST₹2,288.13');
    expect(print).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Customer accepted' }));
    expect(await screen.findByText('It has expired')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Convert to order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Convert QT-000042 to an order' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Payment terms' }),
      'Paid in advance',
    );
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Goods come from' }),
      'KPH · Kukatpally',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), ' Urgent ');
    await user.click(within(dialog).getByRole('button', { name: 'Make the order' }));
    expect(
      await screen.findByRole('heading', { name: 'Sales order SO-000017', level: 1 }),
    ).toBeVisible();
    const convert = requests.find((request) => request.path.endsWith('/convert'));
    expect(convert?.body).toEqual({
      paymentTerms: 'prepaid',
      fulfilStoreId: KPH.id,
      note: 'Urgent',
    });
    expect(convert?.headers['Idempotency-Key']).toEqual(expect.any(String));
    expect(revised).toBe(false);
  });

  it('revises, converts with defaults, and links a converted quote to its order', async () => {
    const { user, requests } = renderApp({
      path: '/quotations/quote-2',
      routes: editorRoutes({
        'GET /quotations/:id': (request) =>
          json(
            request.path.endsWith('quote-3')
              ? {
                  ...SENT_QUOTE,
                  id: 'quote-3',
                  version: 3,
                  status: 'converted',
                  salesOrderId: 'order-1',
                }
              : { ...SENT_QUOTE, status: 'accepted' },
          ),
        'POST /quotations/:id/revise': () =>
          json({ ...SENT_QUOTE, id: 'quote-3', version: 3, status: 'draft' }),
        'POST /quotations/:id/convert': () => json(ORDER, 201),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Convert to order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Convert QT-000042 to an order' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Goods come from' }), '');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Payment terms' }),
      'On credit',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(
      await screen.findByRole('heading', { name: 'Quotation QT-000042 v3', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('New version made; the earlier one stays as it was')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the order' })).toHaveAttribute(
      'href',
      '/sales-orders/order-1',
    );
    expect(screen.queryByRole('button', { name: 'Revise' })).toBeNull();
    expect(requests.some((request) => request.path.endsWith('/convert'))).toBe(false);
  });

  it('converts with the quote’s own store and no note', async () => {
    const { user, requests } = renderApp({
      path: '/quotations/quote-2',
      routes: editorRoutes({
        'GET /quotations/:id': () => json({ ...SENT_QUOTE, status: 'accepted' }),
        'POST /quotations/:id/convert': () => json(ORDER, 201),
        // The order opens with its credit panel.
        'GET /sales-orders/:id/credit-check': () => json(WITHIN_LIMIT),
        'GET /parties/:id/overview': () => json(OVERVIEW),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Convert to order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Convert QT-000042 to an order' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Goods come from' }), '');
    await user.click(within(dialog).getByRole('button', { name: 'Make the order' }));
    await waitFor(() => {
      expect(location()).toBe('/sales-orders/order-1');
    });
    expect(found(requests.find((request) => request.path.endsWith('/convert'))).body).toEqual({
      paymentTerms: 'postpaid',
    });
    // The quote and its dialog are gone: the focus lands on the new order's heading.
    const heading = await screen.findByRole('heading', { level: 1, name: 'Sales order SO-000017' });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('shows readers no actions, and an expired quote only "Revise"', async () => {
    const first = renderApp({
      path: '/quotations/quote-2',
      routes: editorRoutes({
        'GET /auth/me': () => json(READER),
        'GET /stores': () => json([]),
        'GET /quotations/:id': () =>
          json({
            ...SENT_QUOTE,
            lines: SENT_QUOTE.lines.map((line, index) =>
              index === 0 ? { ...line, tint: LINE_TINT } : line,
            ),
          }),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Quotation QT-000042 v2', level: 1 }),
    ).toBeVisible();
    const tint = 'Tint X 132 · Ivory Mist · Base Asian Paints Apex Ultima 20 l · Formula XY 12 ml';
    expect(screen.getByRole('table', { name: 'Lines' })).toHaveTextContent(tint);
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await first.user.click(screen.getByRole('button', { name: 'Print' }));
    expect(screen.getByTestId('quotation-print')).not.toHaveTextContent('Ameerpet');
    expect(screen.getByTestId('quotation-print')).toHaveTextContent(tint);
    expect(screen.queryByRole('button', { name: 'Convert to order' })).toBeNull();
    first.unmount();
    renderApp({
      path: '/quotations/quote-2',
      routes: editorRoutes({
        'GET /quotations/:id': () => json({ ...SENT_QUOTE, status: 'expired' }),
      }),
    });
    expect(await screen.findByRole('button', { name: 'Revise' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Convert to order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Customer accepted' })).toBeNull();
  });

  it('downloads the server’s PDF in the member’s language, and says when it cannot', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:quote'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    let answer = 0;
    const { user, requests } = renderApp({
      path: '/quotations/quote-1',
      routes: editorRoutes({
        'GET /quotations/:id/pdf': () => {
          answer += 1;
          if (answer === 1) {
            return {
              status: 200,
              raw: '%PDF-1.7',
              headers: { 'content-disposition': 'attachment; filename="QT-000042-v1.pdf"' },
            };
          }
          if (answer === 2) return { status: 200, raw: '%PDF-1.7' };
          return json({ statusCode: 404, message: 'Quotation not found' }, 404);
        },
      }),
    });
    const download = await screen.findByRole('button', { name: 'Download PDF' });
    await user.click(download);
    await waitFor(() => {
      expect(names).toEqual(['QT-000042-v1.pdf']);
    });
    const pdf = requests.find((request) => request.path === '/quotations/quote-1/pdf');
    expect(pdf?.query.toString()).toBe('lang=en');
    // Without a file name from the server, the number and version name it.
    await user.click(download);
    await waitFor(() => {
      expect(names).toEqual(['QT-000042-v1.pdf', 'QT-000042-v1.pdf']);
    });
    await user.click(download);
    expect(await screen.findByText('Quotation not found')).toBeVisible();
    expect(download).toBeEnabled();
  });

  it('says when a quotation cannot be loaded', async () => {
    renderApp({
      path: '/quotations/nope',
      routes: editorRoutes({ 'GET /quotations/:id': () => json({ message: 'Down' }, 500) }),
    });
    expect(await screen.findByText('Could not load the quotation')).toBeVisible();
  });
});
