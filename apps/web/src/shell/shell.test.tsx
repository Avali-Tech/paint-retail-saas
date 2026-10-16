import { PERMISSIONS } from '@paint/shared';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ServicesProvider, createServices } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import {
  CASHIER,
  DASHBOARD,
  GRANT,
  OWNER,
  fakeFetch,
  json,
  profile,
} from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { NAV_ITEMS, visibleNav } from './nav.js';
import { found } from '../test-support/found.js';

const location = () => screen.getByTestId('location').textContent;

describe('visibleNav', () => {
  it('shows each section only with its permission', () => {
    expect(visibleNav(() => true)).toEqual(NAV_ITEMS);
    expect(visibleNav((permission) => permission === 'leads:read').map((item) => item.key)).toEqual(
      ['leads', 'opportunities', 'followUps', 'documents', 'reports'],
    );
    // Imports need any one of the permissions to change what they import.
    expect(
      visibleNav((permission) => permission === 'parties:manage').map((item) => item.key),
    ).toEqual(['imports']);
  });
});

describe('RequireAuth', () => {
  it('sends visitors to sign in, remembering where they were going', async () => {
    const { user } = renderApp({
      path: '/dashboard?store=s1',
      session: null,
      routes: {
        'POST /auth/login': () =>
          json({ token: 't', expiresAt: '2099-01-01T00:00:00Z', organizationId: 'o' }),
        'GET /auth/me': () => json(OWNER),
        'GET /dashboard': () => json(DASHBOARD),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Sign in to Paint Retail' }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Mobile number or email' }), 'anil@abc.in');
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(location()).toBe('/dashboard?store=s1');
  });

  it('waits for the profile, and offers a retry when it fails', async () => {
    let attempts = 0;
    const { user } = renderApp({
      path: '/dashboard',
      routes: {
        'GET /auth/me': () => {
          attempts += 1;
          return attempts === 1 ? json({ message: 'Database down' }, 503) : json(OWNER);
        },
        'GET /dashboard': () => json(DASHBOARD),
      },
    });
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database down');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('goes back to sign-in when the session has ended on the server', async () => {
    renderApp({
      path: '/dashboard',
      routes: { 'GET /auth/me': () => json({ statusCode: 401, message: 'Unauthorized' }, 401) },
    });
    expect(
      await screen.findByText('Your session has ended. Please sign in again.'),
    ).toBeInTheDocument();
    expect(location()).toBe('/sign-in');
  });
});

