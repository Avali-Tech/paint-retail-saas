import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StockCount } from '../api/stock-counts.js';
import { CASHIER, OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { countLine, stockCount } from '../transfers/test-support/fixtures.js';

function renderCount(shown: StockCount, routes: Record<string, FakeHandler> = {}, member = OWNER) {
  return renderApp({
    path: '/stock-counts/count-1',
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stock-counts/:id': () => json(shown),
      'GET /stock-counts': () => json({ items: [], total: 0 }),
      ...routes,
    },
  });
}

const rows = () =>
  within(screen.getByRole('table', { name: 'Products' }))
    .getAllByRole('row')
    .map((row) => row.textContent);

const posts = (requests: { method: string; path: string; body: unknown }[], path: string) =>
  requests
    .filter((request) => request.method === 'POST' && request.path === path)
    .map((r) => r.body);

const counted = (count: number) =>
  stockCount({
    lines: [
      countLine({
        countedQuantity: count,
        variance: count - 12,
        varianceValuePaise: (count - 12) * 40_000,
      }),
      countLine({ variantId: 'variant-4l', sku: 'APX-4L', expectedQuantity: 3 }),
    ],
  });

describe('StockCountDetailPage', () => {
  it('counts by scanning: each scan adds one and the box stays ready', async () => {
    let scans = 0;
    const { user, requests } = renderCount(stockCount(), {
      'POST /stock-counts/:id/counts': () => {
        scans += 1;
        if (scans === 2)
          return json({ statusCode: 400, message: 'XYZ is not part of this count' }, 400);
        // The third scan matches a product already counted: nothing visibly changes.
        return json(counted(1));
      },
    });
    expect(await screen.findByRole('heading', { name: 'SC-000001', level: 1 })).toBeVisible();
    expect(screen.getByText('HYD · Hyderabad · Whole store')).toBeInTheDocument();
    expect(screen.getByText('0 of 2')).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Scan or type a barcode or SKU' });
    await user.click(screen.getByRole('button', { name: 'Count one' }));
    expect(requests.some((request) => request.method === 'POST')).toBe(false);

    await user.type(box, '8901234567890{Enter}');
    await waitFor(() => {
      expect(screen.getByText('APX-1L: 1 counted')).toBeInTheDocument();
    });
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    await user.type(box, 'XYZ{Enter}');
    expect(await screen.findByText('XYZ is not part of this count')).toBeInTheDocument();
    expect(box).toHaveValue('XYZ');
    await user.clear(box);
    await user.type(box, 'APX-1L{Enter}');
    expect(await screen.findByText('APX-1L counted')).toBeInTheDocument();
    expect(posts(requests, '/stock-counts/count-1/counts')).toEqual([
      { entries: [{ code: '8901234567890', mode: 'add' }] },
      { entries: [{ code: 'XYZ', mode: 'add' }] },
      { entries: [{ code: 'APX-1L', mode: 'add' }] },
    ]);
  });

  it('sets counts in a batch and checks them first', async () => {
    let fail = true;
    const { user, requests } = renderCount(counted(1), {
      'POST /stock-counts/:id/counts': () =>
        fail ? json({ statusCode: 400, message: 'Too many entries' }, 400) : json(counted(10)),
    });
    const first = await screen.findByRole('textbox', { name: 'Count of APX-1L' });
    expect(first).toHaveValue('1');
    const second = screen.getByRole('textbox', { name: 'Count of APX-4L' });
    expect(second).toHaveValue('');
    const save = screen.getByRole('button', { name: 'Save counts' });
    expect(save).toBeDisabled();
    await user.clear(first);
    await user.type(first, '10');
    await user.type(second, '-1');
    await user.click(save);
    expect(screen.getByText('Enter 0 or more, with at most 3 decimals')).toBeInTheDocument();
    expect(second).toHaveAttribute('aria-invalid', 'true');
    await user.clear(second);
    await user.type(second, '3');
    await user.click(save);
    expect(await screen.findByText('Too many entries')).toBeInTheDocument();
    fail = false;
    await user.click(save);
    expect(await screen.findByText('Counts saved')).toBeInTheDocument();
    expect(posts(requests, '/stock-counts/count-1/counts').at(-1)).toEqual({
      entries: [
        { variantId: 'variant-1l', quantity: 10, mode: 'set' },
        { variantId: 'variant-4l', quantity: 3, mode: 'set' },
      ],
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Count of APX-1L' })).toHaveValue('10');
    });
    expect(screen.getByRole('button', { name: 'Save counts' })).toBeDisabled();
  });

  it('shows a whole-store count a page at a time, keeping counts typed on every page', async () => {
    const lines = Array.from({ length: 150 }, (_, index) =>
      countLine({ variantId: `v${String(index)}`, sku: `SKU-${String(index + 1)}` }),
    );
    const { user, requests } = renderCount(stockCount({ lines }), {
      'POST /stock-counts/:id/counts': () => json(stockCount({ lines })),
    });
    expect(await screen.findByRole('textbox', { name: 'Count of SKU-1' })).toBeVisible();
    expect(rows()).toHaveLength(101);
    expect(screen.getByText('1–100 of 150')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Count of SKU-101' })).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Count of SKU-1' }), '4');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('101–150 of 150')).toBeInTheDocument();
    expect(rows()).toHaveLength(51);
    await user.type(screen.getByRole('textbox', { name: 'Count of SKU-150' }), '-2');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('textbox', { name: 'Count of SKU-1' })).toHaveValue('4');

    // Saving with a mistake on another page shows that page.
    await user.click(screen.getByRole('button', { name: 'Save counts' }));
    const wrong = screen.getByRole('textbox', { name: 'Count of SKU-150' });
    expect(wrong).toHaveAttribute('aria-invalid', 'true');
    await user.clear(wrong);
    await user.type(wrong, '2');
    await user.click(screen.getByRole('button', { name: 'Save counts' }));
    expect(await screen.findByText('Counts saved')).toBeInTheDocument();
    expect(posts(requests, '/stock-counts/count-1/counts')).toEqual([
      {
        entries: [
          { variantId: 'v0', quantity: 4, mode: 'set' },
          { variantId: 'v149', quantity: 2, mode: 'set' },
        ],
      },
    ]);
  });

  it('submits, counting what is left as zero, and shows what the API refuses', async () => {
    let refuse = true;
    const submitted = stockCount({
      status: 'submitted',
      submittedAt: '2026-10-01T08:00:00.000Z',
      note: 'Monthly',
    });
    const { user, requests } = renderCount(counted(10), {
      'POST /stock-counts/:id/submit': () =>
        refuse
          ? json({ statusCode: 400, message: '1 product(s) not counted yet: APX-4L.' }, 400)
          : json(submitted),
    });
    await user.click(await screen.findByRole('button', { name: 'Submit for approval SC-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Submit SC-000001' });
    expect(within(dialog).getByText('2 products not counted yet')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Submit for approval' }));
    expect(await within(dialog).findByText(/not counted yet: APX-4L/)).toBeVisible();
    refuse = false;
    await user.click(within(dialog).getByRole('checkbox', { name: /Count what is left as zero/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText('Count submitted')).toBeInTheDocument();
    expect(posts(requests, '/stock-counts/count-1/submit')).toEqual([
      { uncountedAsZero: false },
      { uncountedAsZero: true },
    ]);
    expect(await screen.findByText('Note: Monthly')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Scan/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Count of APX-1L' })).toBeNull();
  });

  it('submits a fully counted count without a warning', async () => {
    const full = stockCount({
      summary: { ...stockCount().summary, countedLines: 2, uncountedLines: 0 },
    });
    const { user } = renderCount(full);
    await user.click(await screen.findByRole('button', { name: 'Submit for approval SC-000001' }));
    expect(screen.queryByText(/not counted yet/)).toBeNull();
  });

  const review = stockCount({
    status: 'submitted',
    submittedBy: { memberId: 'member-3', name: 'Suresh Yadav' },
    submittedAt: '2026-10-01T08:00:00.000Z',
    summary: {
      totalLines: 3,
      countedLines: 3,
      uncountedLines: 0,
      matchingLines: 1,
      accuracyPercent: 33.3,
      netVarianceValuePaise: -80_000,
      absoluteVarianceValuePaise: 120_000,
    },
    lines: [
      countLine({ countedQuantity: 10, variance: -2, varianceValuePaise: -80_000 }),
      countLine({
        variantId: 'variant-4l',
        sku: 'APX-4L',
        expectedQuantity: 3,
        countedQuantity: 4,
        variance: 1,
        varianceValuePaise: null,
        reason: 'counting_error',
      }),
      countLine({
        variantId: 'v-20',
        sku: 'APX-20L',
        expectedQuantity: 1,
        countedQuantity: 1,
        variance: 0,
        varianceValuePaise: 0,
      }),
    ],
  });

  it('shows the differences and approves them with reasons', async () => {
    let refuse = true;
    const approved = {
      ...review,
      status: 'approved' as const,
      approvedAt: '2026-10-01T09:00:00.000Z',
    };
    const { user, requests } = renderCount(review, {
      'POST /stock-counts/:id/approve': () =>
        refuse
          ? json(
              { statusCode: 403, message: 'Someone else must approve a count you submitted' },
              403,
            )
          : json(approved),
    });
    await screen.findByRole('table', { name: 'Products' });
    expect(rows()).toEqual([
      'ProductBooksCountedDifferenceValue',
      'APX-1LAsian Paints Apex Ultima 1 l1210-2-₹800.00',
      'APX-4LAsian Paints Apex Ultima 1 l341—',
      'APX-20LAsian Paints Apex Ultima 1 l110₹0.00',
    ]);
    expect(screen.getByText('33.3%')).toBeInTheDocument();
    expect(screen.getAllByText('-₹800.00')).toHaveLength(2);
    expect(screen.getByText('₹1,200.00')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve SC-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve SC-000001' });
    expect(within(dialog).queryByRole('combobox', { name: 'Reason for APX-20L' })).toBeNull();
    expect(within(dialog).getByRole('combobox', { name: 'Reason for APX-4L' })).toHaveValue(
      'counting_error',
    );
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Reason for APX-1L' }),
      'Theft',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText(/Someone else must approve/)).toBeVisible();
    refuse = false;
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Reason for APX-4L' }),
      'No reason',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Count approved; stock corrected')).toBeInTheDocument();
    expect(posts(requests, '/stock-counts/count-1/approve').at(-1)).toEqual({
      reasons: [{ variantId: 'variant-1l', reason: 'theft' }],
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Approve SC-000001' })).toBeNull();
    });
  });

  it('approves a count with no differences', async () => {
    const clean = stockCount({
      status: 'submitted',
      lines: [countLine({ countedQuantity: 12, variance: 0, varianceValuePaise: 0 })],
    });
    const { user } = renderCount(clean, {
      'POST /stock-counts/:id/approve': () => json({ ...clean, status: 'approved' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Approve SC-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve SC-000001' });
    expect(within(dialog).getByText('Every count matches the books.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Count approved; stock corrected')).toBeInTheDocument();
  });

  it('sends a submitted count back for recounting', async () => {
    let fail = true;
    const { user } = renderCount(review, {
      'POST /stock-counts/:id/reopen': () =>
        fail
          ? json({ statusCode: 409, message: 'This count is approved' }, 409)
          : json({ ...review, status: 'counting', submittedAt: null }),
    });
    await user.click(await screen.findByRole('button', { name: 'Recount' }));
    expect(await screen.findByText('This count is approved')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Recount' }));
    expect(await screen.findByText('Count reopened for recounting')).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: /Scan/ })).toBeInTheDocument();
  });

  it('cancels a count with a reason', async () => {
    const { user, requests } = renderCount(stockCount(), {
      'POST /stock-counts/:id/cancel': () =>
        json(
          stockCount({
            status: 'cancelled',
            closingReason: 'Wrong store',
            closedAt: '2026-10-01T09:00:00.000Z',
            lines: [],
          }),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel count SC-000001' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel SC-000001' });
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Wrong store');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel count' }));
    expect(await screen.findByText('Reason: Wrong store')).toBeInTheDocument();
    expect(screen.getByText('Count cancelled')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing in scope yet. Scan products as you find them.'),
    ).toBeInTheDocument();
    expect(posts(requests, '/stock-counts/count-1/cancel')).toEqual([{ reason: 'Wrong store' }]);
    expect(screen.queryByRole('button', { name: /SC-000001$/ })).toBeNull();
  });

  it('only lets staff of the store with stock rights act', async () => {
    renderCount(review, {}, CASHIER);
    await screen.findByRole('table', { name: 'Products' });
    expect(screen.queryByRole('button', { name: 'Approve SC-000001' })).toBeNull();
    const elsewhere = profile(undefined, { allStores: false, storeIds: ['store-pun'] });
    renderCount(stockCount(), {}, elsewhere);
    await screen.findAllByRole('table', { name: 'Products' });
    expect(screen.queryByRole('textbox', { name: /Scan/ })).toBeNull();
  });

  it('names who started and submitted, and hides Approve from the one who submitted', async () => {
    const submitter = profile(undefined, {
      memberId: 'member-3',
      allStores: false,
      storeIds: ['store-hyd'],
    });
    renderCount(review, {}, submitter);
    expect(await screen.findByText(/Started .* · Ravi Teja/)).toBeInTheDocument();
    expect(screen.getByText(/Submitted .* · Suresh Yadav/)).toBeInTheDocument();
    expect(
      screen.getByText('You submitted this count, so someone else at the store approves it.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve SC-000001' })).toBeNull();
    // They can still send it back or cancel it.
    expect(screen.getByRole('button', { name: 'Recount' })).toBeInTheDocument();
  });

  it('lets a submitter with every store approve their own count', async () => {
    renderCount(review, {}, profile(undefined, { memberId: 'member-3' }));
    expect(await screen.findByRole('button', { name: 'Approve SC-000001' })).toBeInTheDocument();
    expect(screen.queryByText(/You submitted this count/)).toBeNull();
  });

  it('says when the count cannot be seen', async () => {
    renderCount(stockCount(), {
      'GET /stock-counts/:id': () => json({ statusCode: 404, message: 'Not found' }, 404),
    });
    expect(await screen.findByText('Could not load this stock count')).toBeInTheDocument();
  });
});
