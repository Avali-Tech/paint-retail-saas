import { SYSTEM_ROLES, type Permission, type SalesOrderView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { page } from '../test-support/inventory-fixtures.js';
import { CREDIT, OVERVIEW, PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { INVOICE } from '../test-support/sales-fixtures.js';
import { AMP, APEX, KPH } from '../pos/test-support/pos-fixtures.js';
import { lookupIn } from '../pos/test-support/pos-render.js';
import {
  AVAILABILITY,
  BLOCKED,
  CONFIRMED,
  LINE_TINT,
  NEEDS_MANAGER,
  ORDER,
  OVER_LIMIT,
  STORE_KPH,
  WITHIN_LIMIT,
} from './test-support/order-fixtures.js';

const location = () => screen.getByTestId('location').textContent;
const roleOf = (key: string) => found(SYSTEM_ROLES.find((role) => role.key === key));
const BRANCH_MANAGER = profile(
  [...roleOf('branch_manager').permissions, 'sales:manage', 'credit:approve'],
  {
    role: { key: 'branch_manager', name: 'Branch Manager' },
  },
);
const SALES = profile(
  roleOf('sales_executive').permissions.filter(
    (permission: Permission) => permission !== 'credit:manage',
  ),
  { role: { key: 'sales_executive', name: 'Sales Executive' } },
);
const READER = profile(['stores:read', 'sales:read']);

const orderRoutes = (
  order: SalesOrderView,
  overrides: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /stores': () => json([AMP, KPH]),
  'GET /sales-orders/:id': () => json(order),
  'GET /sales-orders/:id/credit-check': () => json(OVER_LIMIT),
  'GET /sales-orders/:id/availability': () => json(AVAILABILITY),
  'GET /parties/:id/overview': () => json(OVERVIEW),
  'GET /invoices/:id': () => json(INVOICE),
  'GET /invoices/:id/adjustments': () => json({ lines: [], notes: [], creditNoteWindow: null }),
  'GET /invoices/:id/dispatches': () =>
    json({
      invoiceId: INVOICE.id,
      stockPosting: 'on_issue',
      ewayThresholdPaise: 0,
      lines: [],
      dispatches: [],
    }),
  ...overrides,
});

const credit = () => screen.getByRole('region', { name: 'Credit' });

describe('SalesOrdersPage', { timeout: 30_000 }, () => {
  it('lists orders and starts a new one', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /sales-orders': (request) =>
          request.query.get('offset') !== '0'
            ? json({ items: [], total: 0, totalCapped: false, nextCursor: null })
            : json({
                items: [
                  {
                    id: 'order-1',
                    number: 'SO-000017',
                    status: 'partly_fulfilled',
                    storeId: AMP.id,
                    paymentTerms: 'postpaid',
                    billToPartyId: PARTY.id,
                    billToName: 'Apex Builders',
                    projectId: null,
                    totalPaise: 15_000_00,
                    invoicedPaise: 9_000_00,
                    createdAt: '2026-10-08T05:00:00.000Z',
                  },
                ],
                total: 51,
                totalCapped: false,
                nextCursor: 'cursor-2',
              }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Sales orders' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(
      'SO-000017On creditApex Builders8 Oct 2026₹15,000.00₹9,000.00Partly billed',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Confirmed');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('status')).toBe('confirmed');
    });
    await user.type(screen.getByRole('searchbox', { name: 'Number or customer' }), 'SO');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('SO');
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('cursor')).toBe('cursor-2');
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });
    expect(await screen.findByText('No sales orders here')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'New order' }));
    expect(await screen.findByRole('heading', { name: 'New sales order', level: 1 })).toBeVisible();
  });

  it('shows readers no "New order", and a failure', async () => {
    renderApp({
      path: '/sales-orders',
      routes: {
        'GET /auth/me': () => json(READER),
        'GET /sales-orders': () => json({ message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the sales orders')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'New order' })).toBeNull();
  });
});

describe('order editor', { timeout: 30_000 }, () => {
  it('takes a direct order with payment terms', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/new',
      routes: orderRoutes(ORDER, {
        'GET /parties': () => json(page([PARTY])),
        'GET /projects': () => json(page([])),
        'GET /products/lookup': lookupIn([APEX]),
        'POST /sales-orders': () => json(ORDER, 201),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'New sales order', level: 1 })).toBeVisible();
    expect(screen.queryByLabelText(/^Valid until/)).toBeNull();
    await screen.findByRole('option', { name: 'KPH · Kukatpally' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), 'KPH · Kukatpally');
    await user.click(screen.getByRole('button', { name: 'Choose Bill to' }));
    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }),
      'Apex',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose Apex Builders' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Payment terms' }),
      'Part advance',
    );
    const scan = screen.getByRole('combobox', { name: 'Scan or search' });
    // "3*" alone sets the quantity of the selected line; with no line it does nothing.
    await user.type(scan, '+');
    await user.type(scan, '3*{Enter}');
    await user.type(scan, 'APX-20L{Enter}');
    await user.type(scan, '3*{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByRole('heading', { name: 'Sales order SO-000017', level: 1 }),
    ).toBeVisible();
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      storeId: KPH.id,
      billToPartyId: PARTY.id,
      paymentTerms: 'partial',
      lines: [{ variantId: 'v-apex-20', quantity: 3, unitPricePaise: 1_045_000 }],
    });
  });

  it('edits a draft order and refuses a confirmed one', async () => {
    const first = renderApp({
      path: '/sales-orders/order-1/edit',
      routes: orderRoutes(ORDER, { 'PUT /sales-orders/:id': () => json(ORDER) }),
    });
    expect(await screen.findByRole('heading', { name: 'Edit SO-000017', level: 1 })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Payment terms' })).toHaveValue('postpaid');
    await first.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(location()).toBe('/sales-orders/order-1');
    });
    expect(first.requests.find((request) => request.method === 'PUT')?.path).toBe(
      '/sales-orders/order-1',
    );
    first.unmount();
    renderApp({ path: '/sales-orders/order-1/edit', routes: orderRoutes(CONFIRMED) });
    expect(
      await screen.findByText('SO-000017 is no longer a draft, so it cannot be edited.'),
    ).toBeVisible();
  });
});

