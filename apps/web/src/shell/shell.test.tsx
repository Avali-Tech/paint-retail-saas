import { PERMISSIONS } from '@paint/shared';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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
import { found } from '../test-support/found.js';

const location = () => screen.getByTestId('location').textContent;

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

const sidebar = () => found(screen.getAllByRole('navigation', { name: 'Main' })[0]);
const bottomBar = () => found(screen.getAllByRole('navigation', { name: 'Main' })[1]);
const texts = (links: HTMLElement[]) => links.map((link) => link.textContent);
/** The menu entry lit for the current page. */
const litEntry = () =>
  within(sidebar())
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'true')
    .map((link) => link.textContent);

describe('navigation by role', () => {
  it('opens the dashboard at "/" and shows the owner a short menu of sections', async () => {
    renderApp({
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /dashboard': () => json(DASHBOARD) },
    });
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(location()).toBe('/dashboard');
    expect(texts(within(sidebar()).getAllByRole('link'))).toEqual([
      '+New sale',
      'Home',
      'Sales',
      'Customers',
      'Money',
      'Stock',
      'Buy',
      'Reports',
      // At the bottom, with the member's own account.
      'Settings',
      'Account security',
    ]);
    expect(within(sidebar()).getByRole('link', { name: 'New sale' })).toHaveAttribute(
      'href',
      '/pos',
    );
    expect(litEntry()).toEqual(['Home']);
    // Home has the dashboard and the inbox, as tabs.
    expect(
      texts(within(screen.getByRole('navigation', { name: 'Home' })).getAllByRole('link')),
    ).toEqual(['Dashboard', 'Inbox']);
    expect(screen.getByText('ABC Paints')).toBeInTheDocument();
    expect(screen.getByText('Signed in as Anil Kumar · Owner')).toBeInTheDocument();
  });

  it('shows counter staff only the sections their role allows', async () => {
    renderApp({
      path: '/settings/appearance',
      routes: { 'GET /auth/me': () => json(CASHIER) },
    });
    expect(await screen.findByText('No access')).toBeInTheDocument();
    expect(texts(within(sidebar()).getAllByRole('link'))).toEqual([
      'Home',
      'Customers',
      'Stock',
      'Reports',
      'Settings',
      'Account security',
    ]);
    // A page they may not open lights no section.
    expect(litEntry()).toEqual([]);
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

  it('puts the other sections and sign-out under "More" on phones', async () => {
    const { user } = renderApp({
      path: '/billing',
      routes: { 'GET /auth/me': () => json(OWNER) },
    });
    await screen.findByText('Page not found');
    expect(texts(within(bottomBar()).getAllByRole('link'))).toEqual([
      'Home',
      'New sale',
      'Customers',
      'Stock',
    ]);
    await user.click(within(bottomBar()).getByRole('button', { name: 'More' }));
    const more = screen.getByRole('dialog', { name: 'More' });
    expect(texts(within(more).getAllByRole('link'))).toEqual([
      'Sales',
      'Money',
      'Buy',
      'Reports',
      'Settings',
      'Account security',
    ]);
    await user.click(within(more).getByRole('link', { name: 'Sales' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(location()).toBe('/quotations');
    });
    await user.click(within(bottomBar()).getByRole('button', { name: 'More' }));
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

describe('sections and tabs', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('shows the section’s pages as tabs, the current one marked', async () => {
    renderApp({ path: '/stock/low', routes: { 'GET /auth/me': () => json(OWNER) } });
    const tabs = await screen.findByRole('navigation', { name: 'Stock' });
    expect(texts(within(tabs).getAllByRole('link'))).toEqual([
      'Products',
      'Balances',
      'Transfers',
      'Stock counts',
      'Low stock',
      'Reorder rules',
      'Slow movers',
      'Mistinted cans',
    ]);
    expect(within(tabs).getByRole('link', { name: 'Low stock' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'Balances' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(litEntry()).toEqual(['Stock']);
  });

  it('lights the section and tab of a record deep inside it', async () => {
    renderApp({ path: '/invoices/i1', routes: { 'GET /auth/me': () => json(OWNER) } });
    const tabs = await screen.findByRole('navigation', { name: 'Sales' });
    expect(within(tabs).getByRole('link', { name: 'Invoices' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(litEntry()).toEqual(['Sales']);
  });

  it('shows only the tabs the member may open', async () => {
    renderApp({
      path: '/purchase-orders',
      routes: { 'GET /auth/me': () => json(profile(['purchasing:read'])) },
    });
    const tabs = await screen.findByRole('navigation', { name: 'Buy' });
    // The price-hike planner plans from costs: it needs costs:read as well.
    expect(texts(within(tabs).getAllByRole('link'))).toEqual([
      'Purchase orders',
      'Goods receipts',
      'Suppliers',
      'Brand schemes',
      'Scheme claims',
      'Brand statements',
    ]);
  });

  it('reopens a section at the tab used last on this device', async () => {
    const { user } = renderApp({
      path: '/transfers',
      routes: { 'GET /auth/me': () => json(OWNER) },
    });
    await screen.findByRole('navigation', { name: 'Stock' });
    expect(within(sidebar()).getByRole('link', { name: 'Sales' })).toHaveAttribute(
      'href',
      '/quotations',
    );
    await user.click(within(sidebar()).getByRole('link', { name: 'Sales' }));
    await user.click(
      within(await screen.findByRole('navigation', { name: 'Sales' })).getByRole('link', {
        name: 'Invoices',
      }),
    );
    await waitFor(() => {
      expect(location()).toBe('/invoices');
    });
    await user.click(within(sidebar()).getByRole('link', { name: 'Stock' }));
    await waitFor(() => {
      expect(location()).toBe('/transfers');
    });
    expect(within(sidebar()).getByRole('link', { name: 'Sales' })).toHaveAttribute(
      'href',
      '/invoices',
    );
  });

  it('gathers the settings on one page, each with a way back to it', async () => {
    const { user } = renderApp({
      path: '/dashboard',
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /dashboard': () => json(DASHBOARD) },
    });
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    await user.click(within(sidebar()).getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(location()).toBe('/settings');
    expect(litEntry()).toEqual(['Settings']);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Business', 'Team & access', 'Customers & credit', 'Money', 'Data']);
    const business = screen.getByRole('region', { name: 'Business' });
    expect(texts(within(business).getAllByRole('link'))).toEqual([
      'Getting started',
      'Stores',
      'Tax & GST',
      'Invoice print',
      'Tinting',
      'Appearance',
      'Stock alerts and transfers',
      'Billing go-live',
    ]);
    expect(screen.queryByRole('link', { name: '← All settings' })).toBeNull();
    await user.click(within(business).getByRole('link', { name: 'Tax & GST' }));
    await user.click(await screen.findByRole('link', { name: '← All settings' }));
    expect(location()).toBe('/settings');
  });

  it('lists only the settings the member may open', async () => {
    renderApp({ path: '/settings', routes: { 'GET /auth/me': () => json(CASHIER) } });
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Team & access', 'Data']);
    expect(
      texts(within(screen.getByRole('region', { name: 'Team & access' })).getAllByRole('link')),
    ).toEqual(['Account security']);
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
