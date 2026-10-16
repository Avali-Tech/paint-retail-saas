import type { GstRegistrations } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Store } from '../api/stock.js';
import { OWNER, json, profile, type FakeRequest } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { isStoreCodeUsable } from './StoresPage.js';

const HYD_GSTIN = '36AABCS1429B1ZV';

const HYD: Store = {
  id: 'store-hyd',
  name: 'Ameerpet',
  code: 'HYD',
  type: 'store',
  city: 'Hyderabad',
  state: 'Telangana',
  gstin: HYD_GSTIN,
  isActive: true,
};
const PUN: Store = {
  id: 'store-pun',
  name: 'Pune Godown',
  code: 'PUN',
  type: 'godown',
  city: null,
  state: null,
  gstin: null,
  isActive: false,
};

const REGISTRATIONS: GstRegistrations = {
  legalName: 'Sharma Paints',
  pan: 'AABCS1429B',
  stores: [
    {
      storeId: 'store-hyd',
      code: 'HYD',
      name: 'Ameerpet',
      registrationType: 'regular',
      stateCode: '36',
      gstin: HYD_GSTIN,
      legalName: 'Sharma Paints',
      tradeName: null,
      addressLine: 'Main Road',
      city: 'Hyderabad',
      pincode: '500016',
    },
    {
      storeId: 'store-pun',
      code: 'PUN',
      name: 'Pune Godown',
      registrationType: 'unregistered',
      stateCode: null,
      gstin: null,
      legalName: null,
      tradeName: null,
      addressLine: null,
      city: null,
      pincode: null,
    },
  ],
};

const STORE_MANAGER = profile(['stores:read', 'stores:manage'], {
  role: { key: 'store_manager', name: 'Store manager' },
});

function stores(options: { profile?: typeof OWNER; list?: Store[] } = {}) {
  const sent: FakeRequest[] = [];
  const keep = (request: FakeRequest, answer: Store) => {
    sent.push(request);
    return json(answer);
  };
  const rendered = renderApp({
    path: '/settings/stores',
    routes: {
      'GET /auth/me': () => json(options.profile ?? OWNER),
      'GET /stores': () => json(options.list ?? [HYD, PUN]),
      'GET /gst-registrations': () => json(REGISTRATIONS),
      'POST /stores': (request) => keep(request, { ...HYD, id: 'store-new' }),
      'PATCH /stores/:id': (request) =>
        request.path.endsWith('store-pun') && (request.body as Store).isActive
          ? json(
              {
                message:
                  'The Trial plan allows 5 active stores. The owner can upgrade the plan under Billing.',
              },
              403,
            )
          : keep(request, HYD),
      'PUT /gst-registrations/stores/:id': (request) => {
        sent.push(request);
        return json(REGISTRATIONS);
      },
    },
  });
  return { ...rendered, sent };
}

describe('isStoreCodeUsable', () => {
  it('takes codes whose invoice, note and voucher numbers fit 16 characters', () => {
    expect(isStoreCodeUsable('HYD1')).toBe(true);
    expect(isStoreCodeUsable('AB-123')).toBe(true);
    expect(isStoreCodeUsable('ABCDEF')).toBe(false);
    expect(isStoreCodeUsable('A')).toBe(false);
    expect(isStoreCodeUsable('HY D')).toBe(false);
  });
});

