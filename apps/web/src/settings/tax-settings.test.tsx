import type { GstRegistrations, TaxCategoryView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { parseRate } from './TaxSettingsPage.js';

const HYD_GSTIN = '36AABCS1429B1ZV';

const REGISTRATIONS: GstRegistrations = {
  legalName: 'Sharma Paints & Hardware',
  pan: 'AABCS1429B',
  stores: [
    {
      storeId: 'store-hyd',
      code: 'HYD',
      name: 'Ameerpet',
      registrationType: 'regular',
      stateCode: '36',
      gstin: HYD_GSTIN,
      legalName: 'Sharma Paints & Hardware',
      tradeName: 'Sharma Paints',
      addressLine: 'Main Road',
      city: 'Hyderabad',
      pincode: '500016',
    },
    {
      storeId: 'store-vjw',
      code: 'VJW',
      name: 'Vijayawada',
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

const CATEGORIES: TaxCategoryView[] = [
  {
    id: 'tax-paints',
    key: 'paints',
    name: 'Paints 18%',
    isDefault: true,
    isActive: true,
    currentRateBps: 1800,
    rates: [
      { id: 'r1', rateBps: 2800, effectiveFrom: '2017-07-01', effectiveTo: '2018-07-26' },
      { id: 'r2', rateBps: 1800, effectiveFrom: '2018-07-27', effectiveTo: null },
    ],
  },
  {
    id: 'tax-later',
    key: null,
    name: 'Starts later 5%',
    isDefault: false,
    isActive: true,
    currentRateBps: null,
    rates: [{ id: 'r3', rateBps: 500, effectiveFrom: '2030-01-01', effectiveTo: null }],
  },
  {
    id: 'tax-old',
    key: null,
    name: 'Old 12%',
    isDefault: false,
    isActive: false,
    currentRateBps: 1200,
    rates: [{ id: 'r4', rateBps: 1200, effectiveFrom: '2017-07-01', effectiveTo: null }],
  },
];

const ACCOUNTANT = profile(['tax:read', 'stores:read'], {
  role: { key: 'accountant', name: 'Accountant' },
});

function renderTax(routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path: '/settings/tax',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /gst-registrations': () => json(REGISTRATIONS),
      'GET /tax-categories': () => json(CATEGORIES),
      ...routes,
    },
  });
}

const card = async (title: string) =>
  found((await screen.findByRole('heading', { name: title })).closest('section'));

describe('parseRate', () => {
  it.each([
    ['18', 1800],
    ['0.25', 25],
    [' 100 ', 10_000],
    ['0', 0],
    ['101', null],
    ['1.234', null],
    ['eighteen', null],
  ])('reads %s as %s', (text, expected) => {
    expect(parseRate(text)).toBe(expected);
  });
});

describe('TaxSettingsPage', { timeout: 30_000 }, () => {
  it('saves the business legal name and shows the PAN', async () => {
    let attempts = 0;
    const bodies: unknown[] = [];
    const { user } = renderTax({
      'PUT /gst-registrations/business': (request) => {
        attempts += 1;
        bodies.push(request.body);
        return attempts === 1
          ? json({ message: 'The database is busy' }, 503)
          : json({ ...REGISTRATIONS, legalName: null });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Tax & GST', level: 1 })).toBeVisible();
    const business = await card('Business');
    expect(within(business).getByRole('textbox', { name: 'PAN' })).toHaveValue('AABCS1429B');
    const legalName = within(business).getByRole('textbox', { name: /Legal name/ });
    expect(legalName).toHaveValue('Sharma Paints & Hardware');
    await user.click(within(business).getByRole('button', { name: 'Save legal name' }));
    expect(await within(business).findByText('The database is busy')).toBeVisible();
    await user.clear(legalName);
    await user.click(within(business).getByRole('button', { name: 'Save legal name' }));
    expect(await screen.findByText('Legal name saved')).toBeVisible();
    expect(bodies).toEqual([{ legalName: 'Sharma Paints & Hardware' }, { legalName: null }]);
  });

  it('lists the registrations and checks one before saving it', async () => {
    const bodies: unknown[] = [];
    const { user } = renderTax({
      'PUT /gst-registrations/stores/:id': (request) => {
        bodies.push(request.body);
        return json(REGISTRATIONS);
      },
    });
    const registrations = await screen.findByRole('heading', { name: 'GST registrations' });
    const list = found(registrations.closest('section'));
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `HYD · Ameerpet Regular36 · Telangana · ${HYD_GSTIN}Edit`,
      'VJW · Vijayawada Not registeredNo state yetEdit',
    ]);

    await user.click(
      within(list).getByRole('button', { name: 'Edit the GST registration of Vijayawada' }),
    );
    let dialog = screen.getByRole('dialog');
    const save = () =>
      user.click(within(dialog).getByRole('button', { name: 'Save registration' }));
    await save();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a state');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /State/ }),
      '37 · Andhra Pradesh',
    );
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Registration type' }),
      'Composition',
    );
    await save();
    expect(within(dialog).getByText('Enter the GSTIN of this registration')).toBeVisible();
    const gstin = within(dialog).getByRole('textbox', { name: /GSTIN/ });
    await user.type(gstin, '37AABCS1429B1Z0');
    await save();
    expect(within(dialog).getByText('Enter a valid GSTIN (check for typos)')).toBeVisible();
    await user.clear(gstin);
    await user.type(gstin, HYD_GSTIN.toLowerCase());
    await save();
    expect(within(dialog).getByText('This GSTIN belongs to another state')).toBeVisible();
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /State/ }),
      '36 · Telangana',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Legal name' }),
      'Sharma Paints LLP',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Trade name' }), ' Sharma ');
    await user.type(within(dialog).getByRole('textbox', { name: 'PIN code' }), '0123');
    await save();
    expect(within(dialog).getByText('Enter a 6-digit PIN code')).toBeVisible();
    await user.clear(within(dialog).getByRole('textbox', { name: 'PIN code' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'PIN code' }), '500016');
    await save();
    expect(await screen.findByText('Registration saved')).toBeVisible();

    await user.click(
      within(list).getByRole('button', { name: 'Edit the GST registration of Ameerpet' }),
    );
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: /GSTIN/ })).toHaveValue(HYD_GSTIN);
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Registration type' }),
      'Not registered',
    );
    expect(within(dialog).queryByRole('textbox', { name: /GSTIN/ })).toBeNull();
    await user.clear(within(dialog).getByRole('textbox', { name: 'City' }));
    await save();
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies).toEqual([
      {
        registrationType: 'composition',
        stateCode: '36',
        gstin: HYD_GSTIN,
        legalName: 'Sharma Paints LLP',
        tradeName: 'Sharma',
        pincode: '500016',
      },
      {
        registrationType: 'unregistered',
        stateCode: '36',
        addressLine: 'Main Road',
        pincode: '500016',
      },
    ]);
  });

  it('shows each category with its rates, and adds categories and rates', async () => {
    const posts: { path: string; body: unknown }[] = [];
    const { user } = renderTax({
      'POST /tax-categories': (request) => {
        posts.push({ path: request.path, body: request.body });
        return json(CATEGORIES[0], 201);
      },
      'POST /tax-categories/:id/rates': (request) => {
        posts.push({ path: request.path, body: request.body });
        return json(CATEGORIES[0], 201);
      },
    });
    const heading = await screen.findByRole('heading', { name: 'Tax categories' });
    const section = found(heading.closest('section'));
    expect(within(section).getByRole('list', { name: 'Rates of Paints 18%' }).textContent).toBe(
      '28% · 1 Jul 2017 to 26 Jul 201818% · From 27 Jul 2018',
    );
    expect(within(section).getByText('GST 18% today')).toBeVisible();
    expect(within(section).getByText('Not in force yet')).toBeVisible();
    expect(within(section).getByText('Default')).toBeVisible();
    expect(within(section).getByText('Inactive')).toBeVisible();
    // An inactive category takes no new rate; the default cannot be switched off.
    const paints = within(section).getByRole('group', { name: 'Actions for Paints 18%' });
    expect(
      within(paints)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['New rate']);
    const old = within(section).getByRole('group', { name: 'Actions for Old 12%' });
    expect(
      within(old)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Activate']);

    await user.click(within(section).getByRole('button', { name: '+ Tax category' }));
    let dialog = screen.getByRole('dialog', { name: 'New tax category' });
    const save = () => user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await save();
    expect(within(dialog).getByText('Use 2 to 80 characters')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Adhesives 18%');
    await user.type(within(dialog).getByRole('textbox', { name: /GST rate/ }), '18.555');
    await save();
    expect(
      within(dialog).getByText('Enter a rate from 0 to 100, with at most 2 decimals'),
    ).toBeVisible();
    await user.clear(within(dialog).getByRole('textbox', { name: /GST rate/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /GST rate/ }), '18');
    const starts = within(dialog).getByLabelText(/Starts on/);
    await user.clear(starts);
    await save();
    expect(within(dialog).getByText('Choose a date')).toBeVisible();
    await user.type(starts, '2030-04-01');
    await save();
    expect(await screen.findByText('Tax category added')).toBeVisible();

    await user.click(within(paints).getByRole('button', { name: 'New rate' }));
    dialog = screen.getByRole('dialog', { name: 'New rate for Paints 18%' });
    expect(within(dialog).queryByRole('textbox', { name: /Name/ })).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: /GST rate/ }), '12');
    await user.clear(within(dialog).getByLabelText(/Starts on/));
    await user.type(within(dialog).getByLabelText(/Starts on/), '2030-04-01');
    await save();
    expect(await screen.findByText('New rate saved')).toBeVisible();
    expect(posts).toEqual([
      {
        path: '/tax-categories',
        body: { name: 'Adhesives 18%', rateBps: 1800, effectiveFrom: '2030-04-01' },
      },
      {
        path: '/tax-categories/tax-paints/rates',
        body: { rateBps: 1200, effectiveFrom: '2030-04-01' },
      },
    ]);
  });

  it('moves the default and switches categories on and off, saying when that fails', async () => {
    const bodies: { path: string; body: unknown }[] = [];
    const { user } = renderTax({
      'PATCH /tax-categories/:id': (request) => {
        bodies.push({ path: request.path, body: request.body });
        return bodies.length === 3
          ? json({ message: 'Make another category the default first' }, 400)
          : json(CATEGORIES[1]);
      },
    });
    const later = await screen.findByRole('group', { name: 'Actions for Starts later 5%' });
    await user.click(within(later).getByRole('button', { name: 'Make default' }));
    expect(await screen.findByText('Tax category updated')).toBeVisible();
    await user.click(within(later).getByRole('button', { name: 'Deactivate' }));
    const old = screen.getByRole('group', { name: 'Actions for Old 12%' });
    await user.click(within(old).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Make another category the default first')).toBeVisible();
    expect(bodies).toEqual([
      { path: '/tax-categories/tax-later', body: { isDefault: true } },
      { path: '/tax-categories/tax-later', body: { isActive: false } },
      { path: '/tax-categories/tax-old', body: { isActive: true } },
    ]);
  });

  it('is read-only for members who may only see it', async () => {
    renderTax({
      'GET /auth/me': () => json(ACCOUNTANT),
      'GET /gst-registrations': () => json({ legalName: null, pan: null, stores: [] }),
    });
    expect(await screen.findByText('Only owners and admins can change these.')).toBeVisible();
    expect(await screen.findByText('Add a store first.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'PAN' })).toHaveValue('Filled from the first GSTIN');
    expect(screen.getByRole('textbox', { name: /Legal name/ })).toBeDisabled();
    expect(await screen.findByText('Paints 18%')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Save|Edit|New rate|Tax category/ })).toBeNull();
  });
});
