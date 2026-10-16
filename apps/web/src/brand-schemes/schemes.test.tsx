import type { SchemeSummary } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { CLAIMS, LITRES, MONSOON, schemeDetail } from '../test-support/scheme-fixtures.js';

// Brand schemes (P2-M33): the list with progress, the editor, a scheme's detail with
// what came and the claims, and the claims list.

const BUYER = profile(['stores:read', 'catalog:read', 'purchasing:read'], {
  role: { key: 'inventory_manager', name: 'Inventory Manager' },
  allStores: false,
});

const BRANDS = [
  { id: 'brand-apex', name: 'Apex Paints', isActive: true },
  { id: 'brand-berger', name: 'Berger', isActive: true },
];
const CATEGORIES = [{ id: 'cat-emulsions', name: 'Emulsions', parentId: null, isActive: true }];
const PRODUCTS = {
  items: [
    {
      id: 'p-ultima',
      name: 'Ultima',
      brand: { id: 'brand-apex', name: 'Apex Paints' },
      category: null,
      variants: [
        { id: 'v-ult-10', sku: 'ULT-10L', packSize: 10, unit: 'l', label: null },
        { id: 'v-ult-20', sku: 'ULT-20L', packSize: 20, unit: 'l', label: null },
      ],
    },
  ],
  total: 1,
};

const summary = (detail: ReturnType<typeof schemeDetail>): SchemeSummary => ({
  scheme: detail.scheme,
  progress: detail.progress,
  claim: detail.claim,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SchemesPage', { timeout: 30_000 }, () => {
  it('shows each scheme’s progress to its next slab, filters by status and downloads the CSV', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:csv'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    let csvAnswers = 0;
    const { user, requests } = renderApp({
      path: '/brand-schemes',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-schemes': () =>
          json([
            summary(schemeDetail(MONSOON, '2026-08-15')),
            summary(schemeDetail(LITRES, '2026-08-15', [], [], [])),
            summary(
              schemeDetail(
                { ...LITRES, id: 'scheme-done', name: 'Litres done', products: [] },
                '2026-08-15',
              ),
            ),
          ]),
        'GET /reports/brand-schemes': () => {
          csvAnswers += 1;
          return csvAnswers === 1
            ? { status: 200, raw: 'Brand\r\n' }
            : json({ statusCode: 403, message: 'No' }, 403);
        },
      },
    });
    const list = await screen.findByRole('list', { name: 'Brand schemes' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards[0]).toHaveTextContent('Apex Paints · Monsoon slabRunning');
    expect(cards[0]).toHaveTextContent('₹44,000.00 to slab 2, ₹956.53 a day needed');
    expect(cards[0]).toHaveTextContent('Bought ₹56,000.00Earned ₹560.00Still owed ₹260.00');
    expect(
      within(found(cards[0])).getByRole('progressbar', {
        name: '₹56,000.00 of ₹1,00,000.00',
      }),
    ).toHaveAttribute('aria-valuenow', '56');
    expect(cards[1]).toHaveTextContent('Berger · Litres clubDraft');
    expect(cards[1]).toHaveTextContent('100 L to slab 1, 2.17 L a day needed');
    expect(cards[2]).toHaveTextContent('Top slab reached');
    expect(
      within(found(cards[2])).getByRole('progressbar', { name: '260 L of 260 L' }),
    ).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('link', { name: 'New scheme' })).toHaveAttribute(
      'href',
      '/brand-schemes/new',
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'active');
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe('status=active');
    });
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => {
      expect(names).toEqual(['brand-schemes.csv']);
    });
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('Could not download the CSV')).toBeVisible();
  });

  it('says when there is no scheme, and offers no new one to a buyer', async () => {
    renderApp({
      path: '/brand-schemes',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-schemes': () => json([]),
      },
    });
    expect(await screen.findByText('No brand scheme yet.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'New scheme' })).toBeNull();
    // The purchasing section links to the schemes, their claims and the planner.
    const sections = screen.getByRole('navigation', { name: 'Purchasing sections' });
    expect(within(sections).getByRole('link', { name: 'Price-hike planner' })).toHaveAttribute(
      'href',
      '/brand-schemes/price-hike',
    );
  });
});

