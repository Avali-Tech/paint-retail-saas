import { SYSTEM_ROLES } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import {
  ADJUSTMENTS,
  CREDIT_NOTE,
  DEBIT_SUMMARY,
  DISCOUNT_NOTE,
  DRAFT,
  INVOICE,
  NOTE_SUMMARY,
  SALES_RETURN,
} from '../test-support/sales-fixtures.js';
import { PAGE_SIZE } from './InvoicesPage.js';

const SALES = profile(SYSTEM_ROLES.find((role) => role.key === 'sales_executive')?.permissions, {
  role: { key: 'sales_executive', name: 'Sales Executive' },
});
const location = () => screen.getByTestId('location').textContent;

/** The invoice page's routes: the invoice, its adjustments, and where a note leads. */
const invoiceRoutes = (
  overrides: Record<string, FakeHandler> = {},
  invoice = INVOICE,
  adjustments = ADJUSTMENTS,
): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /invoices/:id': () => json(invoice),
  'GET /invoices/:id/adjustments': () => json(adjustments),
  'GET /notes/:id': () => json(CREDIT_NOTE),
  ...overrides,
});

describe('InvoicesPage', { timeout: 30_000 }, () => {
  it('lists invoices with filters, drafts and pages', async () => {
    const { user, requests } = renderApp({
      path: '/invoices',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /invoices': (request) =>
          request.query.get('offset') === '0'
            ? json({
                items: [
                  {
                    id: INVOICE.id,
                    kind: 'invoice',
                    status: 'issued',
                    storeId: 'store-1',
                    number: INVOICE.number,
                    issuedOn: '2026-10-08',
                    buyerName: 'Lakshmi',
                    totalPaise: 1_35_400,
                  },
                  {
                    id: DRAFT.id,
                    kind: 'bill_of_supply',
                    status: 'draft',
                    storeId: 'store-1',
                    number: null,
                    issuedOn: null,
                    buyerName: null,
                    totalPaise: 0,
                  },
                ],
                total: PAGE_SIZE + 1,
                totalCapped: false,
                nextCursor: 'cursor-2',
              })
            : json({ items: [], total: 0, totalCapped: false, nextCursor: null }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(requests.at(-1)?.query.toString()).toBe(
      'limit=50&offset=0&kinds=invoice%2Cbill_of_supply',
    );
    const [, issued, draft] = within(table).getAllByRole('row');
    expect(within(found(issued)).getByRole('link', { name: INVOICE.number ?? '' })).toHaveAttribute(
      'href',
      `/invoices/${INVOICE.id}`,
    );
    expect(issued).toHaveTextContent('Tax invoice');
    expect(issued).toHaveTextContent('₹1,354.00');
    expect(issued).toHaveTextContent('Issued');
    expect(draft).toHaveTextContent('DraftBill of supply——₹0.00Draft');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Cancelled');
    await user.type(screen.getByRole('searchbox', { name: 'Number or customer' }), 'AMP');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('AMP');
    });
    expect(requests.at(-1)?.query.get('status')).toBe('cancelled');
    await user.type(screen.getByLabelText('Issued from'), '2026-10-01');
    await user.type(screen.getByLabelText('Issued to'), '2026-10-31');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('to')).toBe('2026-10-31');
    });
    expect(requests.at(-1)?.query.get('from')).toBe('2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('cursor')).toBe('cursor-2');
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });
    expect(await screen.findByText('No invoices here')).toBeVisible();
  });

  it('shows a failure', async () => {
    renderApp({
      path: '/invoices',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /invoices': () => json({ message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the invoices')).toBeVisible();
  });
});

