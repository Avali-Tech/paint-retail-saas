import type { SalesSettingsView } from '@paint/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { parsePrintForm, printFormOf, type InvoicePrintForm } from './InvoicePrintSettingsPage.js';

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

const BANK = {
  bankName: 'HDFC Bank, Ameerpet',
  accountName: 'Sharma Paints LLP',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0001234',
  upiId: 'sharma@hdfc',
};

const EMPTY: InvoicePrintForm = {
  bankName: '',
  accountName: '',
  accountNumber: '',
  ifsc: '',
  upiId: '',
  terms: '',
};

describe('parsePrintForm', () => {
  it('reads no bank details and no terms as none', () => {
    expect(parsePrintForm(EMPTY)).toEqual({
      ok: true,
      input: { invoiceBank: null, invoiceTerms: [] },
    });
  });

  it('reads the bank details trimmed, the IFSC in capitals, and one term per line', () => {
    expect(
      parsePrintForm({
        ...BANK,
        bankName: ' HDFC Bank, Ameerpet ',
        ifsc: 'hdfc0001234',
        upiId: '',
        terms: 'No returns on tinted paint.\n\n  Subject to Hyderabad courts. \n',
      }),
    ).toEqual({
      ok: true,
      input: {
        invoiceBank: { ...BANK, upiId: null },
        invoiceTerms: ['No returns on tinted paint.', 'Subject to Hyderabad courts.'],
      },
    });
  });

  it('keeps a UPI ID given with the bank details', () => {
    expect(parsePrintForm({ ...EMPTY, ...BANK })).toEqual({
      ok: true,
      input: { invoiceBank: BANK, invoiceTerms: [] },
    });
  });

  it('wants all four bank fields, valid numbers, and a UPI ID only with them', () => {
    expect(
      parsePrintForm({
        ...EMPTY,
        bankName: 'HDFC',
        accountNumber: '12-34',
        ifsc: 'HDFC12',
        upiId: 'nope',
      }),
    ).toEqual({
      ok: false,
      problems: {
        bank: 'incomplete',
        accountNumber: 'accountNumber',
        ifsc: 'ifsc',
        upiId: 'upiId',
      },
    });
    expect(parsePrintForm({ ...EMPTY, upiId: 'sharma@hdfc' })).toEqual({
      ok: false,
      problems: { upiId: 'upiWithoutBank' },
    });
  });

  it('allows at most ten terms of at most 200 characters', () => {
    const lines = (count: number, text = 'Term') =>
      Array.from({ length: count }, () => text).join('\n');
    expect(parsePrintForm({ ...EMPTY, terms: lines(11) })).toEqual({
      ok: false,
      problems: { terms: 'tooManyTerms' },
    });
    expect(parsePrintForm({ ...EMPTY, terms: 'x'.repeat(201) })).toEqual({
      ok: false,
      problems: { terms: 'termTooLong' },
    });
    expect(parsePrintForm({ ...EMPTY, terms: lines(10, 'x'.repeat(200)) }).ok).toBe(true);
  });

  it('fills the form from the saved settings', () => {
    expect(printFormOf(SETTINGS)).toEqual(EMPTY);
    expect(
      printFormOf({ ...SETTINGS, invoiceBank: { ...BANK, upiId: null }, invoiceTerms: ['A', 'B'] }),
    ).toEqual({ ...BANK, upiId: '', terms: 'A\nB' });
  });
});

function renderSettings(routes: Record<string, FakeHandler> = {}) {
  return renderApp({
    path: '/settings/invoice-print',
    routes: {
      'GET /auth/me': () => json(OWNER),
      'GET /sales/settings': () =>
        json({ ...SETTINGS, invoiceBank: BANK, invoiceTerms: ['No returns on tinted paint.'] }),
      ...routes,
    },
  });
}

describe('InvoicePrintSettingsPage', { timeout: 30_000 }, () => {
  it('shows the saved bank details and terms, checks them, and saves them', async () => {
    let attempts = 0;
    const bodies: unknown[] = [];
    const { user } = renderSettings({
      'PUT /sales/settings': (request) => {
        attempts += 1;
        bodies.push(request.body);
        return attempts === 1
          ? json({ message: 'The database is busy' }, 503)
          : json({ ...SETTINGS, invoiceBank: null, invoiceTerms: ['Cash only.'] });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Invoice print', level: 1 })).toBeVisible();
    const field = (name: RegExp | string) => screen.getByRole('textbox', { name });
    expect(await screen.findByRole('textbox', { name: 'Bank and branch' })).toHaveValue(
      'HDFC Bank, Ameerpet',
    );
    expect(field(/UPI ID/)).toHaveValue('sharma@hdfc');
    expect(field(/Terms/)).toHaveValue('No returns on tinted paint.');

    // Half the bank details, a bad IFSC: nothing is sent.
    await user.clear(field('Account name'));
    await user.clear(field(/IFSC/));
    await user.type(field(/IFSC/), 'HDFC12');
    const save = () => user.click(screen.getByRole('button', { name: 'Save' }));
    await save();
    expect(screen.getByText('Fill in all four bank fields, or leave them all empty')).toBeVisible();
    expect(screen.getByText('Use an IFSC like SBIN0020345')).toBeVisible();
    expect(bodies).toEqual([]);

    // No bank details at all, new terms; the first try fails.
    for (const name of ['Bank and branch', 'Account number', /IFSC/, /UPI ID/]) {
      await user.clear(field(name));
    }
    await user.clear(field(/Terms/));
    await user.type(field(/Terms/), 'Cash only.');
    await save();
    expect(await screen.findByText('The database is busy')).toBeVisible();
    await save();
    expect(await screen.findByText('Invoice print settings saved')).toBeVisible();
    expect(bodies).toEqual([
      { invoiceBank: null, invoiceTerms: ['Cash only.'] },
      { invoiceBank: null, invoiceTerms: ['Cash only.'] },
    ]);
    expect(within(screen.getByRole('main')).queryByRole('alert')).toBeNull();
    expect(field(/Terms/)).toHaveValue('Cash only.');
  });
});