describe('the scheme editor', { timeout: 60_000 }, () => {
  it('enters a scheme with slabs of every benefit, checking the fields first', async () => {
    const saved: unknown[] = [];
    const { user } = renderApp({
      path: '/brand-schemes/new',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brands': () => json(BRANDS),
        'GET /categories': () => json(CATEGORIES),
        'GET /products': () => json(PRODUCTS),
        'POST /brand-schemes': (request) => {
          saved.push(request.body);
          return saved.length === 1
            ? json(
                { statusCode: 409, message: 'This brand already has a scheme named Monsoon' },
                409,
              )
            : json(MONSOON, 201);
        },
        'GET /brand-schemes/:id': () => json(schemeDetail(MONSOON, '2026-08-15')),
      },
    });
    await screen.findByRole('heading', { name: 'New brand scheme' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Choose the brand')).toBeVisible();

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Apex Paints' })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Brand' }), 'brand-apex');
    await user.type(screen.getByRole('textbox', { name: 'Scheme name' }), 'Monsoon');
    await user.type(screen.getByRole('textbox', { name: 'Brand’s reference (optional)' }), 'APX/1');
    await user.type(screen.getByLabelText('From'), '2026-07-01');
    await user.type(screen.getByLabelText('To'), '2026-09-30');
    await user.type(screen.getByRole('textbox', { name: 'Brand settles within (days)' }), '30');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Count purchases by' }),
      'invoice_date',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Slabs pay' }), 'retro');
    await user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), 'Circular');
    await user.click(await screen.findByRole('checkbox', { name: 'Apex Paints Ultima' }));
    await user.click(screen.getByRole('checkbox', { name: 'Emulsions' }));
    await user.click(screen.getByRole('checkbox', { name: 'Emulsions' }));

    await user.type(screen.getByRole('textbox', { name: 'Slab 1 target (₹)' }), '50000');
    await user.type(screen.getByRole('textbox', { name: 'Slab 1 benefit 1: rebate (%)' }), '1');
    await user.click(screen.getByRole('button', { name: 'Add a benefit to slab 1' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Slab 1 benefit 2' }), 'points');
    await user.type(screen.getByRole('textbox', { name: 'Slab 1 benefit 2: gift or trip' }), 'Goa');
    const points = screen.getByRole('textbox', { name: 'Slab 1 benefit 2: points' });
    await user.clear(points);
    await user.type(points, '2');

    await user.click(screen.getByRole('button', { name: 'Add slab' }));
    await user.type(screen.getByRole('textbox', { name: 'Slab 2 target (₹)' }), '100000');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Slab 2 benefit 1' }),
      'per_litre',
    );
    await user.type(screen.getByRole('textbox', { name: 'Slab 2 benefit 1: ₹ a litre' }), '2');
    await user.click(screen.getByRole('button', { name: 'Add a benefit to slab 2' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Slab 2 benefit 2' }),
      'free_goods',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Slab 2 benefit 2: free pack' }),
      'v-ult-10',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Slab 2 benefit 2: for every (litres)' }),
      '100',
    );
    const units = screen.getByRole('textbox', { name: 'Slab 2 benefit 2: units' });
    await user.clear(units);
    await user.type(units, '1');
    // A third slab and an extra benefit, both removed again.
    await user.click(screen.getByRole('button', { name: 'Add a benefit to slab 2' }));
    await user.click(screen.getByRole('button', { name: 'Remove benefit 3 of slab 2' }));
    await user.click(screen.getByRole('button', { name: 'Add slab' }));
    await user.click(screen.getByRole('button', { name: 'Remove slab 3' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Targets in' }), 'litres');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Targets in' }), 'value');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This brand already has a scheme named Monsoon')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Scheme saved')).toBeVisible();
    expect(saved[1]).toEqual({
      brandId: 'brand-apex',
      name: 'Monsoon',
      brandReference: 'APX/1',
      startsOn: '2026-07-01',
      endsOn: '2026-09-30',
      measure: 'value',
      mode: 'retro',
      settlementDays: 30,
      dateBasis: 'invoice_date',
      note: 'Circular',
      productIds: ['p-ultima'],
      categoryIds: [],
      slabs: [
        {
          target: 50_000_00,
          benefits: [
            { kind: 'rebate', basisPoints: 100 },
            { kind: 'points', label: 'Goa', points: 2 },
          ],
        },
        {
          target: 1_00_000_00,
          benefits: [
            { kind: 'per_litre', paisePerLitre: 200 },
            { kind: 'free_goods', variantId: 'v-ult-10', units: 1, perMillilitres: 100_000 },
          ],
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/brand-schemes/scheme-monsoon');
    });
  });

  it('changes a scheme from its stored fields, keeping its brand', async () => {
    const saved: unknown[] = [];
    const { user } = renderApp({
      path: '/brand-schemes/scheme-litres/edit',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brands': () => json(BRANDS),
        'GET /categories': () => json(CATEGORIES),
        'GET /products': () => json({ items: [], total: 0 }),
        'GET /brand-schemes/:id': () => json(schemeDetail(LITRES, '2026-08-15', [], [], [])),
        'PUT /brand-schemes/:id': (request) => {
          saved.push(request.body);
          return json(LITRES);
        },
      },
    });
    const target = await screen.findByRole('textbox', { name: 'Slab 1 target (litres)' });
    expect(target).toHaveValue('100');
    expect(screen.getByRole('combobox', { name: 'Brand' })).toBeDisabled();
    await user.clear(target);
    await user.type(target, '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Scheme saved')).toBeVisible();
    expect(saved).toEqual([
      expect.objectContaining({
        brandId: 'brand-berger',
        measure: 'litres',
        mode: 'incremental',
        productIds: ['p-silk'],
        slabs: [{ target: 150_000, benefits: [{ kind: 'per_litre', paisePerLitre: 500 }] }],
      }),
    ]);
  });
});

