import type { SalesSettingsView } from '@paint/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

const SETTINGS: SalesSettingsView = {
  stockPostOn: 'invoice',
  walkInPartyId: null,
  quoteValidityDays: 15,
  partialMinAdvancePct: 0,
  defaultPriceMode: 'inclusive',
  billingLiveOn: null,
  cashNeedsRegister: true,
  registerVarianceAlertPaise: 0,
  tintShotMl: null,
  tintYMl: null,
  slowMoverAlertDays: 90,
  invoiceBank: null,
  invoiceTerms: [],
};

function renderAlerts(routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path: '/settings/stock-alerts',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /sales/settings': () => json(SETTINGS),
      ...routes,
    },
  });
}

describe('StockAlertsSettingsPage', () => {
  it('shows the window, turns the alert off and on again', async () => {
    const bodies: unknown[] = [];
    const { user } = renderAlerts({
      'PUT /sales/settings': (request) => {
        bodies.push(request.body);
        return json({ ...SETTINGS, ...(request.body as object) });
      },
    });
    const select = await screen.findByRole('combobox', { name: /^Tell them about slow movers/ });
    expect(select).toHaveValue('90');
    expect(screen.getByRole('option', { name: 'Off' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'After 365 days without a sale or transfer out' }),
    ).toBeInTheDocument();

    await user.selectOptions(select, 'Off');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Stock alert settings saved')).toBeInTheDocument();
    await user.selectOptions(select, '45');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(bodies).toEqual([{ slowMoverAlertDays: null }, { slowMoverAlertDays: 45 }]);
  });

  it('starts from off when the alert is off, and says why saving failed', async () => {
    const { user } = renderAlerts({
      'GET /sales/settings': () => json({ ...SETTINGS, slowMoverAlertDays: null }),
      'PUT /sales/settings': () => json({ message: 'Not allowed' }, 403),
    });
    const select = await screen.findByRole('combobox', { name: /^Tell them about slow movers/ });
    expect(select).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
  });

  it('says when the settings cannot load', async () => {
    renderAlerts({ 'GET /sales/settings': () => json({ message: 'Down' }, 500) });
    expect(await screen.findByText('Could not load the stock alert settings')).toBeInTheDocument();
  });
});
