import { resolveFeatures } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRANT, json, type FakeHandler } from '../test-support/fake-api.js';
import {
  ACTIVE_GRANT,
  TENANT_ID,
  grant,
  signInOperator,
  tenant,
} from '../test-support/platform-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { formatBytes } from './TenantDetailPage.js';

const location = () => screen.getByTestId('location').textContent;

function renderConsole(path: string, routes: Record<string, FakeHandler>) {
  signInOperator();
  return renderApp({ path, session: null, routes });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('businesses list', () => {
  it('lists businesses with plan, status and usage against the plan’s limits', async () => {
    const { user, requests } = renderConsole('/platform/tenants', {
      'GET /platform/tenants': (request) =>
        request.query.get('status') === 'suspended'
          ? json({ items: [], total: 0 })
          : json({
              items: [
                tenant(),
                tenant({
                  id: 'tenant-2',
                  name: 'Gupta Hardware',
                  status: 'suspended',
                  plan: {
                    key: 'enterprise',
                    name: 'Enterprise',
                    maxStores: null,
                    maxMembers: null,
                  },
                  usage: { ...tenant().usage, stores: 14, members: 3, lastSignInAt: null },
                }),
              ],
              total: 120,
            }),
    });
    const table = await screen.findByRole('table', { name: 'Businesses' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const [, sharma, gupta] = rows;
    expect(within(found(sharma)).getByRole('link', { name: 'Sharma Paints' })).toHaveAttribute(
      'href',
      `/platform/tenants/${TENANT_ID}`,
    );
    expect(sharma).toHaveTextContent('Joined 1 Aug 2026');
    expect(sharma).toHaveTextContent('Trial');
    expect(sharma).toHaveTextContent('Active');
    expect(sharma).toHaveTextContent('5 of 5At limit');
    expect(sharma).toHaveTextContent('12 of 25');
    expect(gupta).toHaveTextContent('Suspended');
    expect(gupta).toHaveTextContent('14 (no limit)');
    expect(gupta).toHaveTextContent('Never');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('offset')).toBe('50');
    });

    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'gupta');
    await waitFor(() => {
      expect(requests.at(-1)?.query.get('q')).toBe('gupta');
    });
    expect(requests.at(-1)?.query.get('offset')).toBe('0');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'suspended');
    expect(await screen.findByText('No businesses match')).toBeVisible();
    expect(requests.at(-1)?.query.get('status')).toBe('suspended');
    expect(
      requests.every((request) => request.headers.authorization === 'Bearer operator-token'),
    ).toBe(true);
  });

  it('says when the list cannot be loaded', async () => {
    renderConsole('/platform/tenants', {
      'GET /platform/tenants': () => json({ message: 'Database down' }, 503),
    });
    expect(await screen.findByText('Could not load the businesses')).toBeVisible();
    expect(screen.getByText('Database down')).toBeVisible();
  });
});