describe('StoresPage (PO-102)', { timeout: 30_000 }, () => {
  it('lists the stores with their kind, state and GSTIN, closed ones marked', async () => {
    stores();
    const list = await screen.findByRole('region', { name: 'Stores' });
    const [hyd, pun] = within(list).getAllByRole('listitem');
    expect(hyd).toHaveTextContent(`HYD · Ameerpet Store 36 · Telangana · ${HYD_GSTIN} · Hyderabad`);
    expect(pun).toHaveTextContent('PUN · Pune Godown Godown ClosedNo state yet');
    expect(
      screen.getByText(/Owners and admins work at every store and see a new one at once/),
    ).toBeVisible();
  });

  it('adds a store with its GST registration in one go, after checking the form', async () => {
    const { user, sent } = stores();
    await user.click(await screen.findByRole('button', { name: 'New store' }));
    const dialog = screen.getByRole('dialog', { name: 'New store' });
    const submit = within(dialog).getByRole('button', { name: 'Add store' });
    const problem = async (message: string) => {
      await user.click(submit);
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    };

    await problem('Use 2 to 120 characters');
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Kukatpally');
    await user.type(within(dialog).getByRole('textbox', { name: /^Code/ }), 'kukat1');
    await problem('Use up to 5 letters or digits (dashes are allowed)');
    await user.clear(within(dialog).getByRole('textbox', { name: /^Code/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /^Code/ }), 'kkp');
    await problem('Choose a state');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'State' }), '36');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Registration type' }),
      'regular',
    );
    await problem('Enter a valid GSTIN (check for typos)');
    await user.type(within(dialog).getByRole('textbox', { name: 'GSTIN' }), '27AAPFU0939F1ZV');
    await problem('This GSTIN belongs to another state');
    await user.clear(within(dialog).getByRole('textbox', { name: 'GSTIN' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'GSTIN' }), HYD_GSTIN);
    await user.type(within(dialog).getByRole('textbox', { name: 'PIN code' }), '123');
    await problem('Enter a 6-digit PIN code');
    await user.clear(within(dialog).getByRole('textbox', { name: 'PIN code' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'PIN code' }), '500072');
    await user.type(within(dialog).getByRole('textbox', { name: 'Street and area' }), 'KPHB');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Kind' }), 'godown');
    await user.click(submit);

    expect(await screen.findByText('Store added')).toBeVisible();
    expect(sent.at(-1)?.body).toEqual({
      name: 'Kukatpally',
      code: 'KKP',
      type: 'godown',
      registration: {
        registrationType: 'regular',
        stateCode: '36',
        gstin: HYD_GSTIN,
        addressLine: 'KPHB',
        pincode: '500072',
      },
    });
  });

  it('adds an unregistered store with just its state', async () => {
    const { user, sent } = stores();
    await user.click(await screen.findByRole('button', { name: 'New store' }));
    const dialog = screen.getByRole('dialog', { name: 'New store' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Back godown');
    await user.type(within(dialog).getByRole('textbox', { name: /^Code/ }), 'BG');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'State' }), '36');
    await user.type(within(dialog).getByRole('textbox', { name: 'City' }), 'Hyderabad');
    await user.click(within(dialog).getByRole('button', { name: 'Add store' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({
        name: 'Back godown',
        code: 'BG',
        type: 'store',
        registration: { registrationType: 'unregistered', stateCode: '36', city: 'Hyderabad' },
      });
    });
  });

  it('renames a store and changes its kind; the code is read-only', async () => {
    const { user, sent } = stores();
    await user.click(await screen.findByRole('button', { name: 'Edit Ameerpet' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit HYD · Ameerpet' });
    expect(within(dialog).getByRole('textbox', { name: 'Code' })).toHaveAttribute('readonly');
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'A');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Use 2 to 120 characters')).toBeVisible();
    await user.type(name, 'meerpet Main');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Kind' }), 'godown');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Store saved')).toBeVisible();
    expect(sent.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/stores/store-hyd',
      body: { name: 'Ameerpet Main', type: 'godown' },
    });
  });

  it('closes a store after saying what that means, and explains a refused reopen', async () => {
    const { user, sent } = stores();
    await user.click(await screen.findByRole('button', { name: 'Close Ameerpet' }));
    const dialog = screen.getByRole('dialog', { name: 'Close Ameerpet?' });
    expect(within(dialog).getByText(/Its stock, documents and history stay/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Close store' }));
    expect(await screen.findByText('Store closed')).toBeVisible();
    expect(sent.at(-1)?.body).toEqual({ isActive: false });

    await user.click(screen.getByRole('button', { name: 'Reopen Pune Godown' }));
    expect(
      await screen.findByText(
        'The Trial plan allows 5 active stores. The owner can upgrade the plan under Billing.',
      ),
    ).toBeVisible();
  });

  it('reopens a closed store', async () => {
    const { user, sent } = stores({ list: [HYD, { ...PUN, id: 'store-old', name: 'Old Shop' }] });
    await user.click(await screen.findByRole('button', { name: 'Reopen Old Shop' }));
    expect(await screen.findByText('Store reopened')).toBeVisible();
    expect(sent.at(-1)).toMatchObject({ path: '/stores/store-old', body: { isActive: true } });
  });

  it('edits the GST registration and address with the Tax & GST dialog', async () => {
    const { user, sent } = stores();
    await user.click(
      await screen.findByRole('button', { name: 'GST registration and address of Ameerpet' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'GST registration: HYD · Ameerpet' });
    await user.clear(within(dialog).getByRole('textbox', { name: 'City' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'City' }), 'Secunderabad');
    await user.click(within(dialog).getByRole('button', { name: 'Save registration' }));
    expect(await screen.findByText('Registration saved')).toBeVisible();
    expect(sent.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/gst-registrations/stores/store-hyd',
      body: { city: 'Secunderabad' },
    });
  });

  it('without tax:manage, adds a store without its registration', async () => {
    const { user, sent, requests } = stores({ profile: STORE_MANAGER });
    await screen.findByRole('region', { name: 'Stores' });
    expect(screen.queryByRole('button', { name: /^GST registration and address/ })).toBeNull();
    expect(requests.some((request) => request.path === '/gst-registrations')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'New store' }));
    const dialog = screen.getByRole('dialog', { name: 'New store' });
    expect(within(dialog).queryByRole('combobox', { name: 'State' })).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Annexe');
    await user.type(within(dialog).getByRole('textbox', { name: /^Code/ }), 'ANX');
    await user.click(within(dialog).getByRole('button', { name: 'Add store' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ name: 'Annexe', code: 'ANX', type: 'store' });
    });
  });

  it('says when there are no stores yet', async () => {
    stores({ list: [] });
    expect(await screen.findByText('No stores yet. Add the first one.')).toBeVisible();
  });

  it('shows a failure', async () => {
    renderApp({
      path: '/settings/stores',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /stores': () => json({ message: 'Database down' }, 503),
        'GET /gst-registrations': () => json(REGISTRATIONS),
      },
    });
    expect(await screen.findByText('Could not load the stores')).toBeVisible();
  });
});
