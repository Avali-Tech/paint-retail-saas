import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_PERMISSIONS, type DocumentListItem } from '../api/documents.js';
import type { Member } from '../api/team.js';
import { DOCUMENT } from '../test-support/document-fixtures.js';
import { OWNER, json, profile, type FakeRequest } from '../test-support/fake-api.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { DOCUMENTS_PAGE_SIZE } from './DocumentsPage.js';
import { DOCUMENT_READ_PERMISSIONS } from './nav.js';

const ON_PARTY: DocumentListItem = { ...DOCUMENT, recordLabel: 'Apex Builders' };
const ON_LEAD: DocumentListItem = {
  ...DOCUMENT,
  id: 'doc-lead',
  recordType: 'lead',
  recordId: 'lead-1',
  recordLabel: 'LD-000004 · Kondapur tower',
  category: 'quotation',
  fileName: 'quote.pdf',
};
const ON_STORE: DocumentListItem = {
  ...DOCUMENT,
  id: 'doc-store',
  recordType: 'store',
  recordId: 'store-hyd',
  recordLabel: 'HYD · Hyderabad',
  category: 'photo',
  fileName: 'shopfront.jpg',
};
const MEMBERS: Member[] = [
  {
    id: 'member-2',
    user: { id: 'user-2', fullName: 'Ravi Teja', phone: null, email: null },
    role: { id: 'r1', key: 'sales_executive', name: 'Sales Executive' },
    allStores: true,
    storeIds: [],
    isActive: true,
    twoFactorEnabled: false,
  },
];
const location = () => screen.getByTestId('location').textContent;
const browses = (requests: FakeRequest[]) =>
  requests.filter((request) => request.path === '/documents');
const click = vi.fn<(this: HTMLAnchorElement) => void>();

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:document'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
    this: HTMLAnchorElement,
  ) {
    click.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  click.mockClear();
});

describe('DocumentsPage', { timeout: 30_000 }, () => {
  it('lists documents across records, filtered and paged by the API', async () => {
    let listed = [ON_LEAD, ON_PARTY, ON_STORE];
    const { user, requests } = renderApp({
      path: '/documents',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /members': () => json(MEMBERS),
        'GET /documents': (request) =>
          request.query.get('category') === 'invoice'
            ? json({ items: [], total: 0 })
            : json({ items: listed, total: DOCUMENTS_PAGE_SIZE + 1 }),
        'GET /documents/:id/download': () => ({ status: 200, raw: '%PDF-1.7' }),
        'DELETE /documents/:id': () => {
          listed = [ON_PARTY, ON_STORE];
          return { status: 204 };
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
    expect(await screen.findByText('quote.pdf')).toBeVisible();
    expect(browses(requests).at(-1)?.query.toString()).toBe('limit=25&offset=0');
    // Each document names the record it is on, linked where the record has a page.
    expect(screen.getByRole('link', { name: 'LD-000004 · Kondapur tower' })).toHaveAttribute(
      'href',
      '/leads/lead-1',
    );
    expect(screen.getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(screen.getByText(/^Store ·/)).toHaveTextContent('Store · HYD · Hyderabad');
    expect(screen.queryByRole('link', { name: 'HYD · Hyderabad' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Download quote.pdf' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('quote.pdf');

    await user.click(screen.getByRole('button', { name: 'Delete quote.pdf' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete quote.pdf?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Document deleted')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText('quote.pdf')).toBeNull();
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Record' }), 'Lead');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Uploaded by' }), 'Ravi Teja');
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-08-01' } });
    expect(await screen.findByText('The “to” date cannot be before the “from” date')).toBeVisible();
    await waitFor(() => {
      expect(browses(requests).at(-1)?.query.toString()).toBe(
        'recordType=lead&uploadedBy=member-2&from=2026-09-01&limit=25&offset=0',
      );
    });
    expect(location()).toBe(
      '/documents?recordType=lead&uploadedBy=member-2&from=2026-09-01&to=2026-08-01',
    );
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-09-30' } });
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(browses(requests).at(-1)?.query.toString()).toBe(
        'recordType=lead&uploadedBy=member-2&from=2026-09-01&to=2026-09-30&limit=25&offset=25',
      );
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'What it is' }), 'Invoice');
    expect(await screen.findByText('No documents match these filters')).toBeVisible();
  });

  it('offers only what the role can see, and deletes only what it can change', async () => {
    const { requests } = renderApp({
      // A record type the role cannot see is ignored, and a date that is not one is not sent.
      path: '/documents?recordType=purchase_order&from=2026-13-01',
      routes: {
        'GET /auth/me': () => json(profile(['parties:read', 'leads:read', 'leads:manage'])),
        'GET /documents': () => json({ items: [ON_LEAD, ON_PARTY], total: 2 }),
      },
    });
    expect(await screen.findByText('quote.pdf')).toBeVisible();
    expect(screen.getByText('Enter a date')).toBeVisible();
    expect(
      within(screen.getByRole('combobox', { name: 'Record' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All records', 'Customer or party', 'Lead', 'Opportunity']);
    expect(
      within(screen.getByRole('combobox', { name: 'Uploaded by' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Anyone', 'Me']);
    expect(screen.getByRole('button', { name: 'Delete quote.pdf' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete gst.pdf' })).toBeNull();
    expect(browses(requests).at(-1)?.query.toString()).toBe('limit=25&offset=0');
  });

  it('says when there is nothing yet, and when loading fails', async () => {
    const view = renderApp({
      path: '/documents',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /members': () => json([]),
        'GET /documents': () => json({ items: [], total: 0 }),
      },
    });
    expect(await screen.findByText('No documents yet')).toBeVisible();
    // A first-time user learns where documents come from.
    expect(
      screen.getByText(
        'Files you upload on a customer, order, lead, project or contract page show up here.',
      ),
    ).toBeVisible();
    view.unmount();
    renderApp({
      path: '/documents',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /members': () => json([]),
        'GET /documents': () => json({ message: 'Database down' }, 503),
      },
    });
    expect(await screen.findByText('Could not load the documents')).toBeVisible();
  });

  it('is in the navigation for anyone who sees records with documents', async () => {
    expect([...DOCUMENT_READ_PERMISSIONS].sort()).toEqual(
      [...new Set(Object.values(DOCUMENT_PERMISSIONS).map((rule) => rule.read))].sort(),
    );
    renderApp({
      path: '/documents',
      routes: { 'GET /auth/me': () => json(profile(['audit:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});