describe('InvoicePage', { timeout: 30_000 }, () => {
  it('shows an invoice, takes items back with a preview, and opens the credit note', async () => {
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({ 'POST /sales-returns': () => json(SALES_RETURN, 201) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Invoice AMP/26-27/000001', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('Within the state')).toBeVisible();
    const lines = screen.getByRole('table', { name: 'Lines' });
    expect(lines).toHaveTextContent(
      'Apex Ultima 1 lTint X 132 · Ivory Mist · Base Apex Ultima 1 l · Formula XY 12 ml320910903' +
        '18%₹300.00₹54.00₹354.00',
    );
    expect(screen.getAllByRole('definition').map((node) => node.textContent)).toContain(
      '₹1,354.00',
    );
    expect(await screen.findByText('No returns or notes on this invoice yet.')).toBeVisible();
    expect(screen.getByText(/Credit notes can be issued until/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Return items' }));
    const dialog = screen.getByRole('dialog', { name: 'Return items: AMP/26-27/000001' });
    expect(
      within(dialog).getByText('Enter quantities or values to see the tax the note reverses.'),
    ).toBeVisible();
    expect(within(dialog).getAllByText('2 of 3 can come back')).toHaveLength(2);
    const apexStock = within(dialog).getByRole('textbox', {
      name: 'Back to stock · Apex Ultima 1 l',
    });
    const rollerDamage = within(dialog).getByRole('textbox', { name: 'Damaged · Roller 9 inch' });

    await user.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));
    expect(
      await within(dialog).findByText('Enter how many of at least one item come back'),
    ).toBeVisible();

    await user.type(apexStock, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));
    expect(
      await within(dialog).findAllByText('Enter a quantity with at most 3 decimals'),
    ).toHaveLength(2);
    await user.clear(apexStock);
    await user.type(apexStock, '3');
    await user.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));
    expect(await within(dialog).findAllByText('At most 2 can come back')).toHaveLength(2);

    await user.clear(apexStock);
    await user.type(apexStock, '1');
    await user.type(rollerDamage, '1');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), ' Wrong shade ');
    const preview = within(dialog).getByRole('region', { name: 'Credit note preview' });
    // One Apex (₹118) and one roller (₹500), at the invoice's 18%.
    expect(preview).toHaveTextContent('₹618.00');
    await user.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));
    await waitFor(() => {
      expect(location()).toBe(`/notes/${CREDIT_NOTE.id}`);
    });
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      invoiceId: INVOICE.id,
      lines: [
        { invoiceLineId: 'line-1', quantity: 1, disposition: 'restock' },
        { invoiceLineId: 'line-2', quantity: 1, disposition: 'damage' },
      ],
      note: 'Wrong shade',
    });
    expect(await screen.findByText('Credit note AMPC/26-27/00001 issued')).toBeVisible();
    // The dialog and its button are gone with the invoice: the focus lands on the note.
    const heading = await screen.findByRole('heading', { level: 1, name: /AMPC\/26-27\/00001/ });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('returns without a note', async () => {
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({ 'POST /sales-returns': () => json(SALES_RETURN, 201) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Return items' }));
    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Back to stock · Roller 9 inch' }),
      '2',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));
    await waitFor(() => {
      expect(location()).toBe(`/notes/${CREDIT_NOTE.id}`);
    });
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      invoiceId: INVOICE.id,
      lines: [{ invoiceLineId: 'line-2', quantity: 2, disposition: 'restock' }],
    });
  });

  it('issues a discount credit note under a scheme, with the tax previewed', async () => {
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({ 'POST /credit-notes': () => json(DISCOUNT_NOTE, 201) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Credit / debit note' }));
    const dialog = screen.getByRole('dialog', { name: 'Credit or debit note: AMP/26-27/000001' });
    const submit = () => user.click(within(dialog).getByRole('button', { name: 'Issue note' }));
    const apex = within(dialog).getByRole('textbox', { name: 'Value for Apex Ultima 1 l (₹)' });

    await submit();
    expect(
      await within(dialog).findByText('Name the scheme the discount comes from'),
    ).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Scheme agreed before the sale' }),
      'Diwali',
    );
    await submit();
    expect(await within(dialog).findByText('Enter a value for at least one line')).toBeVisible();
    await user.type(apex, 'abc');
    await submit();
    expect(await within(dialog).findByText('Enter an amount in rupees')).toBeVisible();
    await user.clear(apex);
    await user.type(apex, '118');
    expect(within(dialog).getByRole('region', { name: 'Note preview' })).toHaveTextContent(
      'Taxable value₹100.00CGST₹9.00SGST₹9.00IGST₹0.00Round-off₹0.00Total₹118.00',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Volume');
    await submit();
    await waitFor(() => {
      expect(location()).toBe(`/notes/${DISCOUNT_NOTE.id}`);
    });
    expect(requests.find((request) => request.path === '/credit-notes')?.body).toEqual({
      invoiceId: INVOICE.id,
      lines: [{ invoiceLineId: 'line-1', valuePaise: 118_00 }],
      valueIncludesTax: true,
      note: 'Volume',
      reason: 'discount',
      schemeReference: 'Diwali',
    });
  });

  it('issues an overcharge credit note and a debit note on exclusive values', async () => {
    const { user, requests } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({
        'POST /credit-notes': () => json(CREDIT_NOTE, 201),
        'POST /debit-notes': () => json({ ...CREDIT_NOTE, id: 'debit-1', kind: 'debit_note' }, 201),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Credit / debit note' }));
    let dialog = screen.getByRole('dialog');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Reason' }),
      'Overcharged',
    );
    expect(within(dialog).queryByRole('textbox', { name: /Scheme/ })).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Amounts include tax' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Value for Roller 9 inch (₹)' }),
      '100',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Issue note' }));
    await waitFor(() => {
      expect(location()).toBe(`/notes/${CREDIT_NOTE.id}`);
    });
    expect(requests.find((request) => request.path === '/credit-notes')?.body).toEqual({
      invoiceId: INVOICE.id,
      lines: [{ invoiceLineId: 'line-2', valuePaise: 100_00 }],
      valueIncludesTax: false,
      reason: 'overcharge',
    });

    // Back on the invoice: a debit note for an undercharge.
    await user.click(await screen.findByRole('link', { name: INVOICE.number ?? '' }));
    await user.click(await screen.findByRole('button', { name: 'Credit / debit note' }));
    dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Kind' }), 'Debit note');
    expect(within(dialog).queryByRole('combobox', { name: 'Reason' })).toBeNull();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Value for Apex Ultima 1 l (₹)' }),
      '10',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Issue note' }));
    await waitFor(() => {
      expect(location()).toBe('/notes/debit-1');
    });
    expect(requests.find((request) => request.path === '/debit-notes')?.body).toEqual({
      invoiceId: INVOICE.id,
      lines: [{ invoiceLineId: 'line-1', valuePaise: 10_00 }],
      valueIncludesTax: true,
    });
  });

  it('warns as the s.34(2) window closes, and offers only a debit note once it has', async () => {
    const closing = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({}, INVOICE, {
        ...ADJUSTMENTS,
        creditNoteWindow: { deadline: '2026-11-30', status: 'closing', daysLeft: 1 },
        notes: [NOTE_SUMMARY, DEBIT_SUMMARY],
      }),
    });
    expect(await screen.findByText(/close on .*: 1 day left/)).toBeVisible();
    const notes = screen.getByRole('table', { name: 'Returns and notes' });
    expect(within(notes).getByRole('link', { name: 'AMPC/26-27/00001' })).toHaveAttribute(
      'href',
      `/notes/${CREDIT_NOTE.id}`,
    );
    expect(notes).toHaveTextContent('Undercharged');
    closing.unmount();

    const { user } = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({}, INVOICE, {
        ...ADJUSTMENTS,
        creditNoteWindow: { deadline: '2025-11-30', status: 'closed', daysLeft: -300 },
      }),
    });
    expect(await screen.findByText(/Only a debit note can still be issued/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Return items' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Credit / debit note' }));
    const kinds = within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Kind' });
    expect(
      within(kinds)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Debit note']);
  });

  it('offers no debit note on a bill of supply, nothing on drafts or without the right', async () => {
    const bill = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({}, { ...INVOICE, kind: 'bill_of_supply' }),
    });
    await bill.user.click(await screen.findByRole('button', { name: 'Credit / debit note' }));
    const kinds = within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Kind' });
    expect(
      within(kinds)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Credit note']);
    bill.unmount();

    const draft = renderApp({
      path: `/invoices/${DRAFT.id}`,
      routes: invoiceRoutes({}, DRAFT, { ...ADJUSTMENTS, creditNoteWindow: null }),
    });
    expect(await screen.findByRole('heading', { name: 'Draft bill', level: 1 })).toBeVisible();
    expect(await screen.findByText('No returns or notes on this invoice yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Credit / debit note' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Lines' })).toHaveTextContent('——3—₹300.00');
    draft.unmount();

    const cancelled = renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes(
        { 'GET /auth/me': () => json(SALES) },
        { ...INVOICE, status: 'cancelled', cancelReason: 'Typed wrong' },
      ),
    });
    expect(await screen.findByText('Typed wrong')).toBeVisible();
    expect(await screen.findByText(/Credit notes can be issued until/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Return items' })).toBeNull();
    cancelled.unmount();

    renderApp({
      path: `/invoices/${INVOICE.id}`,
      routes: invoiceRoutes({ 'GET /invoices/:id/adjustments': () => json({}, 500) }),
    });
    expect(await screen.findByText('Could not load the returns and notes')).toBeVisible();
  });
});

