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
  storeDeliveryCostPaise: null,
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
    expect(bodies).toEqual([
      { slowMoverAlertDays: null, storeDeliveryCostPaise: null },
      { slowMoverAlertDays: 45, storeDeliveryCostPaise: null },
    ]);
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

  it('sets what bringing stock over costs, checking the amount', async () => {
    let body: unknown;
    const { user } = renderAlerts({
      'GET /sales/settings': () => json({ ...SETTINGS, storeDeliveryCostPaise: 25_000 }),
      'PUT /sales/settings': (request) => {
        body = request.body;
        return json({ ...SETTINGS, ...(request.body as object) });
      },
    });
    const delivery = await screen.findByRole('textbox', {
      name: /^Bringing stock from another store costs/,
    });
    expect(delivery).toHaveValue('250.00');
    await user.clear(delivery);
    await user.type(delivery, '200000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter rupees up to ₹1,00,000, or leave it blank')).toBeInTheDocument();
    await user.clear(delivery);
    await user.type(delivery, 'abc');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(body).toBeUndefined();
    await user.clear(delivery);
    await user.type(delivery, '300');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Stock alert settings saved')).toBeInTheDocument();
    expect(body).toEqual({ slowMoverAlertDays: 90, storeDeliveryCostPaise: 30_000 });
  });

  it('says when the settings cannot load', async () => {
    renderAlerts({ 'GET /sales/settings': () => json({ message: 'Down' }, 500) });
    expect(await screen.findByText('Could not load the stock alert settings')).toBeInTheDocument();
  });
});
