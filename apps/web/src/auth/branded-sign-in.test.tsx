import { DEFAULT_BRANDING } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicBranding } from '../api/types.js';
import { SUPPORT_TAB_KEY } from '../support-access/support-tab.js';
import { DASHBOARD, GRANT, OWNER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { SIGN_IN_BUSINESS_KEY } from '../theme/sign-in-business.js';

const LOGO_URL = '/public/branding/sharma-paints/logo/0123456789abcdef';
const SHARMA: PublicBranding = {
  slug: 'sharma-paints',
  branding: { ...DEFAULT_BRANDING, appName: 'Sharma Colours', primary: '#8c1d40', mode: 'dark' },
  logoUrl: LOGO_URL,
};

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);
const rememberedSlug = () =>
  (JSON.parse(String(localStorage.getItem(SIGN_IN_BUSINESS_KEY))) as { slug: string }).slug;
const logo = () => document.querySelector('.sign-in__brand img');
const publicLookups = (requests: { path: string }[]) =>
  requests.filter((request) => request.path.startsWith('/public/branding/')).map((r) => r.path);

afterEach(() => {
  sessionStorage.clear();
});

describe('a branded sign-in page', () => {
  it('wears the business’s name, logo and colours from its link, and remembers it', async () => {
    const { requests } = renderApp({
      path: '/sign-in?b=sharma-paints',
      session: null,
      routes: { 'GET /public/branding/:slug': () => json(SHARMA) },
    });

    expect(await screen.findByRole('heading', { name: 'Sign in to Sharma Colours' })).toBeVisible();
    expect(logo()).toHaveAttribute('src', `/api${LOGO_URL}`);
    expect(cssVar('--color-primary')).not.toBe(DEFAULT_BRANDING.primary);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.head.querySelector('link[data-brand-icon="icon"]')).toHaveAttribute(
      'href',
      `/api${LOGO_URL}`,
    );
    // The language picker stays.
    expect(screen.getByRole('group', { name: 'Language' })).toBeInTheDocument();
    expect(publicLookups(requests)).toEqual(['/public/branding/sharma-paints']);
    expect(JSON.parse(String(localStorage.getItem(SIGN_IN_BUSINESS_KEY)))).toEqual({
      slug: 'sharma-paints',
      page: SHARMA,
    });
  });

  it('shows the last business on the plain sign-in page at once, then checks it again', async () => {
    localStorage.setItem(
      SIGN_IN_BUSINESS_KEY,
      JSON.stringify({ slug: 'sharma-paints', page: SHARMA }),
    );
    const { requests } = renderApp({
      path: '/sign-in',
      session: null,
      routes: {
        'GET /public/branding/:slug': () => json({ ...SHARMA, logoUrl: null }),
      },
    });

    expect(screen.getByRole('heading', { name: 'Sign in to Sharma Colours' })).toBeVisible();
    expect(logo()).toHaveAttribute('src', `/api${LOGO_URL}`);
    // The server's answer (the logo was removed since) replaces the copy.
    await waitFor(() => {
      expect(logo()).toBeNull();
    });
    expect(publicLookups(requests)).toEqual(['/public/branding/sharma-paints']);
  });

  it('says so when the link names no business, in the product’s own look', async () => {
    localStorage.setItem(
      SIGN_IN_BUSINESS_KEY,
      JSON.stringify({ slug: 'sharma-paints', page: SHARMA }),
    );
    renderApp({ path: '/sign-in?b=closed-paints', session: null });

    expect(
      await screen.findByText(
        'This sign-in link doesn’t match any business. Check the link with your owner, or sign in below.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
    expect(cssVar('--color-primary')).toBe(DEFAULT_BRANDING.primary);
    // The business remembered before is kept for the plain page.
    expect(rememberedSlug()).toBe('sharma-paints');
  });

  it('still signs in when the branding cannot be loaded', async () => {
    renderApp({
      path: '/sign-in?b=sharma-paints',
      session: null,
      routes: { 'GET /public/branding/:slug': () => json({ message: 'Down' }, 503) },
    });

    expect(await screen.findByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the product’s own look in a support view, whatever the link says', async () => {
    sessionStorage.setItem(SUPPORT_TAB_KEY, '1');
    const { requests } = renderApp({
      path: '/sign-in?b=sharma-paints',
      session: null,
      routes: { 'GET /public/branding/:slug': () => json(SHARMA) },
    });

    expect(await screen.findByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
    expect(publicLookups(requests)).toEqual([]);
  });

  it('keeps the product’s own look after a refused support link', async () => {
    const { requests, services } = renderApp({
      path: '/sign-in?b=sharma-paints',
      session: null,
      routes: { 'GET /public/branding/:slug': () => json(SHARMA) },
    });
    await screen.findByRole('heading', { name: 'Sign in to Sharma Colours' });

    services.sessions.end('support-rejected');

    expect(await screen.findByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
    expect(publicLookups(requests)).toEqual(['/public/branding/sharma-paints']);
  });

  it('offers its own business first to someone in several, and signs in to the one chosen', async () => {
    const { user, requests } = renderApp({
      path: '/sign-in?b=sharma-paints',
      session: null,
      routes: {
        'GET /public/branding/:slug': () => json(SHARMA),
        'GET /auth/me': () => json(OWNER),
        'GET /dashboard': () => json(DASHBOARD),
        'GET /organization/identity': () => json({ slug: 'xyz-colours', logo: null }),
        'POST /auth/login': (request) =>
          (request.body as { organizationId?: string }).organizationId
            ? json({ ...GRANT, organizationId: 'org-x' })
            : json(
                {
                  statusCode: 409,
                  message: 'Choose which business to sign in to',
                  organizations: [
                    { id: 'org-x', name: 'XYZ Colours', slug: 'xyz-colours' },
                    { id: 'org-s', name: 'Sharma Paints', slug: 'sharma-paints' },
                  ],
                },
                409,
              ),
      },
    });
    await screen.findByRole('heading', { name: 'Sign in to Sharma Colours' });
    await user.type(screen.getByRole('textbox', { name: 'Mobile number or email' }), 'anil@abc.in');
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'Staff@2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const dialog = await screen.findByRole('dialog', { name: 'Choose a business' });
    const choices = within(dialog).getAllByRole('button', { name: /Colours|Paints/ });
    expect(choices.map((choice) => choice.textContent)).toEqual(['Sharma Paints', 'XYZ Colours']);
    expect(choices[0]).toHaveAccessibleDescription('This sign-in page’s business');
    // Choosing another business is fine: the person belongs to it.
    await user.click(within(dialog).getByRole('button', { name: 'XYZ Colours' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    expect(requests.filter((request) => request.path === '/auth/login').at(-1)?.body).toMatchObject(
      {
        organizationId: 'org-x',
      },
    );
    // The business signed in to becomes this device's sign-in page.
    await waitFor(() => {
      expect(rememberedSlug()).toBe('xyz-colours');
    });
  });
});
