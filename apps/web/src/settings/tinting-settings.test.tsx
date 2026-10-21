import type { SalesSettingsView } from '@paint/shared';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { parseUnitMl } from './TintingSettingsPage.js';

const SETTINGS: SalesSettingsView = {
  stockPostOn: 'invoice',
  walkInPartyId: null,
  quoteValidityDays: 15,
  partialMinAdvancePct: 0,
  defaultPriceMode: 'inclusive',
  billingLiveOn: null,
  cashNeedsRegister: true,
  registerVarianceAlertPaise: 0,
  tintShotMl: 0.616,
  tintYMl: null,
  invoiceBank: null,
  invoiceTerms: [],
};

function renderTinting(routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path: '/settings/tinting',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /sales/settings': () => json(SETTINGS),
      ...routes,
    },
  });
}

describe('parseUnitMl', () => {
  it('reads ml above 0 and up to 100 with at most 4 decimals; blank is not set', () => {
    expect(parseUnitMl(' 0.616 ')).toBe(0.616);
    expect(parseUnitMl('100')).toBe(100);
    expect(parseUnitMl('')).toBeNull();
    expect(parseUnitMl('0')).toBeUndefined();
    expect(parseUnitMl('100.5')).toBeUndefined();
    expect(parseUnitMl('0.12345')).toBeUndefined();
    expect(parseUnitMl('abc')).toBeUndefined();
  });
});

describe('TintingSettingsPage', () => {
  it('shows the saved units and saves new ones, blank clearing one', async () => {
    let body: unknown;
    const { user } = renderTinting({
      'PUT /sales/settings': (request) => {
        body = request.body;
        return json({ ...SETTINGS, tintShotMl: null, tintYMl: 0.308 });
      },
    });
    const shot = await screen.findByRole('textbox', { name: /^One shot, in ml/ });
    const y = screen.getByRole('textbox', { name: /^One Y, in ml/ });
    expect(shot).toHaveValue('0.616');
    expect(y).toHaveValue('');

    await user.clear(shot);
    await user.type(y, '0.30899');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      screen.getByText('Enter ml above 0 and up to 100, with at most 4 decimals'),
    ).toBeInTheDocument();
    expect(body).toBeUndefined();

    await user.clear(y);
    await user.type(y, '0.308');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Tinting settings saved')).toBeInTheDocument();
    expect(body).toEqual({ tintShotMl: null, tintYMl: 0.308 });
  });

  it('checks the shot too, and says why saving failed', async () => {
    const { user } = renderTinting({
      'GET /sales/settings': () => json({ ...SETTINGS, tintShotMl: null, tintYMl: 0.308 }),
      'PUT /sales/settings': () => json({ message: 'Not allowed' }, 403),
    });
    const shot = await screen.findByRole('textbox', { name: /^One shot, in ml/ });
    expect(shot).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^One Y, in ml/ })).toHaveValue('0.308');
    await user.type(shot, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      screen.getByText('Enter ml above 0 and up to 100, with at most 4 decimals'),
    ).toBeInTheDocument();
    await user.clear(shot);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByText('Not allowed')).toBeInTheDocument();
    });
  });

  it('says when the settings cannot load', async () => {
    renderTinting({ 'GET /sales/settings': () => json({ message: 'Down' }, 500) });
    expect(await screen.findByText('Could not load the tinting settings')).toBeInTheDocument();
  });
});
