import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { CASH_SUPPLIER, SUPPLIER, VIEWER, purchasingRoutes } from './test-support/fixtures.js';

const location = () => screen.getByTestId('location').textContent;

describe('SuppliersPage', () => {
  it('lists suppliers with their terms and searches by name', async () => {
    const { user, requests } = renderApp({ path: '/suppliers', routes: purchasingRoutes() });
    const table = await screen.findByRole('table', { name: 'Suppliers' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'NameMobileGSTINPayment termsLead timeProducts',
      'Shah Distributors+91987654321036AABCS1429B1ZB30 days4 days2',
      'Ravi Traders——Cash—0',
    ]);
    expect(screen.getByRole('navigation', { name: 'Purchasing sections' })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: /Search by name/ }), 'shah');
    await waitFor(() => {
      expect(requests.some((request) => request.query.get('q') === 'shah')).toBe(true);
    });
    expect(location()).toBe('/suppliers?q=shah');
  });

  it('pages through many suppliers', async () => {
    const { user } = renderApp({
      path: '/suppliers',
      routes: {
        ...purchasingRoutes(),
        'GET /suppliers': () => json({ items: [SUPPLIER], total: 120 }),
      },
    });
    expect(await screen.findByText('1–50 of 120')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(location()).toBe('/suppliers?offset=50');
  });

  it('says when there are no suppliers, or none match', async () => {
    const empty = { ...purchasingRoutes(), 'GET /suppliers': () => json({ items: [], total: 0 }) };
    renderApp({ path: '/suppliers', routes: empty });
    expect(await screen.findByText('No suppliers yet')).toBeInTheDocument();
    expect(screen.getByText(/Add the distributors/)).toBeInTheDocument();
  });

  it('says when no supplier matches a search', async () => {
    const empty = { ...purchasingRoutes(), 'GET /suppliers': () => json({ items: [], total: 0 }) };
    renderApp({ path: '/suppliers?q=zzz', routes: empty });
    expect(await screen.findByText('No supplier matches this search')).toBeInTheDocument();
  });

  it('hides "+ Supplier" from members who cannot add parties', async () => {
    renderApp({ path: '/suppliers', routes: purchasingRoutes(VIEWER) });
    await screen.findByRole('table', { name: 'Suppliers' });
    expect(screen.queryByRole('button', { name: '+ Supplier' })).toBeNull();
  });

  it('adds a supplier after checking the name and GSTIN, then opens it', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/suppliers',
      routes: {
        ...purchasingRoutes(),
        'POST /parties': (request) => {
          body = request.body;
          return json({ id: 'sup-1' }, 201);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: '+ Supplier' }));
    const dialog = screen.getByRole('dialog', { name: 'New supplier' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'S');
    await user.type(within(dialog).getByRole('textbox', { name: 'GSTIN' }), 'BAD');
    await user.click(within(dialog).getByRole('button', { name: 'Add supplier' }));
    expect(within(dialog).getByText('Enter at least 2 characters')).toBeInTheDocument();
    expect(within(dialog).getByText(/This GSTIN is not valid/)).toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'hah Distributors');
    await user.clear(within(dialog).getByRole('textbox', { name: 'GSTIN' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'GSTIN' }), '27aapfu0939f1zv');
    await user.type(within(dialog).getByRole('textbox', { name: 'Mobile number' }), '9876543210');
    await user.type(within(dialog).getByRole('textbox', { name: 'City' }), 'Pune');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Type' }), 'Person');
    await user.click(within(dialog).getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByText('Supplier added')).toBeInTheDocument();
    expect(body).toEqual({
      kind: 'person',
      displayName: 'Shah Distributors',
      phone: '9876543210',
      gstin: '27AAPFU0939F1ZV',
      city: 'Pune',
      roles: ['supplier'],
    });
    await waitFor(() => {
      expect(location()).toBe('/suppliers/sup-1');
    });
  });

  it('adds a supplier with only a name, and shows a duplicate from the API', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/suppliers',
      routes: {
        ...purchasingRoutes(),
        'POST /parties': (request) => {
          body = request.body;
          return json({ statusCode: 409, message: 'A party with this mobile exists' }, 409);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: '+ Supplier' }));
    const dialog = screen.getByRole('dialog', { name: 'New supplier' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Type' }), 'Business');
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Ravi Traders');
    await user.click(within(dialog).getByRole('button', { name: 'Add supplier' }));
    expect(await within(dialog).findByText('A party with this mobile exists')).toBeInTheDocument();
    expect(body).toEqual({
      kind: 'organization',
      displayName: 'Ravi Traders',
      roles: ['supplier'],
    });
  });
});

