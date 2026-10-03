import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { conflictOf } from '../api/conflict.js';
import { ApiError } from '../api/errors.js';
import { CASHIER, OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import {
  BARE_OVERVIEW,
  BARE_PARTY,
  OVERVIEW,
  PARTY,
  STORES,
} from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { initialValues, toInput } from './PartyFormPage.js';

const location = () => screen.getByTestId('location').textContent;
const box = (name: string) => screen.getByRole('textbox', { name });

function renderForm(path: string, routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /stores': () => json(STORES),
      'GET /parties/:id/overview': () => json(OVERVIEW),
      ...routes,
    },
  });
}

describe('initialValues and toInput', () => {
  it('starts a new customer as a person with the customer role', () => {
    const values = initialValues(null);
    expect(values).toMatchObject({ kind: 'person', roles: ['customer'], isActive: true });
    expect(toInput({ ...values, displayName: ' Ramesh ' }, false)).toEqual({
      kind: 'person',
      displayName: 'Ramesh',
      tags: [],
      roles: ['customer'],
      customer: { customerType: 'retail', preferredContact: 'phone' },
    });
  });

  it('sends every field when editing, null for emptied ones', () => {
    const values = initialValues(PARTY);
    expect(values.tags).toBe('builder, vip');
    const input = toInput({ ...values, legalName: '  ', gstin: '', roles: ['painter'] }, true);
    expect(input).toMatchObject({
      legalName: null,
      gstin: null,
      pan: 'AABCU9603R',
      roles: ['painter'],
      isActive: true,
    });
    expect(input).not.toHaveProperty('customer');
  });
});

describe('conflictOf', () => {
  it('picks out 409 answers only', () => {
    const conflict = new ApiError(409, 'Duplicate');
    expect(conflictOf(conflict)).toBe(conflict);
    expect(conflictOf(new ApiError(400, 'Bad'))).toBeNull();
    expect(conflictOf(new Error('boom'))).toBeNull();
  });
});

