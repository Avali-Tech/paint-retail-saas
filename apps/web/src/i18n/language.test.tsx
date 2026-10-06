import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CASHIER, json } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { hi } from './hi.js';
import { LOCALE_KEY } from './locale-store.js';
import { te } from './te.js';

const picker = (name: string) => screen.getByRole('group', { name });

describe('choosing a language', () => {
  it('switches the sign-in page, remembers the choice and sets <html lang>', async () => {
    const { user } = renderApp({ path: '/sign-in', session: null });
    const english = picker('Language');
    expect(within(english).getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(english).getByRole('button', { name: 'हिन्दी' }));
    expect(screen.getByRole('button', { name: hi.auth.signIn })).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_KEY)).toBe('hi');
    expect(document.documentElement.lang).toBe('hi-IN');
    const hindi = picker(hi.language.label);
    expect(within(hindi).getByRole('button', { name: 'हिन्दी' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(hindi).getByRole('button', { name: 'తెలుగు' })).toHaveAttribute('lang', 'te-IN');

    await user.click(within(hindi).getByRole('button', { name: 'తెలుగు' }));
    expect(screen.getByRole('button', { name: te.auth.signIn })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('te-IN');
  });

  it('is on the platform console’s sign-in page too', async () => {
    const { user } = renderApp({ path: '/platform/sign-in', session: null });
    const english = await screen.findByRole('group', { name: 'Language' });
    await user.click(within(english).getByRole('button', { name: 'తెలుగు' }));
    expect(
      await screen.findByRole('heading', { name: te.platform.signIn.title, level: 1 }),
    ).toBeInTheDocument();
  });

  it('opens in the language chosen earlier on this device', async () => {
    localStorage.setItem(LOCALE_KEY, 'te');
    renderApp({ path: '/sign-in', session: null });
    expect(await screen.findByRole('button', { name: te.auth.signIn })).toBeInTheDocument();
  });

  it('is part of Account security, and says so in the new language', async () => {
    const { user } = renderApp({
      path: '/settings/security',
      routes: {
        'GET /auth/me': () => json(CASHIER),
        'GET /auth/2fa': () => json({ enabled: false, recoveryCodesLeft: 0, required: false }),
      },
    });
    const card = await screen.findByRole('region', { name: 'Language' });
    await user.click(within(card).getByRole('button', { name: 'తెలుగు' }));
    expect(await screen.findByText(te.language.changed)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: te.security.title, level: 1 })).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_KEY)).toBe('te');
  });

  it('explains failed calls in the chosen language', async () => {
    localStorage.setItem(LOCALE_KEY, 'hi');
    renderApp({
      path: '/settings/security',
      routes: {
        'GET /auth/me': () => json(CASHIER),
        'GET /auth/2fa': () => json({}, 503),
      },
    });
    expect(await screen.findByText(hi.errors.generic)).toBeInTheDocument();
  });
});
