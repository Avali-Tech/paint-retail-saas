import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Party } from '../api/parties.js';
import { OWNER, json, profile, type FakeAnswer } from '../test-support/fake-api.js';
import { product, variant } from '../test-support/inventory-fixtures.js';
import {
  AMP,
  CASHIER_POS,
  GODOWN,
  KPH,
  MODES,
  document,
  draftLine,
  item,
} from './test-support/pos-fixtures.js';
import {
  PRODUCTS,
  lookupIn,
  renderPos,
  scanBox,
  searchIn,
  total,
} from './test-support/pos-render.js';

const print = vi.fn();
beforeEach(() => {
  print.mockClear();
  vi.spyOn(window, 'print').mockImplementation(print);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const line = (name: string) => screen.getByRole('listitem', { name });
const APEX_NAME = 'Asian Paints Apex Ultima 20 l';
const PUTTY_NAME = 'Asian Paints Wall Putty 20 kg';

const party = (overrides: Partial<Party> = {}): Party => ({
  id: 'party-ravi',
  kind: 'person',
  displayName: 'Ravi Contractor',
  legalName: null,
  contactPerson: null,
  phone: '+919848012345',
  alternatePhone: null,
  email: null,
  gstin: null,
  pan: null,
  addressLine: null,
  city: null,
  state: null,
  pincode: null,
  placeOfSupply: null,
  homeStoreId: null,
  notes: null,
  tags: [],
  isActive: true,
  mergedIntoId: null,
  roles: ['customer'],
  customer: { customerType: 'retail', assignedMemberId: null, preferredContact: 'phone' },
  ...overrides,
});

const overview = (credit: unknown, loyalty: unknown) => ({ party: party(), credit, loyalty });

const credit = (status: string, availablePaise: number) => ({
  status,
  limitPaise: 5_000_000,
  creditDays: 30,
  risk: 'low',
  manualExposurePaise: 0,
  overdueDays: 0,
  check: {
    decision: 'allowed',
    blockedBecause: null,
    projectedExposurePaise: 0,
    availablePaise,
    utilizationPercent: 0,
  },
  pendingRequest: null,
});

describe('PosPage: the bill', () => {
  it('edits lines with the keys, the − / + buttons, typed quantities and discounts', async () => {
    const { user } = renderPos();
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await user.type(box, 'PUT-20KG{Enter}');
    await screen.findByRole('listitem', { name: PUTTY_NAME });
    // + / − act on the selected (last added) line; − never goes below one.
    await user.keyboard('++-');
    expect(screen.getByRole('textbox', { name: `Quantity of ${PUTTY_NAME}` })).toHaveValue('2');
    await user.keyboard('5*{Enter}');
    expect(screen.getByRole('textbox', { name: `Quantity of ${PUTTY_NAME}` })).toHaveValue('5');
    await user.keyboard('{ArrowUp}{ArrowUp}-');
    expect(line(APEX_NAME)).toHaveAttribute('data-selected');
    await user.keyboard('{ArrowDown}{Delete}');
    expect(screen.queryByRole('listitem', { name: PUTTY_NAME })).toBeNull();

    const quantity = screen.getByRole('textbox', { name: `Quantity of ${APEX_NAME}` });
    await user.click(screen.getByRole('button', { name: `One more ${APEX_NAME}` }));
    await user.click(screen.getByRole('button', { name: `One less ${APEX_NAME}` }));
    expect(quantity).toHaveValue('1');
    expect(screen.getByRole('button', { name: `One less ${APEX_NAME}` })).toBeDisabled();
    await user.clear(quantity);
    await user.type(quantity, '0{Enter}');
    expect(
      screen.getByText('Enter a quantity above zero, with at most 3 decimals'),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.tab();
    expect(quantity).toHaveValue('1');
    await user.click(quantity);
    await user.tab();
    await user.clear(quantity);
    await user.type(quantity, '2.5{Enter}');
    expect(quantity).toHaveValue('2.5');
    expect(total()).toBe('₹26,125.00');

    const discount = screen.getByRole('textbox', { name: `Discount on ${APEX_NAME}` });
    await user.type(discount, '200%{Enter}');
    expect(
      screen.getByText('Enter a discount such as 10% or 50, at most the line’s value'),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.clear(discount);
    await user.type(discount, '10%');
    await user.tab();
    expect(discount).toHaveValue('10%');
    expect(total()).toBe('₹23,513.00');
    await user.click(discount);
    await user.keyboard('{Escape}');
    await user.tab();

    await user.click(screen.getByRole('button', { name: `Remove ${APEX_NAME}` }));
    expect(screen.getByText('Scan or search a product to start the bill.')).toBeInTheDocument();
    // With no line the keys do nothing, and "3*" alone is ignored.
    await user.click(box);
    await user.keyboard('+{Delete}3*{Enter}x');
    expect(box).toHaveValue('x');
    expect(screen.getByRole('button', { name: 'Pay ₹0.00 (F8)' })).toBeDisabled();
    await user.keyboard('{F8}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains scans it cannot add, and adds from the list by mouse or the Find button', async () => {
    const OLD = product({
      id: 'product-old',
      name: 'Old Enamel',
      isActive: false,
      variants: [variant({ id: 'v-old', sku: 'OLD-1', barcodes: [] })],
    });
    const NOPRICE = product({
      id: 'product-np',
      name: 'Primer',
      taxCategory: null,
      variants: [
        variant({ id: 'v-np', sku: 'PRM-1', sellingPricePaise: null, barcodes: [] }),
        variant({ id: 'v-np4', sku: 'PRM-4', packSize: 4, barcodes: [] }),
      ],
    });
    const all = [...PRODUCTS, OLD, NOPRICE];
    const { user, requests } = renderPos({
      'GET /products/lookup': (request) =>
        request.query.get('code') === 'BOOM'
          ? json({ message: 'Catalogue down' }, 500)
          : lookupIn(all)(request),
      'GET /products': searchIn(all),
    });
    const box = await scanBox();
    await user.type(box, 'OLD-1{Enter}');
    expect(await screen.findByText('OLD-1 is no longer sold')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('OLD-1 is no longer sold')).toBeNull();
    await user.clear(box);
    await user.type(box, 'PRM-1{Enter}');
    expect(
      await screen.findByText('PRM-1 has no selling price. Set one in Products before selling it.'),
    ).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'BOOM{Enter}');
    expect(await screen.findByText('Catalogue down')).toBeInTheDocument();
    // A failed lookup gives the code back, so Enter tries again.
    expect(box).toHaveValue('BOOM');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Catalogue down')).toBeInTheDocument();
    expect(box).toHaveValue('BOOM');
    await user.clear(box);
    await user.type(box, 'no such thing{Enter}');
    expect(await screen.findByText('Nothing matches “no such thing”')).toBeInTheDocument();
    // A name with a space skips the barcode lookup.
    expect(requests.filter((request) => request.path === '/products/lookup')).toHaveLength(4);

    await user.clear(box);
    await user.type(box, 'primer');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    const results = await screen.findByRole('listbox', { name: 'Matching products' });
    expect(within(results).getByRole('option', { name: /PRM-1/ })).toHaveTextContent('—');
    // Picked from the list, a variant without a price is refused and the list stays.
    await user.pointer({
      keys: '[MouseLeft>]',
      target: within(results).getByRole('option', { name: /PRM-1/ }),
    });
    expect(
      screen.getByText('PRM-1 has no selling price. Set one in Products before selling it.'),
    ).toBeInTheDocument();
    expect(results).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('listbox', { hidden: true })).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await user.pointer({
      keys: '[MouseLeft>]',
      target: await screen.findByRole('option', { name: /PRM-4/ }),
    });
    expect(await screen.findByRole('listitem', { name: 'Asian Paints Primer 4 l' })).toBeVisible();
    // Without a tax category the tax waits for the issue.
    expect(
      screen.getByText(
        'A product has no GST rate today; the bill cannot be issued until it has one.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Total · 1 item')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Find' }));
  });

  it('adds scans typed while a lookup is pending, in the order they were scanned', async () => {
    const apex = gate();
    const { user } = renderPos({
      'GET /products/lookup': async (request) => {
        if (request.query.get('code') === 'APX-20L') await apex.wait;
        return lookupIn(PRODUCTS)(request);
      },
    });
    const box = await scanBox();
    // A barcode gun: the box empties on Enter, ready for the next code at once.
    await user.type(box, 'APX-20L{Enter}');
    expect(box).toHaveValue('');
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    await user.type(box, '2*PUT-20KG{Enter}');
    expect(box).toHaveValue('');
    // What is typed while the lookups run is kept.
    await user.type(box, 'rol');
    expect(screen.queryByRole('listitem', { name: PUTTY_NAME })).toBeNull();
    apex.open();
    await screen.findByRole('listitem', { name: PUTTY_NAME });
    const bill = screen.getByRole('list', { name: 'Bill' });
    expect(
      within(bill)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual([APEX_NAME, PUTTY_NAME]);
    expect(screen.getByRole('textbox', { name: `Quantity of ${PUTTY_NAME}` })).toHaveValue('2');
    expect(box).toHaveValue('rol');
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
  });

  it('gives back a code with no single match, unless something new was typed', async () => {
    let search = gate();
    const { user } = renderPos({
      'GET /products': async (request) => {
        await search.wait;
        return request.query.get('q') === 'down'
          ? json({ message: 'Search is down' }, 500)
          : searchIn(PRODUCTS)(request);
      },
    });
    const box = await scanBox();

    await user.type(box, 'zzz{Enter}');
    expect(box).toHaveValue('');
    search.open();
    expect(await screen.findByText('Nothing matches “zzz”')).toBeInTheDocument();
    expect(box).toHaveValue('zzz');

    search = gate();
    await user.clear(box);
    await user.type(box, 'qqq{Enter}');
    await user.type(box, 'a');
    search.open();
    expect(await screen.findByText('Nothing matches “qqq”')).toBeInTheDocument();
    expect(box).toHaveValue('a');

    // A failed search does not give the code back over what was typed since.
    search = gate();
    await user.clear(box);
    await user.type(box, 'down{Enter}');
    await user.type(box, 'y');
    search.open();
    expect(await screen.findByText('Search is down')).toBeInTheDocument();
    expect(box).toHaveValue('y');

    // Several matches: the list is offered and the code comes back with its quantity.
    search = gate();
    await user.clear(box);
    await user.type(box, '3*roller{Enter}');
    search.open();
    const results = await screen.findByRole('listbox', { name: 'Matching products' });
    expect(box).toHaveValue('3*roller');
    expect(within(results).getAllByRole('option')).toHaveLength(2);
    await user.keyboard('{ArrowDown}{Enter}');
    await screen.findByRole('listitem', { name: 'Asian Paints Roller 4 inch' });
    expect(
      screen.getByRole('textbox', { name: 'Quantity of Asian Paints Roller 4 inch' }),
    ).toHaveValue('3');
    expect(box).toHaveValue('');
    expect(results).not.toBeVisible();

    search = gate();
    await user.type(box, 'roller{Enter}');
    await user.type(box, 'x');
    search.open();
    const roller9 = await screen.findByRole('option', { name: /ROL-9/ });
    expect(box).toHaveValue('x');
    await user.pointer({ keys: '[MouseLeft>]', target: roller9 });
    await screen.findByRole('listitem', { name: 'Asian Paints Roller 9 inch' });
  });
});

/** A response held back until the test lets it through. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('PosPage: the customer', () => {
  it('finds a customer by mobile with their credit and points, and goes back to walk-in', async () => {
    const { user, requests } = renderPos({
      'GET /parties': () =>
        json({ items: [party(), party({ id: 'other', phone: '+919999999999' })], total: 2 }),
      'GET /parties/:id/overview': () =>
        json(
          overview(credit('active', 2_000_000), {
            account: { id: 'la', status: 'active', assignedTo: null, createdAt: '' },
            balance: 1250,
            totalEarned: 0,
            totalRedeemed: 0,
            tier: null,
            nextTier: null,
            nextExpiry: null,
          }),
        ),
    });
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await user.click(screen.getByRole('button', { name: 'Find customer' }));
    const mobile = screen.getByRole('textbox', { name: 'Customer mobile' });
    await user.type(mobile, '98480 12345{Enter}');
    expect(await screen.findByText('Ravi Contractor · +919848012345')).toBeInTheDocument();
    expect(await screen.findByText('Credit available: ₹20,000.00')).toBeInTheDocument();
    expect(screen.getByText('Loyalty: 1,250 points')).toBeInTheDocument();
    expect(requests.find((request) => request.path === '/parties')?.query.get('q')).toBe(
      '9848012345',
    );

    // Part on credit: the rest goes on the account.
    await user.keyboard('{F8}');
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    const amount = within(dialog).getByRole('textbox', { name: 'Amount of payment 1' });
    await user.clear(amount);
    await user.type(amount, '450');
    await user.click(within(dialog).getByRole('button', { name: 'Remove payment 2' }));
    expect(
      within(dialog).getByText('₹10,000.00 goes on Ravi Contractor’s account'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    await screen.findByRole('dialog', { name: 'Bill AMP/26-27/000001 issued' });
    expect(
      requests.find((request) => request.method === 'POST' && request.path === '/invoices')?.body,
    ).toMatchObject({ partyId: 'party-ravi' });
    await user.click(screen.getByRole('button', { name: 'New sale' }));
    expect(await screen.findByText('Walk-in customer')).toBeInTheDocument();
  });

  it('refuses more than the credit left, and a customer on hold owes nothing', async () => {
    let status = 'active';
    const { user } = renderPos({
      'GET /parties': () =>
        json({
          items: [party({ gstin: '36AABCS1429B1ZV', phone: null, alternatePhone: '9848012345' })],
          total: 1,
        }),
      'GET /parties/:id/overview': () => json(overview(credit(status, 100_000), null)),
    });
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await user.type(screen.getByRole('textbox', { name: 'Customer mobile' }), '9848012345{Enter}');
    expect(await screen.findByText('Credit available: ₹1,000.00')).toBeInTheDocument();
    expect(screen.getByText('Ravi Contractor')).toBeInTheDocument();
    // The party's GSTIN makes it a B2B bill, with the buyer's details open.
    expect(screen.getByRole('textbox', { name: 'Buyer GSTIN (B2B)' })).toHaveValue(
      '36AABCS1429B1ZV',
    );
    expect(screen.getByRole('group', { name: 'Buyer details' })).toBeInTheDocument();
    await user.keyboard('{F8}');
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    const amount = within(dialog).getByRole('textbox', { name: 'Amount of payment 1' });
    await user.clear(amount);
    await user.type(amount, '0');
    await user.click(within(dialog).getByRole('button', { name: 'Remove payment 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
    expect(
      within(dialog).getByText('Ravi Contractor does not have enough credit for ₹10,450.00.'),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');

    status = 'on_hold';
    await user.click(screen.getByRole('button', { name: 'Walk-in instead' }));
    await user.type(screen.getByRole('textbox', { name: 'Customer mobile' }), '9848012345');
    await user.click(screen.getByRole('button', { name: 'Find customer' }));
    expect(await screen.findByText('Ravi Contractor')).toBeInTheDocument();
  });

  it('shows on-hold and no credit, several matches, no match and a failed search', async () => {
    let answer: () => FakeAnswer = () => json({ items: [], total: 0 });
    const { user } = renderPos({
      'GET /parties': () => answer(),
      'GET /parties/:id/overview': (request) =>
        json(
          overview(request.path.includes('hold') ? credit('on_hold', 0) : credit('none', 0), {
            account: null,
            balance: 0,
          }),
        ),
    });
    await scanBox();
    const mobile = screen.getByRole('textbox', { name: 'Customer mobile' });
    await user.click(screen.getByRole('button', { name: 'Find customer' }));
    await user.type(mobile, '9848012345{Enter}');
    expect(
      await screen.findByText('No customer with this mobile; the bill stays walk-in.'),
    ).toBeInTheDocument();
    answer = () => json({ message: 'Search is down' }, 500);
    await user.type(mobile, '{Enter}');
    expect(await screen.findByText('Search is down')).toBeInTheDocument();
    answer = () =>
      json({
        items: [
          party({ id: 'hold', displayName: 'Hold Traders' }),
          party({
            id: 'none',
            displayName: 'Cash Only',
            phone: null,
            alternatePhone: '98480 12345',
          }),
        ],
        total: 2,
      });
    await user.type(mobile, '{Enter}');
    const several = await screen.findByRole('group', {
      name: 'More than one customer has this number',
    });
    await user.click(within(several).getByRole('button', { name: 'Choose Hold Traders' }));
    expect(await screen.findByText('Credit on hold')).toBeInTheDocument();
    // The list went with the button that was pressed: the focus moves to "Walk-in instead".
    const walkIn = screen.getByRole('button', { name: 'Walk-in instead' });
    await waitFor(() => {
      expect(walkIn).toHaveFocus();
    });
    await user.click(walkIn);
    // And back to the mobile number when that button goes.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Customer mobile' })).toHaveFocus();
    });
    await user.keyboard('9848012345{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Choose Cash Only' }));
    expect(await screen.findByText('No credit: pay in full')).toBeInTheDocument();
  });

  it('takes a B2B GSTIN and the buyer details a big bill needs', async () => {
    const { user, invoices } = renderPos();
    const box = await scanBox();
    await user.type(box, '6*APX-20L{Enter}');
    expect(
      await screen.findByText('Required on a bill of ₹50,000 or more to a buyer without a GSTIN'),
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Buyer name' }), 'Sita Rao');
    await user.type(screen.getByRole('textbox', { name: 'Buyer address' }), 'Ameerpet');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Buyer state' }), '36');
    const gstin = screen.getByRole('textbox', { name: 'Buyer GSTIN (B2B)' });
    await user.type(gstin, '37aabcs1429b1zx');
    expect(screen.getByText('Enter a valid GSTIN (check for typos)')).toBeInTheDocument();
    await user.clear(gstin);
    await user.type(gstin, '37aabcs1429b1zt');
    expect(screen.getByText('IGST 18%')).toBeInTheDocument();
    await waitFor(() => {
      expect([...invoices.drafts.values()][0]?.buyer).toEqual({
        partyId: null,
        name: 'Sita Rao',
        gstin: '37AABCS1429B1ZT',
        address: 'Ameerpet',
        stateCode: '36',
      });
    });
  });
});

describe('PosPage: held bills and stores', () => {
  it('holds with F4, resumes from the tray and discards', async () => {
    const { user, invoices } = renderPos();
    const box = await scanBox();
    await user.keyboard('{F4}');
    expect(await screen.findByText('The bill is empty')).toBeInTheDocument();
    await user.type(box, 'APX-20L{Enter}');
    await screen.findByRole('listitem', { name: APEX_NAME });
    await user.keyboard('{F4}');
    expect(await screen.findByText('Bill held')).toBeInTheDocument();
    expect(screen.getByText('Scan or search a product to start the bill.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Held (1)' }));

    // Start another bill, then resume the first: the second is held in its place.
    await user.keyboard('{Escape}');
    await user.click(box);
    await user.keyboard('PUT-20KG{Enter}');
    await screen.findByRole('listitem', { name: PUTTY_NAME });
    await user.click(screen.getByRole('button', { name: 'Held (1)' }));
    let tray = await screen.findByRole('dialog', { name: 'Held bills' });
    expect(within(tray).getByText('₹10,450.00')).toBeInTheDocument();
    await user.click(
      within(tray).getByRole('button', { name: 'Resume the bill of Walk-in customer' }),
    );
    expect(await screen.findByRole('listitem', { name: APEX_NAME })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: PUTTY_NAME })).toBeNull();
    expect(invoices.drafts.size).toBe(2);

    await user.click(await screen.findByRole('button', { name: 'Held (1)' }));
    tray = await screen.findByRole('dialog', { name: 'Held bills' });
    await user.click(
      within(tray).getByRole('button', { name: 'Discard the bill of Walk-in customer' }),
    );
    expect(await within(tray).findByText('Held bill discarded')).toBeInTheDocument();
    expect(within(tray).getByText('No bills are held at this store.')).toBeInTheDocument();
    expect(invoices.drafts.size).toBe(1);
  });

  it('names drafts held elsewhere, and reports a failed resume or discard', async () => {
    const elsewhere = document({
      id: 'far-1',
      buyer: { partyId: null, name: 'Gopal', gstin: null, address: null, stateCode: null },
    });
    const { user } = renderPos({
      'GET /invoices': () =>
        json({
          items: [
            {
              id: 'far-1',
              kind: 'invoice',
              status: 'draft',
              storeId: AMP.id,
              number: null,
              issuedOn: null,
              buyerName: 'Gopal',
              totalPaise: 0,
            },
            {
              id: 'far-2',
              kind: 'invoice',
              status: 'draft',
              storeId: AMP.id,
              number: null,
              issuedOn: null,
              buyerName: null,
              totalPaise: 0,
            },
          ],
          total: 2,
        }),
      'GET /invoices/:id': (request) =>
        request.path.endsWith('far-1') ? json(elsewhere) : json({ message: 'Gone' }, 404),
      'DELETE /invoices/:id': () => json({ message: 'Cannot discard now' }, 409),
    });
    await scanBox();
    await user.click(await screen.findByRole('button', { name: 'Held (2)' }));
    const tray = await screen.findByRole('dialog', { name: 'Held bills' });
    expect(within(tray).getAllByText('Total on resume')).toHaveLength(2);
    await user.click(
      within(tray).getByRole('button', { name: 'Discard the bill of Walk-in customer' }),
    );
    expect(await within(tray).findByText('Cannot discard now')).toBeInTheDocument();
    await user.click(
      within(tray).getByRole('button', { name: 'Resume the bill of Walk-in customer' }),
    );
    expect(await screen.findByText('Gone')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Held (2)' }));
    await user.click(await screen.findByRole('button', { name: 'Resume the bill of Gopal' }));
    expect(
      await screen.findByRole('listitem', { name: 'Item 1 (held on another device)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('₹10,450.00 each')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Buyer name' })).toHaveValue('Gopal');
  });

  it('picks up the bill left on the counter after a reload', async () => {
    localStorage.setItem('pos.current.store-amp', 'kept-1');
    localStorage.setItem(
      'pos.bill.kept-1',
      JSON.stringify({
        items: [item()],
        buyer: {
          partyId: null,
          partyName: null,
          phone: null,
          name: '',
          gstin: '',
          address: '',
          stateCode: '',
        },
        payablePaise: 1,
      }),
    );
    renderPos({
      'GET /invoices/:id': () =>
        json(document({ id: 'kept-1', lines: [draftLine({ quantity: 2 })] })),
    });
    expect(await screen.findByRole('listitem', { name: APEX_NAME })).toBeInTheDocument();
    expect(total()).toBe('₹20,900.00');
  });

  it('starts fresh when the kept bill was issued or is gone', async () => {
    localStorage.setItem('pos.current.store-amp', 'done-1');
    renderPos({ 'GET /invoices/:id': () => json(document({ id: 'done-1', status: 'issued' })) });
    expect(await scanBox()).toBeInTheDocument();
    expect(localStorage.getItem('pos.current.store-amp')).toBeNull();
  });

  it('switches stores (not mid-bill), leaving godowns out', async () => {
    localStorage.setItem('pos.current.store-amp', 'gone');
    const { user } = renderPos();
    const box = await scanBox();
    const storeSelect = screen.getByRole('combobox', { name: 'Store' });
    expect(
      within(storeSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['AMP · Ameerpet', 'KPH · Kukatpally']);
    await user.type(box, 'APX-20L{Enter}');
    await screen.findByRole('listitem', { name: APEX_NAME });
    expect(storeSelect).toBeDisabled();
    expect(screen.getByText('Finish or hold this bill to switch stores')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Remove ${APEX_NAME}` }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Store' }), KPH.id);
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Store' })).toHaveValue(KPH.id);
    });
    expect(localStorage.getItem('pos.store')).toBe(KPH.id);
  });

  it('keeps the focus on the bill when a line is removed with its button', async () => {
    const { user } = renderPos();
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await screen.findByRole('listitem', { name: APEX_NAME });
    await user.type(box, 'PUT-20KG{Enter}');
    await screen.findByRole('listitem', { name: PUTTY_NAME });

    // The putty line takes the apex line's place, and its Remove button the focus.
    await user.click(screen.getByRole('button', { name: `Remove ${APEX_NAME}` }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Remove ${PUTTY_NAME}` })).toHaveFocus();
    });
    // The last line gone, the scan box is ready for the next product.
    await user.click(screen.getByRole('button', { name: `Remove ${PUTTY_NAME}` }));
    await waitFor(() => {
      expect(box).toHaveFocus();
    });
  });

  it('moves the focus up to the line above when the bottom line is removed', async () => {
    const { user } = renderPos();
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    await user.type(box, 'PUT-20KG{Enter}');
    await screen.findByRole('listitem', { name: PUTTY_NAME });
    await user.click(screen.getByRole('button', { name: `Remove ${PUTTY_NAME}` }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Remove ${APEX_NAME}` })).toHaveFocus();
    });
  });

  it('shows one store by name, warns when it is not registered, and the closed register', async () => {
    renderPos(
      {
        'GET /stores': () => json([{ ...AMP, gstin: null }, GODOWN]),
        'GET /register-sessions': () => json({ items: [], total: 0 }),
      },
      profile([...CASHIER_POS.permissions], { allStores: true }),
    );
    expect(await screen.findByText('AMP · Ameerpet')).toBeInTheDocument();
    expect(screen.getByText(/This store is not registered for GST/)).toBeInTheDocument();
    expect(await screen.findByText('Register closed')).toBeInTheDocument();
  });

  it('says so when the member works at no store, and when the counter cannot load', async () => {
    renderPos({ 'GET /stores': () => json([GODOWN]) }, OWNER);
    expect(
      await screen.findByText('You do not work at a store yet. Ask an owner to add you to one.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Counter sale', level: 1 })).toBeInTheDocument();
  });

  it('reports a counter that cannot load its tax rates', async () => {
    renderPos({ 'GET /tax-categories/options': () => json({ message: 'Down' }, 500) });
    expect(await screen.findByText('Could not open the counter')).toBeInTheDocument();
  });

  it('shows a failed save with "Save again", and F8 waits for the ways to pay', async () => {
    let fail = true;
    let release: (answer: FakeAnswer) => void = () => undefined;
    const { user } = renderPos({
      'POST /invoices': () =>
        fail ? json({ message: 'Server busy' }, 503) : json(document({ id: 'ok-1' }), 201),
      'GET /payment-modes': () =>
        new Promise<FakeAnswer>((resolve) => {
          release = resolve;
        }) as unknown as FakeAnswer,
    });
    const box = await scanBox();
    await user.type(box, 'APX-20L{Enter}');
    expect(await screen.findByText('Not saved: Server busy')).toBeInTheDocument();
    await user.keyboard('{F4}');
    await user.keyboard('{F8}');
    expect(screen.queryByRole('dialog')).toBeNull();
    release(json(MODES));
    await waitFor(async () => {
      await user.keyboard('{F8}');
      expect(screen.getByRole('dialog', { name: 'Payment' })).toBeInTheDocument();
    });
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save again' }));
    expect(await screen.findByText('Not saved: Server busy')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Save again' }));
    expect(await screen.findByText('Bill saved')).toBeInTheDocument();
  });
});