describe('NewPartyPage', { timeout: 30_000 }, () => {
  it('checks every field as the API would, and the GSTIN checksum as it is typed', async () => {
    const { user, requests } = renderForm('/parties/new');
    await screen.findByRole('heading', { name: 'New customer', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText('Enter at least 2 characters')).toBeInTheDocument();

    await user.type(box('Mobile number'), '12');
    await user.type(box('Other mobile number'), '34');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'nope');
    await user.type(box('PIN code'), '12');
    await user.type(box('PAN'), 'XYZ');
    await user.click(screen.getByRole('checkbox', { name: 'Customer' }));
    expect(screen.queryByRole('combobox', { name: 'Customer type' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findAllByText('Enter a valid mobile number')).toHaveLength(2);
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Enter a 6-digit PIN code')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid 10-character PAN')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one role');

    // A typo in the last character fails the checksum as soon as all 15 are in.
    const gstin = box('GSTIN');
    await user.type(gstin, '36AABCU9603R1Z');
    expect(screen.getByText('15 characters; checked as you type')).toBeInTheDocument();
    await user.type(gstin, 'M');
    expect(screen.getByText('This GSTIN is not valid. Check for typos.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findAllByText('This GSTIN is not valid. Check for typos.')).toHaveLength(1);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('adds a customer, filling the PAN from the GSTIN, and opens it', async () => {
    let body: unknown;
    const { user } = renderForm('/parties/new', {
      'POST /parties': (request) => {
        body = request.body;
        return json(PARTY, 201);
      },
    });
    await screen.findByRole('heading', { name: 'New customer', level: 1 });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Business');
    await user.type(box('Name'), 'Apex Builders');
    await user.type(box('Mobile number'), '98765 43210');
    // Checked live, before the form is ever sent.
    await user.type(box('GSTIN'), '36AABCU9603R1ZM');
    expect(screen.getByText('This GSTIN is not valid. Check for typos.')).toBeInTheDocument();
    await user.clear(box('GSTIN'));
    await user.type(box('GSTIN'), '36aabcu9603r1zo');
    expect(screen.getByText('Valid GSTIN · PAN AABCU9603R')).toBeInTheDocument();
    expect(box('PAN')).toHaveValue('AABCU9603R');
    await user.type(box('Tags'), 'Builder, VIP,,');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'HYD · Hyderabad' })).toBeInTheDocument();
    });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Home store' }),
      'HYD · Hyderabad',
    );
    await user.click(screen.getByRole('checkbox', { name: 'Contractor' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Customer type' }), 'Builder');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preferred contact' }),
      'WhatsApp',
    );
    await user.click(screen.getByRole('button', { name: 'Add customer' }));

    expect(await screen.findByText('Customer added')).toBeInTheDocument();
    await waitFor(() => {
      expect(location()).toBe(`/parties/${PARTY.id}`);
    });
    expect(body).toEqual({
      kind: 'organization',
      displayName: 'Apex Builders',
      phone: '98765 43210',
      gstin: '36AABCU9603R1ZO',
      pan: 'AABCU9603R',
      homeStoreId: 'store-hyd',
      tags: ['builder', 'vip'],
      roles: ['customer', 'contractor'],
      customer: { customerType: 'builder', preferredContact: 'whatsapp' },
    });
  });

  it('warns about a duplicate, linking to the record that exists when it can be seen', async () => {
    let calls = 0;
    const { user } = renderForm('/parties/new', {
      'POST /parties': () => {
        calls += 1;
        return json(
          {
            statusCode: 409,
            message:
              calls === 1
                ? 'A party with this mobile number already exists'
                : 'A party with this GSTIN already exists',
            ...(calls === 1 ? { existingPartyId: PARTY.id } : {}),
          },
          409,
        );
      },
    });
    await screen.findByRole('heading', { name: 'New customer', level: 1 });
    await user.type(box('Name'), 'Apex again');
    await user.type(box('Mobile number'), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const warning = await screen.findByText('Someone with this mobile number is already on file.');
    expect(screen.getByRole('link', { name: 'Open the existing record' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(warning).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Open the existing record' })).toBeNull();
    });
    expect(screen.getByText('A business with this GSTIN is already on file.')).toBeInTheDocument();
  });

  it('shows the API’s field problems next to their fields, and others above the form', async () => {
    let calls = 0;
    const { user } = renderForm('/parties/new', {
      'POST /parties': () => {
        calls += 1;
        return calls === 1
          ? json(
              {
                statusCode: 400,
                message: 'Validation failed',
                issues: [{ path: 'email', message: 'This email is taken' }],
              },
              400,
            )
          : json({ message: 'Database down' }, 503);
      },
    });
    await screen.findByRole('heading', { name: 'New customer', level: 1 });
    await user.type(box('Name'), 'Ramesh');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText('This email is taken')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText('Database down')).toBeInTheDocument();
  });

  it('is only for roles that manage parties', async () => {
    renderApp({ path: '/parties/new', routes: { 'GET /auth/me': () => json(CASHIER) } });
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});

describe('EditPartyPage', { timeout: 30_000 }, () => {
  it('starts from the saved record and clears emptied fields', async () => {
    let body: unknown;
    const { user } = renderForm(`/parties/${PARTY.id}/edit`, {
      'GET /parties/:id': () => json(PARTY),
      'PATCH /parties/:id': (request) => {
        body = request.body;
        return json(PARTY);
      },
    });
    await screen.findByRole('heading', { name: 'Edit Apex Builders', level: 1 });
    expect(box('Legal name')).toHaveValue('Apex Builders Private Limited');
    expect(screen.getByRole('combobox', { name: 'Customer type' })).toHaveValue('builder');
    // The stores arrive after the form; the saved home store is still the one shown.
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Home store' })).toHaveDisplayValue(
        'HYD · Hyderabad',
      );
    });
    // A valid GSTIN does not overwrite a PAN that is already there.
    await user.clear(box('GSTIN'));
    await user.type(box('GSTIN'), '27AAPFU0939F1ZV');
    expect(box('PAN')).toHaveValue('AABCU9603R');
    await user.clear(box('Legal name'));
    await user.click(screen.getByRole('checkbox', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(body).toMatchObject({
      legalName: null,
      gstin: '27AAPFU0939F1ZV',
      isActive: false,
      customer: { customerType: 'builder', preferredContact: 'whatsapp' },
    });
    await waitFor(() => {
      expect(location()).toBe(`/parties/${PARTY.id}`);
    });
  });

  it('fills an empty PAN from a valid GSTIN, and shows customer details once the role is ticked', async () => {
    const { user } = renderForm(`/parties/${BARE_PARTY.id}/edit`, {
      'GET /parties/:id': () => json(BARE_PARTY),
      'GET /parties/:id/overview': () => json(BARE_OVERVIEW),
    });
    await screen.findByRole('heading', { name: 'Edit Walk-in Ramesh', level: 1 });
    expect(screen.getByRole('checkbox', { name: 'Active' })).not.toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'Customer type' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Customer' }));
    expect(screen.getByRole('combobox', { name: 'Customer type' })).toHaveValue('retail');
    await user.type(box('GSTIN'), '27AAPFU0939F1ZV');
    expect(box('PAN')).toHaveValue('AAPFU0939F');
  });

  it('says when the record cannot be found', async () => {
    renderForm(`/parties/${PARTY.id}/edit`, {
      'GET /parties/:id': () => json({ statusCode: 404, message: 'Party not found' }, 404),
    });
    expect(await screen.findByText('Could not load this customer')).toBeInTheDocument();
    expect(
      within(screen.getByRole('alert')).getByText(
        'This record does not exist, or you cannot see it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
