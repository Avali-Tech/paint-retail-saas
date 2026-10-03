import { DEFAULT_BRANDING, deriveTheme, type Branding } from '@paint/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { BRANDING_KEY } from '../theme/branding-source.js';
import { found } from '../test-support/found.js';

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);

const SAVED_NAME = { ...DEFAULT_BRANDING, appName: 'Saved Name' };

/** The appearance page over a fake branding API that answers like the real one. */
function renderAppearance(routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path: '/settings/appearance',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'PUT /organization/branding': (request) =>
        json({
          branding: request.body,
          adjustments: deriveTheme(request.body as Branding).adjustments,
        }),
      ...routes,
    },
  });
}

describe('AppearancePage', { timeout: 30_000 }, () => {
  it('restyles the whole app as soon as a colour is typed, and saves it', async () => {
    const view = renderAppearance();
    const { user } = view;
    await screen.findByRole('heading', { name: 'Appearance', level: 1 });
    expect(cssVar('--color-primary')).toBe(DEFAULT_BRANDING.primary);

    const primaryText = screen.getByRole('textbox', { name: 'Primary colour' });
    await user.clear(primaryText);
    await user.type(primaryText, '#15803d');
    expect(cssVar('--color-primary')).toBe('#15803d');

    const appName = screen.getByRole('textbox', { name: 'App name' });
    await user.clear(appName);
    await user.type(appName, 'Sri Balaji Paints');
    expect(document.title).toBe('Sri Balaji Paints');
    expect(screen.getAllByText('Sri Balaji Paints').length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Light or dark' }), 'Dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Corners' }), 'Square');
    expect(cssVar('--radius-md')).toBe('0px');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Spacing' }), 'Compact');
    expect(cssVar('--control-height')).toBe('36px');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Font' }), 'Mukta');
    expect(cssVar('--font-family')).toMatch(/^Mukta/);

    const { requests } = view;
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    expect(await screen.findByText('Appearance saved')).toBeInTheDocument();
    expect(screen.getByText('Saved for everyone in your business')).toBeInTheDocument();
    expect(requests.find((request) => request.method === 'PUT')?.body).toMatchObject({
      appName: 'Sri Balaji Paints',
      primary: '#15803d',
    });
    expect(JSON.parse(String(localStorage.getItem(BRANDING_KEY)))).toMatchObject({
      appName: 'Sri Balaji Paints',
      primary: '#15803d',
      mode: 'dark',
      radius: 'none',
      density: 'compact',
      font: 'mukta',
    });
  });

  it('refuses a colour that is not a hex code, without restyling', async () => {
    const view = renderAppearance();
    const { user } = view;
    await screen.findByRole('heading', { name: 'Appearance', level: 1 });
    const accentText = screen.getByRole('textbox', { name: 'Accent colour' });
    await user.clear(accentText);
    await user.type(accentText, 'orange');
    expect(screen.getByText('Enter a colour like #1d4ed8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled();
    expect(cssVar('--color-accent')).toBe(deriveTheme(DEFAULT_BRANDING).light.colors.accent);
    // The picker keeps the last good colour meanwhile.
    expect(screen.getByLabelText('Accent colour: colour picker')).toHaveValue(
      DEFAULT_BRANDING.accent,
    );
    fireEvent.submit(
      found(screen.getByRole('button', { name: 'Save appearance' }).closest('form')),
    );
    expect(view.requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('takes colours from the picker and explains readability adjustments', async () => {
    const { user } = renderAppearance();
    await screen.findByRole('heading', { name: 'Appearance', level: 1 });
    expect(
      screen.getByText('Every text and button colour meets WCAG AA contrast.'),
    ).toBeInTheDocument();
    const picker = screen.getByLabelText('Primary colour: colour picker');
    fireEvent.input(picker, { target: { value: '#ffd700' } });
    const readability = screen.getByRole('region', { name: 'Readability' });
    expect(
      within(readability).getByText(
        'Primary was darkened in light mode so buttons stand out from the page (3:1).',
      ),
    ).toBeInTheDocument();
    expect(cssVar('--color-primary')).not.toBe('#ffd700');
    expect(screen.getByRole('list', { name: 'primary' }).children).toHaveLength(11);

    // Saved: the page shows what the server adjusted, until the next change.
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    const saved = await screen.findByText('Saved for everyone in your business');
    const alert = found(saved.closest('.ui-alert'), 'saved alert');
    expect(
      within(alert as HTMLElement).getByText(
        'To keep everything readable, the saved theme adjusts:',
      ),
    ).toBeInTheDocument();
    expect(
      within(alert as HTMLElement).getByText(
        'Primary was darkened in light mode so buttons stand out from the page (3:1).',
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'App name' }), 'x');
    expect(screen.queryByText('Saved for everyone in your business')).not.toBeInTheDocument();
  });

  it('shows the saved theme of the business, and when nothing needed adjusting', async () => {
    const { user } = renderAppearance({
      'GET /organization/branding': () =>
        json({ branding: { ...DEFAULT_BRANDING, appName: 'Team Paints' }, updatedAt: 'x' }),
      'PUT /organization/branding': (request) => json({ branding: request.body, adjustments: [] }),
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'App name' })).toHaveValue('Team Paints');
    });
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    expect(await screen.findByText('Every colour stays as you chose it.')).toBeInTheDocument();
  });

  it('says so when saving or resetting fails', async () => {
    const { user } = renderAppearance({
      'PUT /organization/branding': () => json({ message: 'You cannot change the branding' }, 403),
    });
    await screen.findByRole('heading', { name: 'Appearance', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    expect(await screen.findByText('You cannot change the branding')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the default' }));
    await waitFor(() => {
      expect(screen.getAllByText('You cannot change the branding')).toHaveLength(2);
    });
  });

  it('goes back to the default look, and drops unsaved changes when leaving', async () => {
    localStorage.setItem(BRANDING_KEY, JSON.stringify(SAVED_NAME));
    const { user } = renderAppearance({
      'GET /organization/branding': () => json({ branding: SAVED_NAME, updatedAt: 'x' }),
    });
    expect(await screen.findByRole('textbox', { name: 'App name' })).toHaveValue('Saved Name');
    await user.click(screen.getByRole('button', { name: 'Back to the default' }));
    expect(await screen.findByText('Default appearance restored')).toBeInTheDocument();
    const appName = screen.getByRole('textbox', { name: 'App name' });
    expect(appName).toHaveValue('Paint Retail');
    expect(JSON.parse(String(localStorage.getItem(BRANDING_KEY)))).toEqual(DEFAULT_BRANDING);

    await user.clear(appName);
    await user.type(appName, 'Unsaved');
    expect(document.title).toBe('Unsaved');
    const [sidebar] = screen.getAllByRole('navigation', { name: 'Main' });
    await user.click(within(found(sidebar)).getByRole('link', { name: 'Customers' }));
    await waitFor(() => {
      expect(document.title).toBe('Paint Retail');
    });
  });
});
