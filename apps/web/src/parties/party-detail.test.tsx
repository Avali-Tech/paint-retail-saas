import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CASHIER, OWNER, json } from '../test-support/fake-api.js';
import { DOCUMENT } from '../test-support/document-fixtures.js';
import {
  BARE_OVERVIEW,
  BARE_PARTY,
  OVERVIEW,
  PARTY,
  STORES,
  loyaltyView,
} from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

const region = (name: string) => screen.getByRole('region', { name });

describe('PartyDetailPage (customer 360)', { timeout: 30_000 }, () => {
  it('gathers everything about the customer the owner can see', async () => {
    renderApp({
      path: `/parties/${PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties/:id/overview': () => json(OVERVIEW),
        'GET /documents': () => json([DOCUMENT]),
        'GET /parties/:id/loyalty': () => json(loyaltyView()),
        'GET /stores': () => json(STORES),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Apex Builders', level: 1 })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}/edit`,
    );

    const contact = region('Contact');
    expect(
      within(contact).getByText('Plot 12, Madhapur, Hyderabad, Telangana, 500081'),
    ).toBeVisible();
    expect(within(contact).getByText('builder, vip')).toBeVisible();
    expect(within(contact).getByText('Apex Builders Private Limited')).toBeVisible();
    expect(within(contact).getByText('Pays on time')).toBeVisible();
    expect(within(contact).getByText('36AABCU9603R1ZO')).toBeVisible();
    expect(within(contact).getByText('Builder')).toBeVisible();
    expect(within(contact).getByText('WhatsApp')).toBeVisible();
    expect(await within(contact).findByText('HYD · Hyderabad')).toBeVisible();

    const activities = region('Activities');
    expect(
      within(activities).getByText('Next follow-up: Call about the quote · 5 Oct 2026, 11:00 am'),
    ).toBeVisible();
    expect(
      within(activities).getByText('Visit · Done · Apex Builders · 25 Sept 2026, 11:30 am'),
    ).toBeVisible();

    const leads = region('Leads');
    expect(within(leads).getByText('2 open')).toBeVisible();
    expect(within(leads).getByRole('link', { name: 'LD-000001 · Villa repaint' })).toHaveAttribute(
      'href',
      '/leads/lead-1',
    );
    expect(within(leads).getByText('Qualified · HYD · ₹2,00,000.00')).toBeVisible();
    expect(within(leads).getByText('New · HYD')).toBeVisible();
    expect(within(leads).getByText('Latest 2 of 12')).toBeVisible();

    const opportunities = region('Opportunities');
    expect(within(opportunities).getByText('Open ₹5,00,000.00 · Won ₹1,00,000.00')).toBeVisible();
    expect(within(opportunities).getByText('Proposal · ₹5,00,000.00 · 40%')).toBeVisible();

    const projects = region('Projects');
    expect(within(projects).getByText('Execution · HYD · Hyderabad · Contractor')).toBeVisible();
    expect(within(projects).getByText('Survey · PUN · Customer')).toBeVisible();

    const contracts = region('Contracts');
    expect(within(contracts).getByText('1 active · 1 due for renewal')).toBeVisible();
    expect(within(contracts).getByText('Renewal due')).toBeVisible();
    expect(
      within(contracts).getByText(
        'Contractor agreement · Active · 1 Oct 2025 – 31 Oct 2026 · ₹10,00,000.00',
      ),
    ).toBeVisible();
    expect(
      within(contracts).getByText('Other agreement · Expired · 1 Jan 2024 – 31 Dec 2024'),
    ).toBeVisible();

    expect(
      await within(region('Documents')).findByText(
        'GST certificate · 120 KB · Anil Kumar · 2 Sept 2026',
      ),
    ).toBeVisible();
    expect(
      within(region('Documents')).getByRole('button', { name: 'Delete gst.pdf' }),
    ).toBeVisible();
    expect(within(region('Credit')).getByText('₹50,000.00')).toBeVisible();
    expect(within(region('Loyalty points')).getByText('1,200 points')).toBeVisible();
  });

  it('shows only the party to a role without CRM, credit or loyalty access', async () => {
    renderApp({
      path: `/parties/${BARE_PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(CASHIER),
        'GET /parties/:id/overview': () => json(BARE_OVERVIEW),
        'GET /documents': () => json([]),
      },
    });
    const heading = await screen.findByRole('heading', { name: 'Walk-in Ramesh', level: 1 });
    expect(heading).toBeVisible();
    expect(screen.getByText('Inactive')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(within(region('Contact')).getByText('No contact details yet')).toBeVisible();
    expect(within(region('Activities')).getByText('Nothing yet')).toBeVisible();
    expect(await within(region('Documents')).findByText('No documents yet')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    for (const hidden of ['Leads', 'Opportunities', 'Projects', 'Contracts', 'Credit']) {
      expect(screen.queryByRole('region', { name: hidden })).toBeNull();
    }
    expect(screen.queryByRole('region', { name: 'Loyalty points' })).toBeNull();
  });

  it('points from a merged record to the one that remains', async () => {
    renderApp({
      path: `/parties/${BARE_PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(CASHIER),
        'GET /parties/:id/overview': () =>
          json({ ...BARE_OVERVIEW, party: { ...BARE_PARTY, mergedIntoId: PARTY.id } }),
      },
    });
    expect(await screen.findByText('This record was merged into another one.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the record that remains' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
  });

  it('opens at the points when a loyalty search result leads here', async () => {
    const scrolled: string[] = [];
    const scroll = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function scrollIntoView(this: Element) {
        scrolled.push(this.id);
      });
    try {
      renderApp({
        path: `/parties/${PARTY.id}/loyalty`,
        routes: {
          'GET /auth/me': () => json(OWNER),
          'GET /parties/:id/overview': () => json(OVERVIEW),
          'GET /parties/:id/loyalty': () => json(loyaltyView()),
        },
      });
      await screen.findByRole('heading', { name: 'Apex Builders', level: 1 });
      expect(screen.queryByText('This record was merged into another one.')).toBeNull();
      await waitFor(() => {
        expect(scrolled).toContain('loyalty');
      });
    } finally {
      scroll.mockRestore();
    }
  });

  it('says when the customer cannot be seen', async () => {
    renderApp({
      path: `/parties/${PARTY.id}`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties/:id/overview': () => json({ statusCode: 404, message: 'Not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load this customer')).toBeVisible();
  });
});