describe('NotesPage', { timeout: 30_000 }, () => {
  it('lists notes by kind and pages', async () => {
    const { user, requests } = renderApp({
      path: '/notes',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /notes': (request) =>
          request.query.get('offset') === '0'
            ? json({
                items: [NOTE_SUMMARY, DEBIT_SUMMARY],
                total: PAGE_SIZE + 1,
                totalCapped: false,
                nextCursor: 'cursor-2',
              })
            : json({ items: [], total: 0, totalCapped: false, nextCursor: null }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Credit & debit notes' });
    expect(within(table).getAllByRole('link', { name: INVOICE.number ?? '' })).toHaveLength(2);
    expect(table).toHaveTextContent('Goods returned');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'Debit note');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('kind')).toBe('debit_note');
    });
    await user.type(screen.getByRole('searchbox', { name: 'Number or customer' }), 'AMPC');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('AMPC');
    });
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('cursor')).toBe('cursor-2');
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });
    expect(await screen.findByText('No notes here')).toBeVisible();
  });
});

describe('NotePage', { timeout: 30_000 }, () => {
  it('shows a credit note against its invoice', async () => {
    renderApp({
      path: `/notes/${CREDIT_NOTE.id}`,
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /notes/:id': () => json(CREDIT_NOTE) },
    });
    expect(
      await screen.findByRole('heading', { name: 'Credit note AMPC/26-27/00001', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: INVOICE.number ?? '' })).toHaveAttribute(
      'href',
      `/invoices/${INVOICE.id}`,
    );
    expect(screen.getByText('Goods returned')).toBeVisible();
    expect(screen.queryByText('Buyer’s input tax credit')).toBeNull();
  });

  it('explains a B2B note waiting on the buyer’s input credit', async () => {
    renderApp({
      path: `/notes/${DISCOUNT_NOTE.id}`,
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /notes/:id': () => json(DISCOUNT_NOTE) },
    });
    expect(await screen.findByText(/reverses the input tax credit/)).toBeVisible();
    expect(screen.getByText('Not yet known')).toBeVisible();
    expect(screen.getByText('Diwali')).toBeVisible();
    expect(screen.getByText('Volume')).toBeVisible();
  });

  it('says when a note cannot be seen', async () => {
    renderApp({
      path: '/notes/missing',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /notes/:id': () => json({ message: 'Not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load the note')).toBeVisible();
  });
});