describe('OrderPage: credit and confirm', { timeout: 30_000 }, () => {
  it('shows the §7 demo (110 % of the limit) and lets the owner approve with a reason', async () => {
    let confirms = 0;
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, {
        'POST /sales-orders/:id/confirm': () => {
          confirms += 1;
          return confirms === 1
            ? json(
                {
                  statusCode: 409,
                  code: 'insufficient_stock',
                  message: 'Not enough stock',
                  lines: [
                    {
                      lineId: 'ol-1',
                      lineNo: 1,
                      storeId: AMP.id,
                      wantedQuantity: 2,
                      availableQuantity: 1,
                    },
                  ],
                },
                409,
              )
            : confirms === 2
              ? json({ statusCode: 409, code: 'credit_blocked', message: 'Credit is on hold' }, 409)
              : json({ ...ORDER, status: 'confirmed' });
        },
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Sales order SO-000017', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'From quotation QT-000042' })).toHaveAttribute(
      'href',
      '/quotations/quote-2',
    );
    await waitFor(() => {
      expect(credit()).toHaveTextContent(
        'CreditActiveLimit₹30,000.00Owed now₹18,000.00This order₹15,000.00Against the limit110%',
      );
    });
    expect(credit()).toHaveTextContent('Over the credit limit: the owner approves it.');
    expect(credit()).toHaveTextContent('You can approve it when you confirm.');
    expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent(
      'Payment termsOn credit',
    );

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm SO-000017' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve and confirm' }));
    expect(within(dialog).getByText('Give a reason of at least 3 characters')).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why you approve \(Owner approval\)/ }),
      ' Pays every month ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Approve and confirm' }));
    expect(
      await within(dialog).findByText('Not enough stock to hold. Line 1: 1 of 2 available.'),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Approve and confirm' }));
    expect(await within(dialog).findByText('Credit is on hold')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Approve and confirm' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const posts = requests.filter((request) => request.path.endsWith('/confirm'));
    expect(posts.at(-1)?.body).toEqual({ creditOverride: { reason: 'Pays every month' } });
    expect(new Set(posts.map((request) => request.headers['Idempotency-Key'])).size).toBe(1);
  });

  it('lets a manager ask the owner for approval when over the limit', async () => {
    let overview = OVERVIEW;
    let fail = true;
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, {
        'GET /auth/me': () => json(BRANCH_MANAGER),
        'GET /parties/:id/overview': () => json(overview),
        'POST /credit-requests': () => {
          if (fail) {
            fail = false;
            return json({ message: 'Try later' }, 500);
          }
          overview = {
            ...OVERVIEW,
            credit: {
              ...CREDIT,
              pendingRequest: {
                id: 'cr-1',
                number: 'CR-000001',
                limitPaise: 33_000_00,
                creditDays: 30,
              },
            },
          };
          return json({ id: 'cr-1' }, 201);
        },
      }),
    });
    expect(
      await screen.findByText('Ask an owner to confirm this order, or to raise the limit.'),
    ).toBeVisible();
    const ask = await screen.findByRole('button', {
      name: 'Request owner approval (limit ₹33,000.00)',
    });
    await user.click(ask);
    expect(await screen.findByText('Try later')).toBeVisible();
    await user.click(ask);
    expect(await screen.findByText('Request sent to the owner')).toBeVisible();
    expect(
      await screen.findByRole('link', {
        name: 'Credit request CR-000001 is waiting for the owner',
      }),
    ).toHaveAttribute('href', '/credit-requests/cr-1');
    expect(requests.find((request) => request.path === '/credit-requests')?.body).toEqual({
      partyId: PARTY.id,
      limitPaise: 33_000_00,
      creditDays: 30,
      note: 'For sales order SO-000017',
    });
    // Without the owner's approval the confirm cannot pass the credit rules.
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm SO-000017' });
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Confirm order' })).toBeVisible();
  });

  it('shows a manager approval to whoever may give it, and asks others to find a manager', async () => {
    const first = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, {
        'GET /auth/me': () => json(BRANCH_MANAGER),
        'GET /sales-orders/:id/credit-check': () => json(NEEDS_MANAGER),
      }),
    });
    expect(
      await screen.findByText('Above the usual share of the limit: a manager approves it.'),
    ).toBeVisible();
    expect(screen.getByText('You can approve it when you confirm.')).toBeVisible();
    first.unmount();
    renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, {
        'GET /auth/me': () => json(SALES),
        'GET /sales-orders/:id/credit-check': () => json(NEEDS_MANAGER),
      }),
    });
    expect(await screen.findByText('Ask a manager to confirm this order.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Request owner approval/ })).toBeNull();
  });

  it('asks the owner without a request button for a member who cannot raise one', async () => {
    renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, { 'GET /auth/me': () => json(SALES) }),
    });
    expect(
      await screen.findByText('Ask an owner to confirm this order, or to raise the limit.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Request owner approval/ })).toBeNull();
  });

  it('confirms within the limit without a reason, and explains a manual figure', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, {
        'GET /sales-orders/:id/credit-check': () => json(WITHIN_LIMIT),
        'POST /sales-orders/:id/confirm': () => json({ ...ORDER, status: 'confirmed' }),
      }),
    });
    expect(
      await screen.findByText('Within the credit limit: the order can be confirmed.'),
    ).toBeVisible();
    expect(credit()).toHaveTextContent('Against the limit66.67%Days overdue3');
    expect(
      screen.getByText('Owed is the figure entered by hand until billing goes live.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm SO-000017' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm order' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(requests.find((request) => request.path.endsWith('/confirm'))?.body).toEqual({});
  });

  it('cannot confirm for a blocked customer', async () => {
    const first = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, { 'GET /sales-orders/:id/credit-check': () => json(BLOCKED) }),
    });
    expect(await screen.findByText('Credit is blocked: Credit is on hold.')).toBeVisible();
    expect(credit()).toHaveTextContent('Against the limit—');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    first.unmount();
    renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, {
        'GET /sales-orders/:id/credit-check': () => json({ ...BLOCKED, check: null }),
      }),
    });
    expect(await screen.findByText('Credit is blocked for this customer.')).toBeVisible();
  });

  it('confirms a prepaid order with no credit panel, and says when the check fails', async () => {
    const first = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes({
        ...ORDER,
        paymentTerms: 'prepaid',
        quotationId: null,
        quotationNumber: null,
      }),
    });
    expect(await screen.findByText('Taken without a quotation')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Credit' })).toBeNull();
    first.unmount();
    renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(ORDER, {
        'GET /sales-orders/:id/credit-check': () => json({ message: 'Down' }, 500),
      }),
    });
    expect(await screen.findByText('Could not check the credit')).toBeVisible();
  });
});

