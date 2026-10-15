import {
  emptyTotals,
  type StatementData,
  type StatementLinkView,
  type StatementShareResult,
} from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, type FakeHandler } from '../test-support/fake-api.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';

// The statement share once a WhatsApp provider is set up (MVP 3 round 2a): a stored
// link, the statement_ready message, and the links shared before.

const DATA: StatementData = {
  business: { name: 'ABC Paints', legalName: null, gstin: null, address: null },
  party: { id: PARTY.id, name: 'Apex Builders', phone: null, gstin: null, address: null },
  from: '2026-04-01',
  to: '2026-10-11',
  generatedOn: '2026-10-11',
  openingPaise: 0,
  entries: [],
  debitsPaise: 0,
  creditsPaise: 0,
  closingPaise: 680_00,
  ageing: {
    ...emptyTotals(),
    buckets: { ...emptyTotals().buckets, days_31_60: 680_00 },
    outstandingPaise: 680_00,
    netPaise: 680_00,
  },
  openItems: [],
};

const LINK: StatementLinkView = {
  id: 'link-1',
  from: '2026-04-01',
  to: '2026-10-11',
  language: 'en',
  status: 'active',
  expiresAt: '2026-10-18T05:00:00.000Z',
  revokedAt: null,
  openedCount: 2,
  lastOpenedAt: '2026-10-12T05:00:00.000Z',
  createdBy: 'Anil Kumar',
  createdAt: '2026-10-11T05:00:00.000Z',
};

const URL = 'https://app.example.in/api/public/statements/abc';

const result = (overrides: Partial<StatementShareResult>): StatementShareResult => ({
  link: LINK,
  url: URL,
  waMeUrl: null,
  message: null,
  ...overrides,
});

const routes = (extra: Record<string, FakeHandler> = {}) => ({
  'GET /auth/me': () => json(OWNER),
  'GET /parties/:id/statement': () => json(DATA),
  'GET /messaging/status': () => json({ whatsapp: 'log', sms: false, email: false }),
  'GET /parties/:id/statement/links': () =>
    json([LINK, { ...LINK, id: 'link-0', status: 'revoked', openedCount: 0 }]),
  ...extra,
});

const path = `/parties/${PARTY.id}/statement?from=2026-04-01&to=2026-10-11&lang=en`;

describe('the statement share with a WhatsApp provider', { timeout: 30_000 }, () => {
  it('queues the statement on WhatsApp in one click and lists the links shared', async () => {
    let body: unknown;
    const { user } = renderApp({
      path,
      routes: routes({
        'POST /parties/:id/statement/links': (request) => {
          body = request.body;
          return json(result({ message: { queued: true, messageId: 'm1' } }), 201);
        },
      }),
    });
    const send = await screen.findByRole('button', { name: 'Send on WhatsApp' });
    expect(screen.queryByRole('link', { name: 'Share on WhatsApp' })).toBeNull();
    expect(await screen.findByText(/opened 2 times/)).toBeVisible();
    expect(screen.getAllByRole('button', { name: /^Revoke the link/ })).toHaveLength(1);
    await user.click(send);
    expect(await screen.findByText('Statement queued on WhatsApp')).toBeVisible();
    expect(body).toEqual({ from: '2026-04-01', to: '2026-10-11', lang: 'en', send: 'whatsapp' });
  });

  it('offers WhatsApp with the link when the customer has not agreed to messages', async () => {
    const { user } = renderApp({
      path,
      routes: routes({
        'POST /parties/:id/statement/links': () =>
          json(result({ message: { queued: false, reason: 'no_consent' } }), 201),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Send on WhatsApp' }));
    const alert = await screen.findByText(/has not agreed to WhatsApp messages/);
    expect(alert).toBeVisible();
    expect(screen.getByText(URL)).toBeVisible();
    const open = screen.getByRole('link', { name: 'Open WhatsApp with the link' });
    // No mobile on the party: WhatsApp asks whom to send it to.
    expect(open.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(String(open.getAttribute('href')))).toContain(
      `View the statement: ${URL}`,
    );
  });

  it('uses the server’s wa.me link when the party has a mobile, then queues once agreed', async () => {
    let calls = 0;
    const { user } = renderApp({
      path,
      routes: routes({
        'POST /parties/:id/statement/links': () => {
          calls += 1;
          return json(
            calls === 1
              ? result({
                  waMeUrl: 'https://wa.me/919876543210?text=hi',
                  message: { queued: false, reason: 'no_consent' },
                })
              : result({ message: { queued: true, messageId: 'm2' } }),
            201,
          );
        },
      }),
    });
    const send = await screen.findByRole('button', { name: 'Send on WhatsApp' });
    await user.click(send);
    expect(
      await screen.findByRole('link', { name: 'Open WhatsApp with the link' }),
    ).toHaveAttribute('href', 'https://wa.me/919876543210?text=hi');
    await user.click(send);
    await screen.findByText('Statement queued on WhatsApp');
    expect(screen.queryByRole('link', { name: 'Open WhatsApp with the link' })).toBeNull();
  });

  it('shows the server’s refusal to send', async () => {
    const { user } = renderApp({
      path,
      routes: routes({
        'POST /parties/:id/statement/links': () =>
          json({ statusCode: 409, message: 'WhatsApp messages are not set up' }, 409),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Send on WhatsApp' }));
    expect(await screen.findByText('WhatsApp messages are not set up')).toBeVisible();
  });

  it('revokes an active link, and says when none was shared or the revoke fails', async () => {
    let revoked = 0;
    const { user } = renderApp({
      path,
      routes: routes({
        'POST /statement-links/:id/revoke': () => {
          revoked += 1;
          return revoked === 1
            ? json({ ...LINK, status: 'revoked' })
            : json({ statusCode: 409, message: 'This link is already revoked' }, 409);
        },
      }),
    });
    const revoke = await screen.findByRole('button', {
      name: /^Revoke the link of /,
    });
    await user.click(revoke);
    expect(await screen.findByText('Link revoked')).toBeVisible();
    await user.click(revoke);
    expect(await screen.findByText('This link is already revoked')).toBeVisible();
  });

  it('says when no link was shared yet', async () => {
    renderApp({
      path,
      routes: routes({ 'GET /parties/:id/statement/links': () => json([]) }),
    });
    expect(await screen.findByText('No links shared yet.')).toBeVisible();
  });

  it('keeps the wa.me share when the server has no WhatsApp provider', async () => {
    renderApp({
      path,
      routes: routes({
        'GET /messaging/status': () => json({ whatsapp: null, sms: false, email: false }),
      }),
    });
    const card = await screen.findByRole('region', { name: 'Print and share' });
    await waitFor(() => {
      expect(within(card).getByRole('link', { name: 'Share on WhatsApp' })).toBeVisible();
    });
    expect(within(card).queryByText('Shared links')).toBeNull();
  });
});
