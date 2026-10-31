import { SETUP_STEP_KEYS, type SetupChecklistView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DASHBOARD, GRANT, OWNER, json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

/** A checklist with these steps done. */
function checklist(done: readonly string[]): SetupChecklistView {
  const steps = SETUP_STEP_KEYS.map((key) => ({
    key,
    done: done.includes(key),
    count: done.includes(key) ? 1 : 0,
  }));
  return {
    steps,
    completed: steps.filter((step) => step.done).length,
    total: steps.length,
  };
}

const HALFWAY = checklist(['stores_gst', 'products', 'team']);

beforeEach(() => {
  localStorage.clear();
});

describe('GettingStartedPage', { timeout: 30_000 }, () => {
  it('shows each step done or not, with a link to its screen', async () => {
    renderApp({
      path: '/settings/getting-started',
      routes: { 'GET /auth/me': () => json(OWNER), 'GET /onboarding': () => json(HALFWAY) },
    });
    expect(await screen.findByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();
    expect(await screen.findByText('3 of 9 done')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '3 of 9 done' })).toHaveAttribute('value', '3');
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem');
    expect(steps).toHaveLength(9);
    expect(steps[0]).toHaveTextContent('Stores and GST');
    expect(steps[0]).toHaveTextContent('Done');
    expect(steps[3]).toHaveTextContent(
      'Opening stockImport what each store has on its shelvesTo do',
    );
    expect(screen.getByRole('link', { name: 'Open: Payment links' })).toHaveAttribute(
      'href',
      '/settings/payment-links',
    );
    expect(screen.getByRole('link', { name: 'Open: Billing go-live' })).toHaveAttribute(
      'href',
      '/settings/go-live',
    );
    expect(screen.queryByText('Everything is set up.')).toBeNull();
  });

  it('says when everything is set up, or the checklist cannot be read', async () => {
    const { unmount } = renderApp({
      path: '/settings/getting-started',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /onboarding': () => json(checklist(SETUP_STEP_KEYS)),
      },
    });
    expect(await screen.findByText('Everything is set up.')).toBeVisible();
    unmount();
    renderApp({
      path: '/settings/getting-started',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /onboarding': () => json({ message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the checklist')).toBeVisible();
  });
});

describe('Getting started on Home', { timeout: 30_000 }, () => {
  it('shows owners what is left until they hide it on this device', async () => {
    const { user, unmount } = renderApp({
      path: '/dashboard',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /dashboard': () => json(DASHBOARD),
        'GET /onboarding': () => json(HALFWAY),
      },
    });
    const card = await screen.findByRole('region', { name: 'Getting started' });
    expect(within(card).getByText('3 of 9 done')).toBeVisible();
    expect(within(card).getByRole('link', { name: 'See all' })).toHaveAttribute(
      'href',
      '/settings/getting-started',
    );
    await user.click(within(card).getByRole('button', { name: 'Hide' }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    });
    unmount();

    // Hidden on this device for this business: it stays hidden, without asking.
    const again = renderApp({
      path: '/dashboard',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /dashboard': () => json(DASHBOARD),
        'GET /onboarding': () => json(HALFWAY),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    expect(again.requests.some((request) => request.path === '/onboarding')).toBe(false);
    expect(localStorage.getItem(`paint.gettingStarted.hidden.${GRANT.organizationId}`)).toBe('1');
  });

  it('leaves Home alone once everything is done, and for members who do not set up', async () => {
    const { unmount, requests } = renderApp({
      path: '/dashboard',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /dashboard': () => json(DASHBOARD),
        'GET /onboarding': () => json(checklist(SETUP_STEP_KEYS)),
      },
    });
    await waitFor(() => {
      expect(requests.some((request) => request.path === '/onboarding')).toBe(true);
    });
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    unmount();

    const manager = renderApp({
      path: '/dashboard',
      routes: {
        'GET /auth/me': () => json(profile(['inventory:read', 'stores:read'])),
        'GET /dashboard': () => json(DASHBOARD),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    expect(manager.requests.some((request) => request.path === '/onboarding')).toBe(false);
  });
});