describe('SupplierDetailPage', () => {
  it('shows terms and products, and links to a new order', async () => {
    renderApp({ path: '/suppliers/sup-1', routes: purchasingRoutes() });
    expect(await screen.findByRole('heading', { name: 'Shah Distributors' })).toBeInTheDocument();
    const terms = screen.getByRole('region', { name: /^Terms/ });
    expect(terms).toHaveTextContent('Payment terms30 days');
    expect(terms).toHaveTextContent('Lead time4 days');
    const rows = within(screen.getByRole('table', { name: 'Products supplied' })).getAllByRole(
      'row',
    );
    expect(rows[1]).toHaveTextContent(
      'APX-1LAsian Paints Apex Ultima 1 lSH-001₹400.0020 Sept 2026',
    );
    expect(rows[2]).toHaveTextContent('APX-4LAsian Paints Apex Ultima 4 l———');
    expect(screen.getByRole('link', { name: 'New purchase order' })).toHaveAttribute(
      'href',
      '/purchase-orders/new?supplier=sup-1',
    );
  });

  it('shows a cash supplier without products, read-only', async () => {
    renderApp({
      path: '/suppliers/sup-2',
      routes: {
        ...purchasingRoutes(VIEWER),
        'GET /suppliers/:id': () => json({ ...CASH_SUPPLIER, products: [] }),
      },
    });
    expect(await screen.findByText('No products linked yet')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Terms' })).toHaveTextContent('Payment termsCash');
    expect(screen.queryByRole('button', { name: 'Edit terms' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New purchase order' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
  });

  it('says when the supplier cannot be loaded', async () => {
    renderApp({
      path: '/suppliers/nope',
      routes: {
        ...purchasingRoutes(),
        'GET /suppliers/:id': () => json({ statusCode: 404, message: 'Supplier not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load this supplier')).toBeInTheDocument();
  });

  it('edits the terms after checking the days', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/suppliers/sup-1',
      routes: {
        ...purchasingRoutes(),
        'PUT /suppliers/:id/profile': (request) => {
          body = request.body;
          return json({ ...SUPPLIER, paymentTermsDays: 45, leadTimeDays: null });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit terms' }));
    const dialog = screen.getByRole('dialog', { name: 'Payment terms and lead time' });
    const credit = within(dialog).getByRole('textbox', { name: /Days of credit/ });
    const lead = within(dialog).getByRole('textbox', { name: /Lead time/ });
    expect(credit).toHaveValue('30');
    expect(lead).toHaveValue('4');
    await user.clear(credit);
    await user.clear(lead);
    await user.type(lead, '999');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getAllByText('Enter 0 to 365 days')).toHaveLength(2);
    await user.type(credit, '45');
    await user.clear(lead);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Terms saved')).toBeInTheDocument();
    expect(body).toEqual({ paymentTermsDays: 45, leadTimeDays: null });
    expect(screen.getByRole('region', { name: /^Terms/ })).toHaveTextContent('45 days');
  });

  it('opens the terms of a supplier with no lead time', async () => {
    const { user } = renderApp({
      path: '/suppliers/sup-2',
      routes: {
        ...purchasingRoutes(),
        'GET /suppliers/:id': () => json({ ...CASH_SUPPLIER, products: [] }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit terms' }));
    expect(screen.getByRole('textbox', { name: /Lead time/ })).toHaveValue('');
  });

  it("changes or clears a linked product's supplier code", async () => {
    const bodies: unknown[] = [];
    const { user } = renderApp({
      path: '/suppliers/sup-1',
      routes: {
        ...purchasingRoutes(),
        'PUT /suppliers/:id/products': (request) => {
          bodies.push(request.body);
          return json({
            ...SUPPLIER,
            products: [{ ...SUPPLIER.products[0], supplierSku: 'SH-100' }, SUPPLIER.products[1]],
          });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: "Change APX-1L's code" }));
    let dialog = screen.getByRole('dialog', { name: "Supplier's code for APX-1L" });
    const code = within(dialog).getByRole('textbox', { name: "Supplier's code for APX-1L" });
    expect(code).toHaveValue('SH-001');
    await user.clear(code);
    await user.type(code, ' SH-100 ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('SH-100')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: "Change APX-4L's code" }));
    dialog = screen.getByRole('dialog', { name: "Supplier's code for APX-4L" });
    expect(within(dialog).getByRole('textbox')).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(bodies).toEqual([
        { products: [{ variantId: 'v-1l', supplierSku: 'SH-100' }] },
        { products: [{ variantId: 'v-4l', supplierSku: null }] },
      ]);
    });
  });

  it('removes a product, and says when that fails', async () => {
    let fail = false;
    const { user, requests } = renderApp({
      path: '/suppliers/sup-1',
      routes: {
        ...purchasingRoutes(),
        'DELETE /suppliers/:id/products/:variantId': () =>
          fail ? json({ statusCode: 500, message: 'Server down' }, 500) : { status: 204 },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove APX-4L' }));
    expect(await screen.findByText('APX-4L removed')).toBeInTheDocument();
    expect(requests.some((request) => request.path === '/suppliers/sup-1/products/v-4l')).toBe(
      true,
    );
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Remove APX-1L' }));
    expect(await screen.findByText('Server down')).toBeInTheDocument();
  });

  it('links more products with the supplier’s own codes', async () => {
    let body: unknown;
    let fail = true;
    const { user } = renderApp({
      path: '/suppliers/sup-1',
      routes: {
        ...purchasingRoutes(),
        'PUT /suppliers/:id/products': (request) => {
          body = request.body;
          if (fail) return json({ statusCode: 400, message: 'Unknown product variant' }, 400);
          return json({
            ...SUPPLIER,
            products: [
              ...SUPPLIER.products,
              {
                variantId: 'v-te',
                sku: 'TE-10L',
                productName: 'Tractor Emulsion',
                brandName: 'Asian Paints',
                supplierSku: 'X9',
                lastCostPaise: null,
                lastReceivedAt: null,
              },
            ],
          });
        },
      },
    });
    const picker = await screen.findByRole('searchbox', { name: 'Add a product' });
    await user.type(picker, 'tractor');
    await user.click(await screen.findByRole('button', { name: 'Add TE-10L' }));
    expect(screen.queryByRole('button', { name: 'Add TE-10L' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add TE-20L' }));
    await user.type(screen.getByRole('textbox', { name: "Supplier's code for TE-10L" }), ' X9 ');
    await user.click(screen.getByRole('button', { name: 'Remove TE-20L' }));
    await user.click(screen.getByRole('button', { name: 'Save products' }));
    expect(await screen.findByText('Unknown product variant')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Save products' }));
    expect(await screen.findByText('Products saved')).toBeInTheDocument();
    expect(body).toEqual({ products: [{ variantId: 'v-te', supplierSku: 'X9' }] });
    expect(screen.queryByRole('button', { name: 'Save products' })).toBeNull();
    expect(
      within(screen.getByRole('table', { name: 'Products supplied' })).getAllByRole('row'),
    ).toHaveLength(4);
  });

  it('saves a product without a code, or drops it before saving', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/suppliers/sup-1',
      routes: {
        ...purchasingRoutes(),
        'PUT /suppliers/:id/products': (request) => {
          body = request.body;
          return json(SUPPLIER);
        },
      },
    });
    const picker = await screen.findByRole('searchbox', { name: 'Add a product' });
    await user.type(picker, 'tractor');
    await user.click(await screen.findByRole('button', { name: 'Add TE-10L' }));
    await user.click(screen.getByRole('button', { name: 'Remove TE-10L' }));
    expect(screen.queryByRole('button', { name: 'Save products' })).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: 'Add a product' }), 'tractor');
    await user.click(await screen.findByRole('button', { name: 'Add TE-10L' }));
    await user.click(screen.getByRole('button', { name: 'Save products' }));
    await screen.findByText('Products saved');
    expect(body).toEqual({ products: [{ variantId: 'v-te', supplierSku: null }] });
  });

  it('is behind purchasing:read', async () => {
    renderApp({
      path: '/suppliers',
      routes: { ...purchasingRoutes(profile(['stores:read'])) },
    });
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});