describe('OrderPage: an open order', { timeout: 30_000 }, () => {
  it('shows the credit as it stood, the lines, stock and invoices', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(
        {
          ...CONFIRMED,
          lines: CONFIRMED.lines.map((line, index) =>
            index === 0 ? { ...line, tint: LINE_TINT } : line,
          ),
        },
        {
          'POST /sales-orders/:id/reserve': () => json(CONFIRMED),
          'POST /sales-orders/:id/release': () => json({ message: 'Nothing held' }, 409),
        },
      ),
    });
    expect(await screen.findByText('At confirm: Owner approval, 110% of the limit.')).toBeVisible();
    expect(credit()).toHaveTextContent(
      'Owner approval by Anil Kumar on 8 Oct 2026, 11:30 am: Pays every month',
    );
    const lines = screen.getByRole('table', { name: 'Lines' });
    const [, paint, hinge] = within(lines).getAllByRole('row');
    await screen.findAllByText('AMP · Ameerpet');
    expect(paint).toHaveTextContent(
      'Asian Paints Apex Ultima 20 lAPX-20L' +
        'Tint X 132 · Ivory Mist · Base Asian Paints Apex Ultima 20 l · Formula XY 12 ml' +
        'AMP · Ameerpet22000₹9,000.00',
    );
    expect(hinge).toHaveTextContent('Godrej Hinge 4 inchHNG-4KPH · Kukatpally104155₹6,000.00');
    expect(within(found(paint)).queryByRole('button')).toBeNull();

    const stock = screen.getByRole('region', { name: 'Stock for this order' });
    await waitFor(() => {
      expect(stock).toHaveTextContent(
        'Ameerpet (this line’s store): 1 free (1 on hand, 0 held)Kukatpally: 4 free (6 on hand, 2 held)',
      );
    });
    // A line the order no longer knows shows by its SKU.
    expect(within(stock).getAllByRole('row')[2]).toHaveTextContent('HNG-4HNG-400');
    await user.selectOptions(
      within(stock).getByRole('combobox', { name: 'Store for Asian Paints Apex Ultima 20 l' }),
      'From Kukatpally',
    );
    expect(await screen.findByText('Line moved and held there')).toBeVisible();
    expect(requests.find((request) => request.path.endsWith('/reserve'))?.body).toEqual({
      lines: [{ lineId: 'ol-1', fulfilStoreId: STORE_KPH }],
    });
    await user.click(within(stock).getByRole('button', { name: 'Hold open stock' }));
    expect(await screen.findByText('Stock held')).toBeVisible();
    await user.click(within(stock).getByRole('button', { name: 'Give back held stock' }));
    expect(await screen.findByText('Nothing held')).toBeVisible();

    const invoices = screen.getByRole('region', { name: 'Invoices' });
    expect(within(invoices).getByRole('link', { name: 'AMP/26-27/000001' })).toHaveAttribute(
      'href',
      '/invoices/invoice-1',
    );
    expect(invoices).toHaveTextContent('8 Oct 2026 · ₹9,000.00Issued');
    expect(invoices).toHaveTextContent('Draft₹2,400.00Draft');
  });

  it('bills part of what is open and issues it, retrying a failed issue on the same draft', async () => {
    let issues = 0;
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(CONFIRMED, {
        'POST /sales-orders/:id/invoices': () =>
          json({ ...INVOICE, id: 'invoice-3', status: 'draft' }, 201),
        'POST /invoices/:id/issue': () => {
          issues += 1;
          return issues === 1 ? json({ message: 'Register closed' }, 409) : json(INVOICE);
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Bill' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bill SO-000017' });
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    const quantity = within(dialog).getByRole('textbox', { name: /^Godrej Hinge 4 inch/ });
    expect(quantity).toHaveValue('5');
    await user.clear(quantity);
    await user.type(quantity, '9');
    await user.click(within(dialog).getByRole('button', { name: 'Bill and issue' }));
    expect(within(dialog).getByText('Check the quantity of Godrej Hinge 4 inch')).toBeVisible();
    await user.clear(quantity);
    await user.click(within(dialog).getByRole('button', { name: 'Bill and issue' }));
    expect(within(dialog).getByText('Enter at least one quantity to bill')).toBeVisible();
    await user.type(quantity, '3');
    await user.click(within(dialog).getByRole('button', { name: 'Bill and issue' }));
    expect(await within(dialog).findByText('Register closed')).toBeVisible();
    expect(quantity).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Bill and issue' }));
    await waitFor(() => {
      expect(location()).toBe('/invoices/invoice-3');
    });
    // The order and its dialog are gone: the focus lands on the invoice's heading.
    const invoiceHeading = await screen.findByRole('heading', {
      level: 1,
      name: 'Invoice AMP/26-27/000001',
    });
    await waitFor(() => {
      expect(invoiceHeading).toHaveFocus();
    });
    const bills = requests.filter(
      (request) => request.path.endsWith('/invoices') && request.method === 'POST',
    );
    expect(bills).toHaveLength(1);
    expect(bills[0]?.body).toEqual({
      storeId: STORE_KPH,
      lines: [{ orderLineId: 'ol-2', quantity: 3 }],
    });
    const issued = requests.filter((request) => request.path.endsWith('/issue'));
    expect(issued.map((request) => request.body)).toEqual([{}, {}]);
    expect(issued[0]?.path).toBe('/invoices/invoice-3/issue');
  });

  it('bills from a chosen store of a prepaid order, using the advances', async () => {
    const order: SalesOrderView = { ...ORDER, status: 'confirmed', paymentTerms: 'prepaid' };
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(order, {
        'GET /stores': () => json([AMP]),
        'POST /sales-orders/:id/invoices': () => json({ ...INVOICE, id: 'invoice-4' }, 201),
        'POST /invoices/:id/issue': () => json(INVOICE),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Bill' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bill SO-000017' });
    expect(within(dialog).getByText('The customer’s advances are used first.')).toBeVisible();
    const from = within(dialog).getByRole('combobox', { name: 'Billing store' });
    expect(
      within(from)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Ameerpet', 'Store']);
    await user.selectOptions(from, STORE_KPH);
    await user.type(within(dialog).getByRole('textbox', { name: /^Godrej Hinge/ }), '0');
    await user.clear(within(dialog).getByRole('textbox', { name: /^Godrej Hinge/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /^Godrej Hinge/ }), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Bill and issue' }));
    expect(within(dialog).getByText('Enter at least one quantity to bill')).toBeVisible();
    await user.clear(within(dialog).getByRole('textbox', { name: /^Godrej Hinge/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /^Godrej Hinge/ }), '10');
    await user.click(within(dialog).getByRole('button', { name: 'Bill and issue' }));
    await waitFor(() => {
      expect(location()).toBe('/invoices/invoice-4');
    });
    expect(requests.find((request) => request.path.endsWith('/issue'))?.body).toEqual({
      allocateAdvances: true,
    });
  });

  it('issues a draft left by a failed issue', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(
        { ...CONFIRMED, paymentTerms: 'partial', advanceRequiredPaise: 4_500_00 },
        { 'POST /invoices/:id/issue': () => json(INVOICE) },
      ),
    });
    expect(await screen.findByText('Advance needed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the invoice' });
    expect(await within(dialog).findByText('Total ₹1,354.00')).toBeVisible();
    expect(within(dialog).getByText('The customer’s advances are used first.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Issue' }));
    await waitFor(() => {
      expect(location()).toBe('/invoices/invoice-2');
    });
    expect(requests.find((request) => request.path === '/invoices/invoice-2/issue')?.body).toEqual({
      allocateAdvances: true,
    });
  });

  it('issues a postpaid draft without advances', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(CONFIRMED, { 'POST /invoices/:id/issue': () => json(INVOICE) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the invoice' });
    await user.click(within(dialog).getByRole('button', { name: 'Issue' }));
    await waitFor(() => {
      expect(location()).toBe('/invoices/invoice-2');
    });
    expect(requests.find((request) => request.path.endsWith('/issue'))?.body).toEqual({});
  });

  it('cancels part of a line, all of one, and the order', async () => {
    const { user, requests } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(CONFIRMED, {
        'POST /sales-orders/:id/lines/:lineId/cancel': () => json(CONFIRMED),
        'POST /sales-orders/:id/cancel': () => json({ ...CONFIRMED, status: 'closed' }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel Godrej Hinge 4 inch' }));
    let dialog = await screen.findByRole('dialog', { name: 'Cancel Godrej Hinge 4 inch' });
    expect(within(dialog).getByText('5 still open on this line.')).toBeVisible();
    const quantity = within(dialog).getByRole('textbox', { name: 'Quantity to cancel' });
    await user.clear(quantity);
    await user.type(quantity, '6');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel quantity' }));
    expect(
      within(dialog).getByText('Enter a quantity above 0, no more than what is open'),
    ).toBeVisible();
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel quantity' }));
    expect(within(dialog).getByText('Give a reason of at least 3 characters')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Changed his mind');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel quantity' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Cancel Godrej Hinge 4 inch' }));
    dialog = await screen.findByRole('dialog', { name: 'Cancel Godrej Hinge 4 inch' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Not needed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel quantity' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const cancels = requests.filter((request) => request.path.includes('/lines/'));
    expect(cancels.map((request) => request.body)).toEqual([
      { quantity: 2, reason: 'Changed his mind' },
      { reason: 'Not needed' },
    ]);

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    dialog = await screen.findByRole('dialog', { name: 'Cancel SO-000017' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Site postponed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(requests.find((request) => request.path.endsWith('/order-1/cancel'))?.body).toEqual({
      reason: 'Site postponed',
    });
  });

  it('puts the focus on the heading when cancelling takes the order’s buttons away', async () => {
    let current: SalesOrderView = CONFIRMED;
    const { user } = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(CONFIRMED, {
        'GET /sales-orders/:id': () => json(current),
        'POST /sales-orders/:id/cancel': () => {
          current = { ...CONFIRMED, status: 'cancelled', cancelReason: 'Site postponed' };
          return json(current);
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel SO-000017' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Site postponed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Sales order SO-000017' }),
      ).toHaveFocus();
    });
  });

  it('shows a cancelled order read-only, and readers no actions', async () => {
    const first = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes({
        ...ORDER,
        status: 'cancelled',
        cancelReason: 'Site postponed',
        creditCheck: null,
      }),
    });
    expect(await screen.findByText('Not checked.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent(
      'Cancelled becauseSite postponed',
    );
    expect(screen.queryByRole('region', { name: 'Stock for this order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    expect(screen.getByText('Nothing billed yet.')).toBeVisible();
    first.unmount();

    renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(
        {
          ...CONFIRMED,
          storeId: 'store-gone',
          creditOverride: null,
          creditCheck: { ...found(CONFIRMED.creditCheck), utilizationPercent: null },
        },
        { 'GET /auth/me': () => json(READER) },
      ),
    });
    expect(await screen.findByText('At confirm: Owner approval, 0% of the limit.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent('Store—');
    expect(screen.queryByRole('button', { name: 'Bill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hold open stock' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel / })).toBeNull();
  });

  it('says when the order or its stock cannot be loaded', async () => {
    const first = renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(CONFIRMED, {
        'GET /sales-orders/:id/availability': () => json({ message: 'Down' }, 500),
      }),
    });
    expect(await screen.findByText('Could not load the stock')).toBeVisible();
    first.unmount();
    renderApp({
      path: '/sales-orders/order-1',
      routes: orderRoutes(CONFIRMED, {
        'GET /sales-orders/:id': () => json({ message: 'Down' }, 500),
      }),
    });
    expect(await screen.findByText('Could not load the sales order')).toBeVisible();
  });
});
