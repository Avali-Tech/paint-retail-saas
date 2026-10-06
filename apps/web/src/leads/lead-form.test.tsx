import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, profile } from '../test-support/fake-api.js';
import { page } from '../test-support/inventory-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { crmRoutes, lead, party, sent } from './test-support/fixtures.js';

const location = () => screen.getByTestId('location').textContent;

function renderNew(member = profile()) {
  return renderApp({
    path: '/leads/new',
    routes: {
      ...crmRoutes(member),
      'GET /parties': () =>
        json(page([party(), party({ id: 'party-8', displayName: 'No Phone', phone: null })])),
      'POST /leads': () => json(lead({ id: 'lead-5' })),
      'GET /leads/:id': () => json(lead({ id: 'lead-5' })),
    },
  });
}

describe('NewLeadPage', () => {
  it('captures a lead for a customer on file', async () => {
    const { user, requests } = renderNew();
    await user.type(await screen.findByRole('searchbox', { name: /Search by name/ }), 'meera');
    await user.click(await screen.findByRole('button', { name: 'Choose Meera Reddy' }));
    expect(screen.getByRole('heading', { name: 'Meera Reddy' })).toBeInTheDocument();
    expect(screen.getByText('+919822222222')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add lead' }));
    expect(await screen.findByText('Enter a title of at least 3 characters')).toBeVisible();
    expect(screen.getByText('Choose the store')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: /Title/ }), 'Kitchen and hall');
    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), 'store-hyd');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'referral');
    await user.selectOptions(screen.getByRole('combobox', { name: /Assigned to/ }), 'member-2');
    await user.type(screen.getByRole('textbox', { name: /Estimated value/ }), 'lots');
    await user.click(screen.getByRole('button', { name: 'Add lead' }));
    expect(await screen.findByText('Enter an amount in rupees, such as 85000')).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: /Estimated value/ }));
    await user.type(screen.getByRole('textbox', { name: /Estimated value/ }), '1,20,000');
    fireEvent.change(screen.getByLabelText('Expected order date'), {
      target: { value: '2026-12-01' },
    });
    await user.type(screen.getByRole('textbox', { name: 'Requirement' }), 'Royale shades');
    await user.click(screen.getByRole('button', { name: 'Add lead' }));

    expect(await screen.findByText('Lead added')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads')).toEqual({
      storeId: 'store-hyd',
      partyId: 'party-9',
      title: 'Kitchen and hall',
      source: 'referral',
      requirement: 'Royale shades',
      estimatedValuePaise: 12_000_000,
      expectedOrderDate: '2026-12-01',
      assignedMemberId: 'member-2',
    });
    await waitFor(() => {
      expect(location()).toBe('/leads/lead-5');
    });
  });

  it('captures a lead from a new contact, assigned to whoever adds it', async () => {
    const member = profile(['stores:read', 'parties:read', 'leads:read', 'leads:manage']);
    const { user, requests } = renderNew(member);
    await user.click(await screen.findByRole('button', { name: 'New contact' }));
    expect(screen.queryByRole('combobox', { name: /Assigned to/ })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'R');
    await user.type(screen.getByRole('textbox', { name: /Mobile number/ }), '12345');
    await user.click(screen.getByRole('button', { name: 'Add lead' }));
    expect(await screen.findByText('Enter at least 2 characters')).toBeVisible();
    expect(screen.getByText('Enter a valid mobile number')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'avi');
    await user.clear(screen.getByRole('textbox', { name: /Mobile number/ }));
    await user.type(screen.getByRole('textbox', { name: /Mobile number/ }), '98765 11111');
    await user.type(screen.getByRole('textbox', { name: /Title/ }), 'Two rooms');
    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), 'store-pun');
    await user.click(screen.getByRole('button', { name: 'Add lead' }));
    expect(await screen.findByText('Lead added')).toBeInTheDocument();
    expect(sent(requests, 'POST', '/leads')).toEqual({
      storeId: 'store-pun',
      contact: { displayName: 'Ravi', phone: '+919876511111' },
      title: 'Two rooms',
      source: 'walk_in',
    });
  });

  it('goes back to choosing who it is for', async () => {
    const { user } = renderNew();
    await user.type(await screen.findByRole('searchbox', { name: /Search by name/ }), 'no');
    await user.click(await screen.findByRole('button', { name: 'Choose No Phone' }));
    expect(screen.getByText('No mobile number on file')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose someone else' }));
    expect(screen.getByRole('button', { name: 'New contact' })).toBeInTheDocument();
  });

  it('shows the API’s refusal, and its field problems next to the field', async () => {
    let tries = 0;
    const { user } = renderApp({
      path: '/leads/new',
      routes: {
        ...crmRoutes(),
        'POST /leads': () => {
          tries += 1;
          return tries === 1
            ? json({ statusCode: 404, message: 'Store not found' }, 404)
            : json(
                {
                  statusCode: 400,
                  message: 'Validation failed',
                  issues: [{ path: 'title', message: 'Too long for the API' }],
                },
                400,
              );
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'New contact' }));
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Ravi');
    await user.type(screen.getByRole('textbox', { name: /Mobile number/ }), '9876511111');
    await user.type(screen.getByRole('textbox', { name: /Title/ }), 'Two rooms');
    await user.selectOptions(screen.getByRole('combobox', { name: /Store/ }), 'store-pun');
    await user.click(screen.getByRole('button', { name: 'Add lead' }));
    expect(await screen.findByText('Store not found')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add lead' }));
    expect(await screen.findByText('Too long for the API')).toBeVisible();
    expect(screen.queryByText('Store not found')).toBeNull();
  });
});

describe('EditLeadPage', () => {
  it('edits a lead, clearing what was emptied', async () => {
    const { user, requests } = renderApp({
      path: '/leads/lead-1/edit',
      routes: {
        ...crmRoutes(),
        'GET /leads/:id': () => json(lead()),
        'PATCH /leads/:id': () => json(lead({ title: 'Repaint office' })),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Edit LD-000001', level: 1 })).toBeVisible();
    const title = screen.getByRole('textbox', { name: /Title/ });
    expect(title).toHaveValue('Repaint 4-floor office');
    expect(screen.getByRole('textbox', { name: /Estimated value/ })).toHaveValue('850000.00');
    // The store, customer and assignee are not changed here.
    expect(screen.queryByRole('combobox', { name: /Store/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Assigned to/ })).toBeNull();
    await user.clear(title);
    await user.type(title, 'Repaint office');
    await user.clear(screen.getByRole('textbox', { name: /Estimated value/ }));
    await user.clear(screen.getByRole('textbox', { name: 'Requirement' }));
    fireEvent.change(screen.getByLabelText('Expected order date'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sent(requests, 'PATCH', '/leads/lead-1')).toEqual({
      title: 'Repaint office',
      requirement: null,
      source: 'walk_in',
      estimatedValuePaise: null,
      expectedOrderDate: null,
    });
    await waitFor(() => {
      expect(location()).toBe('/leads/lead-1');
    });
  });

  it('starts empty for a lead without the optional details', async () => {
    renderApp({
      path: '/leads/lead-1/edit',
      routes: {
        ...crmRoutes(),
        'GET /leads/:id': () =>
          json(lead({ requirement: null, estimatedValuePaise: null, expectedOrderDate: null })),
      },
    });
    await screen.findByRole('button', { name: 'Save' });
    expect(screen.getByRole('textbox', { name: 'Requirement' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /Estimated value/ })).toHaveValue('');
  });
});