describe('navigation by role', () => {
  it('opens the dashboard at "/" and shows the owner every section', async () => {
    renderApp({
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /dashboard': () => json(DASHBOARD) },
    });
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(location()).toBe('/dashboard');
    const [sidebar] = screen.getAllByRole('navigation', { name: 'Main' });
    expect(
      within(found(sidebar))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Dashboard',
      'Counter sale',
      'Customers',
      'Products',
      'Stock',
      'Purchasing',
      'Leads',
      'Opportunities',
      'Projects',
      'Contracts',
      'Estimates',
      'Quotations',
      'Sales orders',
      'Invoices',
      'Credit & debit notes',
      'Day end',
      'Payments',
      'Tally export',
      'Receivables',
      'Collections',
      'Follow-ups',
      'Documents',
      'Credit approvals',
      'Credit requests',
      'Credit rules',
      'Loyalty programme',
      'Painter points rules',
      'Import data',
      'Reports',
      'Brand profitability',
      'Team',
      'Appearance',
      'Tax & GST',
      'Invoice print',
      'Payment link settings',
      'Support access',
      'Billing',
      'Stores',
      'Billing go-live',
      // Everyone's own sign-in settings, next to signing out.
      'Account security',
    ]);
    expect(screen.getByText('ABC Paints')).toBeInTheDocument();
    expect(screen.getByText('Signed in as Anil Kumar · Owner')).toBeInTheDocument();
  });

  it('shows counter staff only what their role allows', async () => {
    renderApp({
      path: '/settings/appearance',
      routes: { 'GET /auth/me': () => json(CASHIER) },
    });
    expect(await screen.findByText('No access')).toBeInTheDocument();
    const [sidebar] = screen.getAllByRole('navigation', { name: 'Main' });
    expect(
      within(found(sidebar))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Dashboard',
      'Customers',
      'Products',
      'Stock',
      'Follow-ups',
      'Documents',
      'Reports',
      'Account security',
    ]);
  });

  it('opens the first allowed section, or follow-ups when there is none', async () => {
    renderApp({ routes: { 'GET /auth/me': () => json(profile(['leads:read'])) } });
    expect(await screen.findByRole('heading', { name: 'Leads', level: 1 })).toBeInTheDocument();
    expect(location()).toBe('/leads');
  });

  it('opens follow-ups for a member with no sections', async () => {
    renderApp({ routes: { 'GET /auth/me': () => json(profile([])) } });
    await screen.findByRole('heading', { name: 'My follow-ups', level: 1 });
    expect(location()).toBe('/follow-ups');
  });

  it('says an unknown address leads nowhere (never "coming soon") and offers the way back', async () => {
    renderApp({ path: '/no-such-screen', routes: { 'GET /auth/me': () => json(OWNER) } });
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This address does not lead to a screen. Check the link, or use the menu or search.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('puts the remaining sections and sign-out under "More" on phones', async () => {
    const { user } = renderApp({
      path: '/billing',
      routes: { 'GET /auth/me': () => json(OWNER) },
    });
    await screen.findByText('Page not found');
    const bottomBar = found(screen.getAllByRole('navigation', { name: 'Main' })[1]);
    expect(within(bottomBar).getAllByRole('link')).toHaveLength(4);
    await user.click(within(bottomBar).getByRole('button', { name: 'More' }));
    const more = screen.getByRole('dialog', { name: 'More' });
    expect(
      within(more)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Stock',
      'Purchasing',
      'Leads',
      'Opportunities',
      'Projects',
      'Contracts',
      'Estimates',
      'Quotations',
      'Sales orders',
      'Invoices',
      'Credit & debit notes',
      'Day end',
      'Payments',
      'Tally export',
      'Receivables',
      'Collections',
      'Follow-ups',
      'Documents',
      'Credit approvals',
      'Credit requests',
      'Credit rules',
      'Loyalty programme',
      'Painter points rules',
      'Import data',
      'Reports',
      'Brand profitability',
      'Team',
      'Appearance',
      'Tax & GST',
      'Invoice print',
      'Payment link settings',
      'Support access',
      'Billing',
      'Stores',
      'Billing go-live',
      'Account security',
    ]);
    await user.click(within(more).getByRole('link', { name: 'Leads' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(location()).toBe('/leads');
    await user.click(within(bottomBar).getByRole('button', { name: 'More' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'More' })).getByRole('link', {
        name: 'Account security',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();
    // Screens load on first use, so the address changes once the screen has arrived.
    await waitFor(() => {
      expect(location()).toBe('/settings/security');
    });
  });

  it('links back to the dashboard from screens still to come', async () => {
    const { user } = renderApp({
      path: '/billing',
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /dashboard': () => json(DASHBOARD) },
    });
    await user.click(await screen.findByRole('link', { name: 'Back to the dashboard' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });
});

describe('sign-out', () => {
  it('ends the session on the server and returns to sign-in', async () => {
    const { user, requests } = renderApp({
      path: '/billing',
      routes: { 'GET /auth/me': () => json(OWNER), 'POST /auth/logout': () => ({ status: 204 }) },
    });
    await screen.findByText('Page not found');
    const [sidebar] = screen.getAllByRole('navigation', { name: 'Main' });
    await user.click(within(found(sidebar)).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You have signed out.')).toBeInTheDocument();
    expect(requests.some((request) => request.path === '/auth/logout')).toBe(true);
    expect(localStorage.getItem('paint.session')).toBeNull();
  });

  it('starts the next sign-in at the dashboard, not on the page signed out from', async () => {
    const { user } = renderApp({
      path: '/billing',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /dashboard': () => json(DASHBOARD),
        'POST /auth/logout': () => ({ status: 204 }),
        'POST /auth/login': () => json(GRANT),
      },
    });
    await screen.findByText('Page not found');
    const [sidebar] = screen.getAllByRole('navigation', { name: 'Main' });
    await user.click(within(found(sidebar)).getByRole('button', { name: 'Sign out' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Mobile number or email' }),
      '9876543210',
    );
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'Staff@2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('signs out on this device even when the server cannot be reached', async () => {
    const { user } = renderApp({
      path: '/billing',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'POST /auth/logout': () => json({ message: 'Bad gateway' }, 502),
      },
    });
    await screen.findByText('Page not found');
    await user.click(
      found(screen.getAllByRole('navigation', { name: 'Main' })[1]?.querySelector('button')),
    );
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You have signed out.')).toBeInTheDocument();
  });
});

describe('session hooks', () => {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const services = createServices({
      fetch: fakeFetch({}).fetch,
      storage: localStorage,
      apiBaseUrl: '/api',
    });
    return (
      <ServicesProvider services={services}>
        <QueryClientProvider client={services.queryClient}>{children}</QueryClientProvider>
      </ServicesProvider>
    );
  };

  it('has no permissions and no profile while signed out', () => {
    const can = renderHook(() => usePermissions(), { wrapper }).result.current;
    expect(PERMISSIONS.some((permission) => can(permission))).toBe(false);
    expect(() => renderHook(() => useCurrentProfile(), { wrapper })).toThrow(
      'useCurrentProfile must be used inside <RequireAuth>',
    );
  });
});
