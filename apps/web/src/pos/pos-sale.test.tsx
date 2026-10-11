import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test-support/fake-api.js';
import { renderPos, scanBox, total } from './test-support/pos-render.js';

const print = vi.fn();
beforeEach(() => {
  print.mockClear();
  vi.spyOn(window, 'print').mockImplementation(print);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Types an amount in one go, as a paste or a quick typist would. */
async function fill(
  user: {
    clear: (e: Element) => Promise<void>;
    click: (e: Element) => Promise<void>;
    paste: (t: string) => Promise<void>;
  },
  element: HTMLElement,
  text: string,
) {
  await user.clear(element);
  await user.click(element);
  await user.paste(text);
}

const lineNames = () =>
  within(screen.getByRole('list', { name: 'Bill' }))
    .getAllByRole('listitem')
    .map((line) => line.getAttribute('aria-label'));

describe('PosPage: a walk-in sale', () => {
  it('scans, searches, splits cash and UPI, issues, prints and starts a new sale', async () => {
    const { user, requests } = renderPos();
    const box = await scanBox();
    await waitFor(() => {
      expect(box).toHaveFocus();
    });
    expect(await screen.findByText('Register open · C1')).toBeInTheDocument();

    await user.keyboard('8901000000017{Enter}');
    await screen.findByRole('list', { name: 'Bill' });
    await user.type(box, '2*PUT-20KG{Enter}');
    await user.type(box, 'inch{Enter}');
    const results = await screen.findByRole('listbox', { name: 'Matching products' });
    expect(
      within(results)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Asian Paints Roller 9 inch · ROL-9 · ₹260.00',
      'Asian Paints Roller 4 inch · ROL-4 · ₹300.00',
    ]);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');
    expect(lineNames()).toEqual([
      'Asian Paints Apex Ultima 20 l',
      'Asian Paints Wall Putty 20 kg',
      'Asian Paints Roller 4 inch',
    ]);
    expect(total()).toBe('₹12,990.00');
    expect(screen.getByText('Total · 3 items')).toBeInTheDocument();
    expect(screen.getByText('CGST 9%')).toBeInTheDocument();
    expect(screen.getByText('SGST 6%')).toBeInTheDocument();

    // Saved as a draft in the background.
    await waitFor(() => {
      expect(screen.getByText('Bill saved')).toBeInTheDocument();
    });

    await user.keyboard('{F8}');
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    const first = within(dialog).getByRole('textbox', { name: 'Amount of payment 1' });
    expect(first).toHaveValue('12990.00');
    expect(within(dialog).getByRole('radio', { name: 'Cash' })).toBeChecked();
    await user.clear(first);
    await user.type(first, '5000');
    const second = within(dialog).getByRole('textbox', { name: 'Amount of payment 2' });
    expect(second).toHaveValue('7990.00');
    expect(
      within(within(dialog).getByRole('radiogroup', { name: 'Mode of payment 2' })).getByRole(
        'radio',
        { name: 'UPI' },
      ),
    ).toBeChecked();
    await user.click(first);
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('dialog', { name: 'Bill AMP/26-27/000001 issued' }),
    ).toBeVisible();
    expect(print).toHaveBeenCalledTimes(1);
    const issue = requests.find((request) => request.path.endsWith('/issue'));
    expect(issue?.body).toEqual({
      payments: [
        { modeId: 'mode-cash', amountPaise: 500_000, registerSessionId: 'rs1' },
        { modeId: 'mode-upi', amountPaise: 799_000 },
      ],
    });
    expect(issue?.headers['Idempotency-Key']).toMatch(/:issue$/);
    expect(screen.getByTestId('print-layer')).toHaveTextContent('AMP/26-27/000001');
    expect(
      screen.getByRole('article', { name: 'Tax Invoice AMP/26-27/000001' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Print A4' }));
    expect(print).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('print-layer')).toHaveAttribute('data-format', 'a4');
    await user.click(screen.getByRole('button', { name: 'Print again' }));
    expect(print).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole('button', { name: 'New sale' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByText('Scan or search a product to start the bill.')).toBeInTheDocument();
    await waitFor(() => {
      expect(box).toHaveFocus();
    });
    expect(screen.queryByTestId('print-layer')).toBeNull();
    expect(localStorage.getItem('pos.current.store-amp')).toBeNull();
  });

  it('gives change for cash, refuses a walk-in short or UPI over the bill', async () => {
    const { user, requests } = renderPos();
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await screen.findByRole('list', { name: 'Bill' });
    await user.click(screen.getByRole('button', { name: 'Pay ₹10,450.00 (F8)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    const amount = within(dialog).getByRole('textbox', { name: 'Amount of payment 1' });

    await fill(user, amount, 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    expect(within(dialog).getByText('Enter an amount in rupees')).toBeInTheDocument();

    // A second payment row appeared for the rest; take it away again.
    await fill(user, amount, '100');
    await user.click(within(dialog).getByRole('button', { name: 'Remove payment 2' }));
    expect(within(dialog).getByText('Still to pay: ₹10,350.00')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    expect(
      within(dialog).getByText('Take the full amount: a walk-in customer cannot owe.'),
    ).toBeInTheDocument();

    const firstModes = within(dialog).getByRole('radiogroup', { name: 'Mode of payment 1' });
    await user.click(within(firstModes).getByRole('radio', { name: 'UPI' }));
    await fill(user, amount, '20000');
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    expect(
      within(dialog).getByText(
        'Card or UPI cannot be more than the bill. Lower it, or take the extra in cash.',
      ),
    ).toBeInTheDocument();

    await user.click(within(firstModes).getByRole('radio', { name: 'Cash' }));
    expect(within(dialog).getByText('Change to give: ₹9,550.00')).toBeInTheDocument();
    // Adding a payment when nothing is owed starts it at zero.
    await user.click(within(dialog).getByRole('button', { name: 'Add a payment' }));
    expect(within(dialog).getByRole('textbox', { name: 'Amount of payment 2' })).toHaveValue(
      '0.00',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    await screen.findByRole('dialog', { name: 'Bill AMP/26-27/000001 issued' });
    expect(screen.getAllByText('Change to give: ₹9,550.00').length).toBeGreaterThan(0);
    expect(requests.find((request) => request.path.endsWith('/issue'))?.body).toEqual({
      payments: [
        {
          modeId: 'mode-cash',
          amountPaise: 1_045_000,
          tenderedPaise: 2_000_000,
          registerSessionId: 'rs1',
        },
      ],
    });
    // Escape on the issued bill starts the next sale too.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByText('Scan or search a product to start the bill.')).toBeInTheDocument();
  });

  it('moves the rest to the last payment when an earlier one changes, and shows a refused issue', async () => {
    const { user } = renderPos({
      'POST /invoices/:id/issue': () =>
        json(
          {
            statusCode: 422,
            message: 'Cannot issue',
            issues: [{ path: 'buyer.name', message: 'Required' }],
          },
          422,
        ),
    });
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await screen.findByRole('list', { name: 'Bill' });
    await user.keyboard('{F8}');
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    const first = within(dialog).getByRole('textbox', { name: 'Amount of payment 1' });
    await fill(user, first, '450');
    const second = within(dialog).getByRole('textbox', { name: 'Amount of payment 2' });
    expect(second).toHaveValue('10000.00');
    await fill(user, first, '1450');
    expect(second).toHaveValue('9000.00');
    // Too much in the first: the last keeps what it had (the whole bill, after the clear).
    await fill(user, first, '99999');
    expect(second).toHaveValue('10450.00');
    await fill(user, first, 'x');
    await fill(user, second, '1');
    await fill(user, first, '10449');
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    expect(await within(dialog).findByText('Cannot issue')).toBeInTheDocument();
    // Closing goes back to the bill, still there.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(total()).toBe('₹10,450.00');
    expect(print).not.toHaveBeenCalled();
  });

  it('issues unpaid when the ways to pay cannot be loaded, and hides the register from a cashier', async () => {
    const { user, requests } = renderPos({
      'GET /payment-modes': () => json({ message: 'Down' }, 500),
      'GET /register-sessions': () => json({ message: 'Forbidden' }, 403),
    });
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await screen.findByRole('list', { name: 'Bill' });
    // F8 waits until the payment modes are known.
    await waitFor(() => {
      expect(requests.some((request) => request.path === '/payment-modes')).toBe(true);
    });
    await user.keyboard('{F8}');
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    expect(
      within(dialog).getByText(
        'No payment modes are set up, so this bill is issued without a payment.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Register/)).toBeNull();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Bill AMP/26-27/000001 issued' });
    expect(requests.find((request) => request.path.endsWith('/issue'))?.body).toEqual({});
  });

  it('shows the refusal when issuing without payments fails', async () => {
    const { user } = renderPos({
      'GET /payment-modes': () => json([]),
      'POST /invoices/:id/issue': () => json({ message: 'Not enough stock of APX-20L' }, 409),
    });
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await screen.findByRole('list', { name: 'Bill' });
    await waitFor(() => {
      expect(screen.getByText('Bill saved')).toBeInTheDocument();
    });
    await user.keyboard('{F8}');
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    expect(await within(dialog).findByText('Not enough stock of APX-20L')).toBeInTheDocument();
  });
});
