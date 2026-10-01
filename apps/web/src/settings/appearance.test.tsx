import { DEFAULT_BRANDING, deriveTheme } from '@paint/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { BRANDING_KEY } from '../theme/branding-source.js';
import { found } from '../test-support/found.js';

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);

function renderAppearance() {
  return renderApp({
    path: '/settings/appearance',
    routes: { 'GET /auth/me': () => json(OWNER) },
  });
}

describe('AppearancePage', () => {
  it('restyles the whole app as soon as a colour is typed, and saves it', async () => {
    const { user } = renderAppearance();
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

    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    expect(await screen.findByText('Appearance saved')).toBeInTheDocument();
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
    const { user } = renderAppearance();
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
    expect(localStorage.getItem(BRANDING_KEY)).toBeNull();
  });

  it('takes colours from the picker and explains readability adjustments', async () => {
    renderAppearance();
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
  });

  it('goes back to the default look, and drops unsaved changes when leaving', async () => {
    localStorage.setItem(
      BRANDING_KEY,
      JSON.stringify({ ...DEFAULT_BRANDING, appName: 'Saved Name' }),
    );
    const { user } = renderAppearance();
    const appName = await screen.findByRole('textbox', { name: 'App name' });
    expect(appName).toHaveValue('Saved Name');
    await user.click(screen.getByRole('button', { name: 'Back to the default' }));
    expect(await screen.findByText('Default appearance restored')).toBeInTheDocument();
    expect(appName).toHaveValue('Paint Retail');
    expect(localStorage.getItem(BRANDING_KEY)).toBeNull();

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