describe('SchemeDetailPage', { timeout: 60_000 }, () => {
  it('shows the progress, slabs, expected against received, what came, claims and GRNs', async () => {
    renderApp({
      path: '/brand-schemes/scheme-monsoon',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-schemes/:id': () => json(schemeDetail(MONSOON, '2026-08-15')),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Apex Paints · Monsoon slab' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        '1 Jul 2026 to 30 Sept 2026 · Rupees (purchase value) · On the whole volume · GRN date · APX/Q2/26',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Record what came' })).toBeNull();
    expect(screen.getByText('Running')).toBeVisible();

    const slabs = screen.getByRole('table', { name: 'Slabs' });
    expect(
      within(slabs)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'SlabTargetGivesReached',
      '1₹50,000.001% rebate · 1 points: Goa tripYes',
      '2₹1,00,000.00₹2.00 a litre · 1 unit of Apex Paints Ultima 10 l free for every 100 L · 2 units of Apex Paints Ultima 20 l freeNo',
    ]);
    expect(screen.getByText('260 L, of which 20 L free')).toBeVisible();
    expect(screen.getByText('₹1,12,000.00 · slab 2')).toBeVisible();
    expect(
      screen.getByText('The period is running: what is expected still moves with purchases.'),
    ).toBeVisible();

    const benefits = screen.getByRole('table', { name: 'Benefits expected and received' });
    expect(
      within(benefits)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'BenefitExpectedReceivedOutstanding',
      'Credit notes and payments₹560.00₹300.00₹260.00',
      'Apex Paints Primer 1 l01-1',
      'Apex Paints Ultima 10 l01-1',
      'Goa trip110',
    ]);
    const receipts = screen.getByRole('table', { name: 'What the brand issued' });
    expect(
      within(receipts)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'DateWhatReferenceRecorded by',
      '12 Aug 2026₹400.00 · Credit noteCN-881Suma Owner',
      '12 Aug 2026-₹100.00 · Payment · Brand reduced itSC-000001Suma Owner',
      '12 Aug 20261 × Apex Paints Ultima 10 l—Suma Owner',
      '12 Aug 20261 · Goa tripCN-881Suma Owner',
      '12 Aug 20261 × Apex Paints Primer 1 l—Suma Owner',
    ]);
    const claims = screen.getByRole('table', { name: 'Claims filed with the brand' });
    expect(within(claims).getAllByRole('row')[1]).toHaveTextContent(
      'SC-000001 · APX-CLM-7714 Aug 2026₹300.00Filed',
    );
    const grns = screen.getByRole('table', { name: 'GRNs counted' });
    expect(
      within(grns)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'GRNCounted onPackQuantityValueLitres',
      'GRN-000001 · HYD10 Jul 2026Apex Paints Ultima ULT-20L10 + 1 free₹40,000.00220 L',
      'GRN-000003 · SEC5 Aug 2026Apex Paints Ultima ULT-10L6₹20,000.0060 L',
      'Returned: Damaged tins · HYD6 Aug 2026Apex Paints Ultima ULT-20L-1-₹4,000.00-20 L',
    ]);
  });

  it('shows a finished scheme with nothing counted, nothing received and no claims', async () => {
    const closed = {
      ...LITRES,
      status: 'closed' as const,
      endNote: 'Brand paid',
      endedAt: '2026-11-01T00:00:00Z',
    };
    renderApp({
      path: '/brand-schemes/scheme-litres',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /products': () => json(PRODUCTS),
        'GET /brand-schemes/:id': () => json(schemeDetail(closed, '2026-12-01', [], [], [])),
      },
    });
    expect(await screen.findByText('100 L short of slab 1')).toBeVisible();
    expect(screen.getByText('None yet')).toBeVisible();
    expect(screen.getByText('Brand paid', { exact: false })).toBeVisible();
    expect(screen.getByText('Nothing recorded from the brand yet.')).toBeVisible();
    expect(screen.getByText('No claim filed yet.')).toBeVisible();
    expect(screen.getByText('No purchase of the brand counts yet.')).toBeVisible();
    // Closed: what came can still be recorded; it can no longer be edited or cancelled.
    expect(screen.getByRole('button', { name: 'Record what came' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel scheme' })).toBeNull();
  });

  it('says when the brand gave more than the slabs earned', async () => {
    renderApp({
      path: '/brand-schemes/scheme-monsoon',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-schemes/:id': () =>
          json(
            schemeDetail(MONSOON, '2026-08-15', undefined, [
              {
                id: 'rc-9',
                kind: 'money',
                receivedOn: '2026-08-12',
                amountPaise: 1_000_00,
                moneyForm: 'credit_note',
                variant: null,
                units: null,
                goodsReceipt: null,
                label: null,
                points: null,
                reference: 'CN-9',
                note: null,
                claim: null,
                recordedBy: 'Suma Owner',
                createdAt: '2026-08-12T05:00:00.000Z',
              },
              {
                id: 'rc-10',
                kind: 'points',
                receivedOn: '2026-08-12',
                amountPaise: null,
                moneyForm: null,
                variant: null,
                units: null,
                goodsReceipt: null,
                label: 'Goa trip',
                points: 1,
                reference: null,
                note: null,
                claim: null,
                recordedBy: 'Suma Owner',
                createdAt: '2026-08-12T05:00:00.000Z',
              },
            ]),
          ),
      },
    });
    expect(await screen.findByText('Paid more')).toBeVisible();
  });

  it('activates a draft, and says when it cannot', async () => {
    let calls = 0;
    const { user } = renderApp({
      path: '/brand-schemes/scheme-litres',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /products': () => json(PRODUCTS),
        'GET /brand-schemes/:id': () => json(schemeDetail(LITRES, '2026-08-15', [], [], [])),
        'POST /brand-schemes/:id/activate': () => {
          calls += 1;
          return calls === 1
            ? json({ ...LITRES, status: 'active' })
            : json({ statusCode: 409, message: 'Only a draft can be activated' }, 409);
        },
      },
    });
    const activate = await screen.findByRole('button', { name: 'Activate' });
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/brand-schemes/scheme-litres/edit',
    );
    await user.click(activate);
    expect(await screen.findByText('The scheme now counts')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Only a draft can be activated')).toBeVisible();
  });

  it('records a credit note, free goods and points, checking each', async () => {
    const recorded: { body: unknown; key: string | undefined }[] = [];
    const { user } = renderApp({
      path: '/brand-schemes/scheme-monsoon',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /products': () => json(PRODUCTS),
        'GET /brand-schemes/:id': () => json(schemeDetail(MONSOON, '2026-08-15')),
        'POST /brand-schemes/:id/receipts': (request) => {
          recorded.push({ body: request.body, key: request.headers['Idempotency-Key'] });
          return json({}, 201);
        },
      },
    });
    const open = async () => {
      await user.click(await screen.findByRole('button', { name: 'Record what came' }));
      return screen.getByRole('dialog', { name: 'Record what came' });
    };
    let dialog = await open();
    const date = within(dialog).getByLabelText('Received on');
    await user.clear(date);
    await user.type(date, '2026-08-20');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(within(dialog).getByText('Enter the amount in rupees')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount (₹)' }), '-150');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'As' }), 'payment');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Brand’s reference (credit note or letter)' }),
      'NEFT-1',
    );
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Against claim' }),
      'claim-1',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), 'Short');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('Recorded')).toBeVisible();

    dialog = await open();
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'What came' }),
      'free_goods',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(within(dialog).getByText('Choose the free pack')).toBeVisible();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Pack' }), 'v-ult-10');
    const units = within(dialog).getByRole('textbox', { name: 'Units' });
    await user.clear(units);
    await user.type(units, '0');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(within(dialog).getByText('Enter the units as a whole number')).toBeVisible();
    await user.clear(units);
    await user.type(units, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(recorded).toHaveLength(2);
    });

    dialog = await open();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'What came' }), 'points');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(within(dialog).getByText('Say what the points are for')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: 'Gift or trip' }), 'Goa trip');
    const points = within(dialog).getByRole('textbox', { name: 'Points' });
    await user.clear(points);
    await user.type(points, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(within(dialog).getByText('Enter the points as a whole number')).toBeVisible();
    await user.clear(points);
    await user.type(points, '1');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(recorded).toHaveLength(3);
    });

    dialog = await open();
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount (₹)' }), '200');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(recorded).toHaveLength(4);
    });
    expect(recorded.map((entry) => entry.body)).toEqual([
      {
        kind: 'money',
        amountPaise: -150_00,
        moneyForm: 'payment',
        receivedOn: '2026-08-20',
        reference: 'NEFT-1',
        note: 'Short',
        claimId: 'claim-1',
      },
      expect.objectContaining({
        kind: 'free_goods',
        variantId: 'v-ult-10',
        units: 2,
        goodsReceiptId: null,
        reference: null,
        claimId: null,
      }),
      expect.objectContaining({ kind: 'points', label: 'Goa trip', points: 1 }),
      expect.objectContaining({ kind: 'money', amountPaise: 200_00, moneyForm: 'credit_note' }),
    ]);
    expect(recorded.every((entry) => typeof entry.key === 'string')).toBe(true);
  });

  it('files a claim, follows it up, and closes or cancels the scheme', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const record = (request: { path: string; body: unknown }) => {
      calls.push({ path: request.path, body: request.body });
      return json({});
    };
    const { user } = renderApp({
      path: '/brand-schemes/scheme-monsoon',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /products': () => json(PRODUCTS),
        'GET /brand-schemes/:id': () => json(schemeDetail(MONSOON, '2026-08-15')),
        'POST /brand-schemes/:id/claims': record,
        'POST /brand-schemes/claims/:claimId/status': record,
        'POST /brand-schemes/:id/close': record,
        'POST /brand-schemes/:id/cancel': record,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'File a claim' }));
    let dialog = screen.getByRole('dialog', { name: 'File a claim' });
    expect(within(dialog).getByText('Left empty: what is still owed, ₹260.00')).toBeVisible();
    const amount = within(dialog).getByRole('textbox', { name: 'Amount claimed (₹, optional)' });
    await user.type(amount, 'lots');
    await user.click(within(dialog).getByRole('button', { name: 'File' }));
    expect(within(dialog).getByText('Enter the amount in rupees, or leave it empty')).toBeVisible();
    await user.clear(amount);
    await user.type(amount, '260');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Brand’s claim number (optional)' }),
      'APX-9',
    );
    await user.click(within(dialog).getByRole('button', { name: 'File' }));
    expect(await screen.findByText('Claim filed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'File a claim' }));
    dialog = screen.getByRole('dialog', { name: 'File a claim' });
    await user.click(within(dialog).getByRole('button', { name: 'File' }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });

    // Only open claims can be followed up.
    expect(screen.queryByRole('button', { name: 'Follow up claim SC-000000' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Follow up claim SC-000002' }));
    dialog = screen.getByRole('dialog', { name: 'Follow up claim SC-000002' });
    expect(
      within(dialog).getByRole('textbox', { name: 'Brand’s claim number (optional)' }),
    ).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Follow up claim SC-000001' }));
    dialog = screen.getByRole('dialog', { name: 'Follow up claim SC-000001' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Now' }), 'settled');
    const reference = within(dialog).getByRole('textbox', {
      name: 'Brand’s claim number (optional)',
    });
    expect(reference).toHaveValue('APX-CLM-77');
    await user.clear(reference);
    await user.type(reference, 'APX-CLM-77');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), 'Paid');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Claim updated')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Close scheme' }));
    dialog = screen.getByRole('dialog', { name: 'Close the scheme' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Why (optional)' }), 'Done');
    await user.click(within(dialog).getByRole('button', { name: 'Close scheme' }));
    expect(await screen.findByText('Scheme updated')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel scheme' }));
    dialog = screen.getByRole('dialog', { name: 'Cancel the scheme' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel scheme' }));
    await waitFor(() => {
      expect(calls).toHaveLength(5);
    });

    expect(calls).toEqual([
      {
        path: '/brand-schemes/scheme-monsoon/claims',
        body: expect.objectContaining({
          claimedPaise: 260_00,
          brandReference: 'APX-9',
          note: null,
        }),
      },
      {
        path: '/brand-schemes/scheme-monsoon/claims',
        body: expect.not.objectContaining({ claimedPaise: expect.anything() }),
      },
      {
        path: '/brand-schemes/claims/claim-1/status',
        body: { status: 'settled', brandReference: 'APX-CLM-77', note: 'Paid' },
      },
      { path: '/brand-schemes/scheme-monsoon/close', body: { note: 'Done' } },
      { path: '/brand-schemes/scheme-monsoon/cancel', body: { note: null } },
    ]);
  });
});

describe('SchemeClaimsPage', { timeout: 30_000 }, () => {
  it('lists open claims by age and each scheme’s expected against received', async () => {
    const monsoon = schemeDetail(MONSOON, '2026-12-01');
    const litres = schemeDetail({ ...LITRES, status: 'closed' }, '2026-12-01', [], [], []);
    renderApp({
      path: '/brand-schemes/claims',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-schemes/claims': () =>
          json({
            asOf: '2026-12-01',
            ageing: [
              { bucket: 'not_due', claims: 0, outstandingPaise: 0 },
              { bucket: 'days_31_60', claims: 1, outstandingPaise: 260_00 },
            ],
            rows: [
              {
                scheme: { ...monsoon.scheme, brand: monsoon.scheme.brand },
                claim: monsoon.claim,
                filed: CLAIMS[0],
              },
              {
                scheme: litres.scheme,
                claim: { ...litres.claim, bucket: 'not_due', daysPastDue: -3 },
                filed: null,
              },
            ],
          }),
      },
    });
    const ageing = await screen.findByRole('table', { name: 'Open claims by age' });
    expect(within(ageing).getAllByRole('row')[2]).toHaveTextContent('31–60 days1₹260.00');
    const rows = within(screen.getByRole('table', { name: 'Schemes' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent(
      'Apex Paints · Monsoon slab30 Oct 2026 31–60 days₹560.00₹300.00₹260.00OwedSC-000001 · Filed',
    );
    expect(rows[2]).toHaveTextContent('Berger · Litres club · Closed');
    expect(rows[2]).toHaveTextContent('Not yet due');
    expect(rows[2]).toHaveTextContent('Settled—');
  });

  it('says when there is nothing to claim', async () => {
    renderApp({
      path: '/brand-schemes/claims',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-schemes/claims': () => json({ asOf: '2026-12-01', ageing: [], rows: [] }),
      },
    });
    expect(await screen.findByText('No running or closed scheme yet.')).toBeVisible();
  });
});