describe('a business', () => {
  it('shows usage, owners and documents', async () => {
    renderConsole(`/platform/tenants/${TENANT_ID}`, {
      'GET /platform/tenants/:id': () => json(tenant()),
      'GET /platform/support-grants': () => json([]),
    });
    expect(await screen.findByRole('heading', { name: 'Sharma Paints', level: 1 })).toBeVisible();
    const usage = screen.getByRole('region', { name: 'Usage' });
    expect(usage).toHaveTextContent('Active stores5 of 5At limit');
    expect(usage).toHaveTextContent('Team members12 of 25');
    expect(usage).toHaveTextContent('Products and pack sizes1,250');
    expect(usage).toHaveTextContent('Documents3 (1.5 MB)');
    expect(usage).toHaveTextContent('Rajesh Sharma');
    expect(usage).toHaveTextContent('+919000000001 · rajesh@sharma.in');
    expect(
      await screen.findByText('No support access requests for this business yet'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'All businesses' })).toHaveAttribute(
      'href',
      '/platform/tenants',
    );
  });

  it('copes with a business without an owner or a sign-in, and one that does not exist', async () => {
    const view = renderConsole(`/platform/tenants/${TENANT_ID}`, {
      'GET /platform/tenants/:id': () =>
        json(tenant({ owners: [], usage: { ...tenant().usage, lastSignInAt: null } })),
      'GET /platform/support-grants': () => json([]),
    });
    expect(await screen.findByText('No active owner')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Usage' })).toHaveTextContent('Last sign-inNever');
    view.unmount();
    renderConsole('/platform/tenants/missing', {
      'GET /platform/tenants/:id': () => json({ message: 'Business not found' }, 404),
    });
    expect(
      await screen.findByText('This record does not exist, or you cannot see it.'),
    ).toBeVisible();
  });

  it('changes the plan', async () => {
    let current = tenant();
    let fail = true;
    const { user, requests } = renderConsole(`/platform/tenants/${TENANT_ID}`, {
      'GET /platform/tenants/:id': () => json(current),
      'GET /platform/support-grants': () => json([]),
      'PATCH /platform/tenants/:id': (request) => {
        if (fail) {
          fail = false;
          return json({ message: 'Nothing to change' }, 400);
        }
        current = tenant({
          plan: { key: 'enterprise', name: 'Enterprise', maxStores: null, maxMembers: null },
          features: resolveFeatures('enterprise', {}),
        });
        expect(request.body).toEqual({ plan: 'enterprise' });
        return json(current);
      },
    });
    const card = await screen.findByRole('region', { name: 'Plan' });
    const save = within(card).getByRole('button', { name: 'Change plan' });
    expect(save).toBeDisabled();
    expect(card).toHaveTextContent('Up to 5 stores and 25 team members');
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Plan' }), 'enterprise');
    expect(card).toHaveTextContent('No limit on stores or team members');
    await user.click(save);
    expect(await screen.findByText('Nothing to change')).toBeVisible();
    await user.click(save);
    expect(await screen.findByText('Plan changed to Enterprise')).toBeVisible();
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(2);
    expect(
      await within(screen.getByRole('region', { name: 'Usage' })).findByText('5 (no limit)'),
    ).toBeVisible();
  });

  it('turns features on or off for the business, or back to the plan', async () => {
    let current = tenant({
      featureOverrides: { loyalty: true, advanced_reports: false },
      features: { ...resolveFeatures('trial', {}), loyalty: true },
    });
    const bodies: unknown[] = [];
    let fail = false;
    const { user } = renderConsole(`/platform/tenants/${TENANT_ID}`, {
      'GET /platform/tenants/:id': () => json(current),
      'GET /platform/support-grants': () => json([]),
      'PATCH /platform/tenants/:id': (request) => {
        if (fail) return json({ message: 'Database down' }, 503);
        bodies.push(request.body);
        current = tenant();
        return json(current);
      },
    });
    const card = await screen.findByRole('region', { name: 'Features' });
    const loyalty = within(card).getByRole('combobox', {
      name: 'Loyalty points for contractors and painters',
    });
    expect(loyalty).toHaveValue('on');
    expect(within(card).getByRole('combobox', { name: 'Advanced reports' })).toHaveValue('off');
    expect(within(card).getByRole('combobox', { name: 'WhatsApp notifications' })).toHaveValue(
      'default',
    );
    expect(within(loyalty).getByRole('option', { name: 'As the plan (off)' })).toBeInTheDocument();

    await user.selectOptions(loyalty, 'default');
    expect(await screen.findByText('Feature updated')).toBeVisible();
    await user.selectOptions(
      within(card).getByRole('combobox', { name: 'WhatsApp notifications' }),
      'on',
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    await user.selectOptions(
      within(card).getByRole('combobox', { name: 'GST e-invoices and e-way bills' }),
      'off',
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(3);
    });
    expect(bodies).toEqual([
      { featureFlags: { loyalty: null } },
      { featureFlags: { whatsapp_notifications: true } },
      { featureFlags: { gst_einvoicing: false } },
    ]);
    fail = true;
    await user.selectOptions(
      within(card).getByRole('combobox', { name: 'Credit limits and approvals' }),
      'on',
    );
    expect(await screen.findByText('Database down')).toBeVisible();
  });

  it('suspends with a reason and a confirmation, then reactivates', async () => {
    let current = tenant();
    const { user, requests } = renderConsole(`/platform/tenants/${TENANT_ID}`, {
      'GET /platform/tenants/:id': () => json(current),
      'GET /platform/support-grants': () => json([]),
      'POST /platform/tenants/:id/suspend': () => {
        current = tenant({
          status: 'suspended',
          suspendedAt: '2026-10-02T04:30:00.000Z',
          suspendReason: 'Unpaid invoice',
        });
        return json(current);
      },
      'POST /platform/tenants/:id/reactivate': () => {
        current = tenant();
        return json(current);
      },
    });
    const card = await screen.findByRole('region', { name: 'Suspension' });
    await user.click(within(card).getByRole('button', { name: 'Suspend business' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Sharma Paints?' });
    await user.click(within(dialog).getByRole('button', { name: 'Suspend business' }));
    expect(await within(dialog).findByText('Write at least 3 characters')).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason \(the business sees it\)/ }),
      'Unpaid invoice',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Suspend business' }));
    expect(await within(dialog).findByText('Tick the box to confirm')).toBeVisible();
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'I understand everyone at Sharma Paints is signed out now',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Suspend business' }));
    expect(await screen.findByText('Sharma Paints is suspended')).toBeVisible();
    expect(screen.getByText('Suspended on 2 Oct 2026: Unpaid invoice')).toBeVisible();
    expect(requests.find((request) => request.path.endsWith('/suspend'))?.body).toEqual({
      reason: 'Unpaid invoice',
    });

    await user.click(within(card).getByRole('button', { name: 'Reactivate business' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reactivate Sharma Paints?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reactivate business' }));
    expect(await screen.findByText('Sharma Paints is active again')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText(/Suspended on/)).toBeNull();
    });
  });
});

describe('support access from the console', () => {
  it('asks a business for access with a reason and a length', async () => {
    let grants = [grant({ status: 'declined', declinedAt: '2026-10-01T05:00:00.000Z' })];
    const { user, requests } = renderConsole(`/platform/tenants/${TENANT_ID}`, {
      'GET /platform/tenants/:id': () => json(tenant()),
      'GET /platform/support-grants': () => json(grants),
      'POST /platform/tenants/:id/support-requests': (request) => {
        const created = grant({ id: 'new', minutes: 120, reason: 'Check the GST report' });
        grants = [created, ...grants];
        expect(request.body).toEqual({ reason: 'Check the GST report', minutes: 120 });
        return json(created, 201);
      },
    });
    const card = await screen.findByRole('region', { name: 'Support access' });
    expect(await within(card).findByText('Declined')).toBeVisible();
    expect(
      requests
        .find((request) => request.path === '/platform/support-grants')
        ?.query.get('tenantId'),
    ).toBe(TENANT_ID);
    await user.click(within(card).getByRole('button', { name: 'Ask for access' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Ask Sharma Paints for support access',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText('Write at least 3 characters')).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Why you need access/ }),
      'Check the GST report',
    );
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'For how long, once approved' }),
      '120',
    );
    expect(within(dialog).getByRole('option', { name: '15 minutes' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText(
        'Request sent. The business decides under Settings → Support access.',
      ),
    ).toBeVisible();
    expect(await within(card).findByText('Waiting for the business')).toBeVisible();
    expect(within(card).getByText('2 hour(s)')).toBeVisible();
  });

  it('opens the read-only view in a new tab with the support session', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let failSession = false;
    const { user } = renderConsole('/platform/support', {
      'GET /platform/support-grants': () =>
        json([ACTIVE_GRANT, grant(), grant({ id: 'x', status: 'ended' })]),
      'POST /platform/support-grants/:id/session': () =>
        failSession ? json({ message: 'This support access is expired' }, 409) : json(GRANT, 201),
    });
    const table = await screen.findByRole('table', { name: 'Support access requests' });
    // Only access that still needs someone: running, or waiting for the business.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table).toHaveTextContent('Until 1 Oct 2026');
    await user.click(within(table).getByRole('button', { name: 'Open read-only view' }));
    expect(await screen.findByText('The read-only view opened in a new tab')).toBeVisible();
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe(`/#support=${encodeURIComponent(JSON.stringify(GRANT))}`);

    failSession = true;
    await user.click(within(table).getByRole('button', { name: 'Open read-only view' }));
    expect(await screen.findByText('This support access is expired')).toBeVisible();
    expect(tab.close).toHaveBeenCalledOnce();

    open.mockReturnValue(null);
    await user.click(within(table).getByRole('button', { name: 'Open read-only view' }));
    expect(
      await screen.findByText(
        'Your browser blocked the new tab. Allow pop-ups for this site and try again.',
      ),
    ).toBeVisible();
  });

  it('ends running access', async () => {
    let grants = [ACTIVE_GRANT];
    let fail = true;
    const { user } = renderConsole('/platform/support', {
      'GET /platform/support-grants': () => json(grants),
      'POST /platform/support-grants/:id/end': () => {
        if (fail) {
          fail = false;
          return json({ message: 'This support access is expired' }, 409);
        }
        grants = [{ ...ACTIVE_GRANT, status: 'ended', endedAt: '2026-10-01T05:30:00.000Z' }];
        return json(grants[0]);
      },
    });
    await user.click(await screen.findByRole('button', { name: 'End access' }));
    expect(await screen.findByText('This support access is expired')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'End access' }));
    expect(await screen.findByText('Access ended')).toBeVisible();
    expect(
      await screen.findByText('No open requests. Ask for access from a business’s page.'),
    ).toBeVisible();
  });

  it('keeps an access log of every request across businesses', async () => {
    const { user } = renderConsole('/platform/access-log', {
      'GET /platform/support-grants': () =>
        json([
          ACTIVE_GRANT,
          grant({
            id: 'declined',
            status: 'declined',
            declinedAt: '2026-10-01T05:00:00.000Z',
            minutes: 45,
          }),
          grant({
            id: 'expired',
            status: 'expired',
            approvedAt: '2026-09-01T05:00:00.000Z',
            expiresAt: '2026-09-01T06:00:00.000Z',
          }),
          grant({
            id: 'ended',
            status: 'ended',
            approvedAt: '2026-09-02T05:00:00.000Z',
            expiresAt: '2026-09-02T06:00:00.000Z',
            endedAt: '2026-09-02T05:15:00.000Z',
          }),
        ]),
    });
    const table = await screen.findByRole('table', { name: 'Access log' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(rows[2]).toHaveTextContent('45 minutes');
    expect(rows[2]).toHaveTextContent('Declined');
    expect(rows[3]).toHaveTextContent('1 Sept 2026, 11:30 am');
    expect(rows[4]).toHaveTextContent('2 Sept 2026, 10:45 am');
    expect(within(found(rows[1])).getByRole('link', { name: 'Sharma Paints' })).toHaveAttribute(
      'href',
      `/platform/tenants/${TENANT_ID}`,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'pending');
    expect(await screen.findByText('No support access has been requested yet')).toBeVisible();
    expect(location()).toBe('/platform/access-log?status=pending');
  });
});

describe('formatBytes', () => {
  it('reads sizes in powers of 1024', () => {
    const number = (value: number) => String(value);
    expect(formatBytes(0, number)).toBe('0 B');
    expect(formatBytes(1536, number)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 5 * 3, number)).toBe('3072 TB');
  });
});
