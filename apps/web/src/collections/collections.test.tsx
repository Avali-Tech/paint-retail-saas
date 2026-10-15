import { SYSTEM_ROLES, type PromiseView, type WorklistPage, type WorklistRow } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { OVERVIEW, PARTY } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { readSchedule, offsetLabel } from './ReminderSettingsPage.js';
import { whoseFilter } from './WorklistPage.js';
import { createI18n } from '../i18n/i18n.js';

const role = (key: string) =>
  profile(SYSTEM_ROLES.find((r) => r.key === key)?.permissions, {
    role: { key, name: key },
    allStores: false,
  });
const SALES = role('sales_executive');
const MANAGER = role('branch_manager');

const PROMISE: PromiseView = {
  id: 'promise-1',
  partyId: PARTY.id,
  amountPaise: 50_000_00,
  promisedOn: '2026-10-20',
  madeOn: '2026-10-16',
  status: 'open',
  note: null,
  paidPaise: 10_000_00,
  createdBy: 'Anil Kumar',
  createdAt: '2026-10-16T05:00:00.000Z',
  closedAt: null,
  cancelReason: null,
};

const row = (overrides: Partial<WorklistRow> = {}): WorklistRow => ({
  partyId: PARTY.id,
  name: 'Apex Builders',
  phone: '+919876543210',
  salesperson: { id: 'member-2', name: 'Sita Rao' },
  outstandingPaise: 70_000_00,
  overduePaise: 60_000_00,
  maxDaysPastDue: 45,
  oldestBucket: 'days_31_60',
  lastActivity: { type: 'call', subject: 'Called about March', at: '2026-10-15T05:00:00.000Z' },
  openPromise: null,
  openEscalationId: null,
  nextStep: 'contact',
  ...overrides,
});

const PAGE: WorklistPage = {
  asOf: '2026-10-16',
  total: 2,
  overduePaise: 80_000_00,
  rows: [
    row({
      partyId: 'party-2',
      name: 'Deccan Interiors',
      phone: null,
      salesperson: null,
      overduePaise: 20_000_00,
      maxDaysPastDue: 12,
      lastActivity: null,
      openPromise: { ...PROMISE, partyId: 'party-2' },
      openEscalationId: 'escalation-1',
      nextStep: 'acknowledge_escalation',
    }),
    row(),
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

const worklistRoutes = (member = OWNER, extra: Record<string, FakeHandler> = {}) => ({
  'GET /auth/me': () => json(member),
  'GET /collections/worklist': () => json(PAGE),
  ...extra,
});

describe('whoseFilter', () => {
  it('shows the member’s own customers unless they choose everyone’s or nobody’s', () => {
    expect(whoseFilter('')).toEqual({ whose: 'me', salespersonId: 'me' });
    expect(whoseFilter('all')).toEqual({ whose: 'all' });
    expect(whoseFilter('none')).toEqual({ whose: 'none', salespersonId: 'none' });
  });
});

describe('WorklistPage', { timeout: 30_000 }, () => {
  it('lists overdue customers with promise, last contact and next step', async () => {
    const { requests } = renderApp({ path: '/collections', routes: worklistRoutes() });
    const table = await screen.findByRole('table', { name: 'Collections worklist' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('Deccan Interiors');
    expect(first).toHaveTextContent('Not assigned');
    expect(first).toHaveTextContent('Never');
    expect(first).toHaveTextContent('₹50,000.00 by');
    expect(first).toHaveTextContent('₹10,000.00 paid so far');
    expect(first).toHaveTextContent('Act on the broken promise');
    expect(second).toHaveTextContent('Sita Rao');
    expect(second).toHaveTextContent('Called about March');
    expect(second).toHaveTextContent('Call or message');
    expect(within(found(second)).getByRole('link', { name: 'Call Apex Builders' })).toHaveAttribute(
      'href',
      'tel:+919876543210',
    );
    expect(screen.getByText('2 customers owe ₹80,000.00 overdue')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}/ledger`,
    );
    expect(
      requests.find((r) => r.path === '/collections/worklist')?.query.get('salespersonId'),
    ).toBe('me');
  });

  it('switches whose customers it shows', async () => {
    const { requests, user } = renderApp({ path: '/collections', routes: worklistRoutes() });
    await screen.findByRole('table', { name: 'Collections worklist' });
    await user.selectOptions(screen.getByLabelText('Whose customers'), 'all');
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.path === '/collections/worklist')
          .at(-1)
          ?.query.has('salespersonId'),
      ).toBe(false);
    });
    await user.selectOptions(screen.getByLabelText('Whose customers'), 'none');
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.path === '/collections/worklist')
          .at(-1)
          ?.query.get('salespersonId'),
      ).toBe('none');
    });
    await user.selectOptions(screen.getByLabelText('Whose customers'), 'me');
    expect(screen.getByLabelText('Whose customers')).toHaveValue('me');
  });

  it('records a promise from a row, checking amount and date first', async () => {
    let body: unknown;
    const { user } = renderApp({
      path: '/collections',
      routes: worklistRoutes(OWNER, {
        'POST /parties/:id/promises': (request) => {
          body = request.body;
          return json(PROMISE, 201);
        },
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Record a promise from Apex Builders' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('At most what the customer owes: ₹70,000.00')).toBeVisible();
    await user.clear(within(dialog).getByLabelText(/Pay by/));
    await user.click(within(dialog).getByRole('button', { name: 'Record promise' }));
    expect(within(dialog).getByText('Enter an amount above zero')).toBeVisible();
    expect(within(dialog).getByText('Choose the date')).toBeVisible();
    await user.type(within(dialog).getByLabelText(/Amount/), '25,000');
    await user.type(within(dialog).getByLabelText(/Pay by/), '2026-10-25');
    await user.type(within(dialog).getByLabelText(/Note/), ' After the site bill ');
    await user.click(within(dialog).getByRole('button', { name: 'Record promise' }));
    expect(await screen.findByText('Promise recorded')).toBeVisible();
    expect(body).toEqual({
      amountPaise: 25_000_00,
      promisedOn: '2026-10-25',
      note: 'After the site bill',
    });
  });

  it('records a promise without a note, and shows the server’s refusal', async () => {
    const bodies: unknown[] = [];
    const { user } = renderApp({
      path: '/collections',
      routes: worklistRoutes(OWNER, {
        'POST /parties/:id/promises': (request) => {
          bodies.push(request.body);
          return bodies.length === 1
            ? json({ statusCode: 409, message: 'This customer already has an open promise' }, 409)
            : json(PROMISE, 201);
        },
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Record a promise from Apex Builders' }),
    );
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Amount/), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Record promise' }));
    expect(
      await within(dialog).findByText('This customer already has an open promise'),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Record promise' }));
    await screen.findByText('Promise recorded');
    expect(bodies[1]).not.toHaveProperty('note');
  });

  it('acknowledges an escalation with or without a note', async () => {
    const bodies: unknown[] = [];
    const { user } = renderApp({
      path: '/collections',
      routes: worklistRoutes(OWNER, {
        'POST /collections/escalations/:id/acknowledge': (request) => {
          bodies.push(request.body);
          return { status: 204 };
        },
      }),
    });
    const button = await screen.findByRole('button', {
      name: 'Acknowledge the broken promise of Deccan Interiors',
    });
    await user.click(button);
    await user.type(screen.getByLabelText(/What was done/), 'Called the owner');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }),
    );
    expect(await screen.findByText('Escalation acknowledged')).toBeVisible();
    await user.click(button);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }),
    );
    await waitFor(() => {
      expect(bodies).toEqual([{ note: 'Called the owner' }, {}]);
    });
  });

  it('offers no actions to members who cannot chase credit, and says when nothing is overdue', async () => {
    renderApp({
      path: '/collections',
      routes: worklistRoutes(profile(['receivables:read', 'parties:read']), {
        'GET /collections/worklist': () =>
          json({ ...PAGE, rows: [row({ phone: null })], total: 1 }),
      }),
    });
    await screen.findByRole('table', { name: 'Collections worklist' });
    expect(screen.queryByRole('button', { name: /Record a promise/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Call/ })).toBeNull();
  });

  it('says when nothing is overdue', async () => {
    renderApp({
      path: '/collections',
      routes: worklistRoutes(OWNER, {
        'GET /collections/worklist': () =>
          json({ asOf: '2026-10-16', rows: [], total: 0, overduePaise: 0 }),
      }),
    });
    expect(await screen.findByText('Nothing is overdue for these customers.')).toBeVisible();
  });

  it('pages through a long worklist', async () => {
    const { requests, user } = renderApp({
      path: '/collections',
      routes: worklistRoutes(OWNER, {
        'GET /collections/worklist': () => json({ ...PAGE, total: 120 }),
      }),
    });
    await screen.findByRole('table', { name: 'Collections worklist' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.path === '/collections/worklist')
          .at(-1)
          ?.query.get('offset'),
      ).toBe('50');
    });
  });
});

describe('the reminder schedule', () => {
  it('reads rows: whole days in range, each once, with a channel', () => {
    const rows = [
      { key: 1, offset: '−3', channels: ['sms' as const], isActive: true },
      { key: 2, offset: '7', channels: ['email' as const], isActive: false },
    ];
    expect(readSchedule(rows)).toEqual({
      schedules: [
        { offsetDays: -3, channels: ['sms'], isActive: true },
        { offsetDays: 7, channels: ['email'], isActive: false },
      ],
    });
    const bad = readSchedule([
      { key: 1, offset: 'abc', channels: ['sms'], isActive: true },
      { key: 2, offset: '91', channels: ['sms'], isActive: true },
      { key: 3, offset: '5', channels: ['sms'], isActive: true },
      { key: 4, offset: '5', channels: ['sms'], isActive: true },
      { key: 5, offset: '6', channels: [], isActive: true },
      { key: 6, offset: '-31', channels: ['sms'], isActive: true },
    ]);
    expect('problems' in bad && [...bad.problems]).toEqual([
      [1, 'offset'],
      [2, 'offset'],
      [4, 'twice'],
      [5, 'channels'],
      [6, 'offset'],
    ]);
  });

  it('names offsets in words', () => {
    const { t, plural } = createI18n('en');
    expect([-1, -3, 0, 1, 7].map((days) => offsetLabel(days, plural, t))).toEqual([
      '1 day before',
      '3 days before',
      'On the due date',
      '1 day after',
      '7 days after',
    ]);
  });

  it('is edited and saved by credit approvers', { timeout: 30_000 }, async () => {
    let saved: unknown;
    const { user } = renderApp({
      path: '/collections/reminders',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /collections/reminder-schedules': () =>
          json([{ id: 's1', offsetDays: 7, channels: ['sms'], isActive: true }]),
        'PUT /collections/reminder-schedules': (request) => {
          saved = request.body;
          return json([
            { id: 's1', offsetDays: 0, channels: ['sms', 'email'], isActive: true },
            { id: 's2', offsetDays: 7, channels: ['sms'], isActive: false },
          ]);
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Reminders' });
    expect(within(table).getByText('7 days after')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add a reminder' }));
    const days = within(table).getAllByLabelText('Day');
    expect(within(table).getByText(/Negative: before the due date/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('A whole number from −30 to 90')).toBeVisible();
    await user.type(found(days[1]), '0');
    const rows = within(table).getAllByRole('row');
    await user.click(within(found(rows[2])).getByLabelText('WhatsApp'));
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Choose at least one channel')).toBeVisible();
    await user.click(within(found(rows[2])).getByLabelText('SMS'));
    await user.click(within(found(rows[2])).getByLabelText('Email'));
    await user.click(within(found(rows[1])).getByLabelText('On'));
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Reminder schedule saved')).toBeVisible();
    expect(saved).toEqual({
      schedules: [
        { offsetDays: 7, channels: ['sms'], isActive: false },
        { offsetDays: 0, channels: ['sms', 'email'], isActive: true },
      ],
    });
  });

  it(
    'starts from the suggested schedule, removes a day, and shows the server’s refusal',
    { timeout: 30_000 },
    async () => {
      const { user } = renderApp({
        path: '/collections/reminders',
        routes: {
          'GET /auth/me': () => json(OWNER),
          'GET /collections/reminder-schedules': () => json([]),
          'PUT /collections/reminder-schedules': () =>
            json({ statusCode: 403, message: 'You do not have permission to do this' }, 403),
        },
      });
      expect(await screen.findByText(/No reminders are sent/)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Use the suggested schedule' }));
      const table = screen.getByRole('table', { name: 'Reminders' });
      expect(within(table).getAllByRole('row')).toHaveLength(6);
      await user.click(screen.getByRole('button', { name: 'Remove the reminder 3 days before' }));
      expect(within(table).getAllByRole('row')).toHaveLength(5);
      await user.click(screen.getByRole('button', { name: 'Save schedule' }));
      expect(await screen.findByText('You do not have permission to do this')).toBeVisible();
    },
  );

  it('is read-only for members who do not approve credit', async () => {
    renderApp({
      path: '/collections/reminders',
      routes: {
        'GET /auth/me': () => json(SALES),
        'GET /collections/reminder-schedules': () => json([]),
      },
    });
    expect(
      await screen.findByText('Only members who approve credit can change the schedule.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save schedule' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Worklist' })).toHaveAttribute('href', '/collections');
  });
});

describe('the customer 360 collections and messages', { timeout: 30_000 }, () => {
  const partyRoutes = (member = OWNER, extra: Record<string, FakeHandler> = {}) => ({
    'GET /auth/me': () => json(member),
    'GET /parties/:id/overview': () => json({ ...OVERVIEW, credit: null, loyalty: null }),
    'GET /parties/:id/promises': () =>
      json([
        PROMISE,
        { ...PROMISE, id: 'p0', status: 'kept', paidPaise: 50_000_00 },
        { ...PROMISE, id: 'p00', status: 'cancelled', cancelReason: 'Recorded twice' },
      ]),
    'GET /parties/:id/consents': () =>
      json({
        current: [
          {
            id: 'c1',
            channel: 'whatsapp',
            address: '+919876543210',
            state: 'granted',
            method: 'counter_with_notice',
            noticeVersion: '2026-10',
            language: 'te',
            recordedBy: 'Anil Kumar',
            recordedAt: '2026-10-16T05:00:00.000Z',
          },
        ],
        history: [],
        phone: '+919876543210',
        email: null,
      }),
    'GET /parties/:id/messages': () =>
      json([
        {
          id: 'm1',
          channel: 'whatsapp',
          templateKey: 'payment_reminder_overdue',
          language: 'te',
          toAddress: '+919876543210',
          body: '…',
          status: 'sent',
          skipReason: null,
          attempts: 1,
          createdAt: '2026-10-16T05:00:00.000Z',
          sentAt: '2026-10-16T05:01:00.000Z',
        },
      ]),
    ...extra,
  });

  it('shows the open promise with what was paid, earlier promises, consent and messages', async () => {
    renderApp({ path: `/parties/${PARTY.id}`, routes: partyRoutes() });
    const collections = await screen.findByRole('region', { name: 'Collections' });
    expect(await within(collections).findByText(/Promised ₹50,000.00 by/)).toBeVisible();
    expect(within(collections).getByText(/₹10,000.00 paid since/)).toBeVisible();
    expect(within(collections).getByText('Kept')).toBeVisible();
    expect(within(collections).getByText('Recorded twice')).toBeVisible();
    const messages = screen.getByRole('region', { name: 'Messages and consent' });
    expect(await within(messages).findByText('Agreed')).toBeVisible();
    expect(within(messages).getAllByText('Not asked')).toHaveLength(2);
    expect(await within(messages).findByText('Overdue reminder')).toBeVisible();
    expect(within(messages).getByText('Sent')).toBeVisible();
  });

  it('cancels the open promise with a reason, and records a new one when none is open', async () => {
    let cancelled: unknown;
    let open = true;
    const { user } = renderApp({
      path: `/parties/${PARTY.id}`,
      routes: partyRoutes(OWNER, {
        'GET /parties/:id/promises': () => json(open ? [PROMISE] : []),
        'POST /promises/:id/cancel': (request) => {
          cancelled = request.body;
          open = false;
          return json({ ...PROMISE, status: 'cancelled' });
        },
        'POST /parties/:id/promises': () => json(PROMISE, 201),
      }),
    });
    const collections = await screen.findByRole('region', { name: 'Collections' });
    await user.click(await within(collections).findByRole('button', { name: 'Cancel promise' }));
    await user.type(screen.getByLabelText(/Reason/), 'Recorded by mistake');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel promise' }),
    );
    expect(await screen.findByText('Promise cancelled')).toBeVisible();
    expect(cancelled).toEqual({ reason: 'Recorded by mistake' });
    expect(await within(collections).findByText('No open promise to pay.')).toBeVisible();
    await user.click(within(collections).getByRole('button', { name: 'Record a promise' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/At most what the customer owes/)).toBeNull();
    await user.type(within(dialog).getByLabelText(/Amount/), '500');
    await user.click(within(dialog).getByRole('button', { name: 'Record promise' }));
    expect(await screen.findByText('Promise recorded')).toBeVisible();
  });

  it('records consent after showing the notice in the chosen language', async () => {
    let recorded: unknown;
    const { user } = renderApp({
      path: `/parties/${PARTY.id}`,
      routes: partyRoutes(OWNER, {
        'POST /parties/:id/consents': (request) => {
          recorded = request.body;
          return json({ current: [], history: [], phone: '+919876543210', email: null });
        },
      }),
    });
    const messages = await screen.findByRole('region', { name: 'Messages and consent' });
    await user.click(await within(messages).findByRole('button', { name: 'Record consent' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(/ABC Paints will send you .* on WhatsApp at \+919876543210/),
    ).toBeVisible();
    await user.selectOptions(within(dialog).getByLabelText('Channel'), 'email');
    expect(within(dialog).getByText('No mobile or email to send to')).toBeVisible();
    await user.selectOptions(within(dialog).getByLabelText('Channel'), 'sms');
    await user.selectOptions(within(dialog).getByLabelText('The customer'), 'withdrawn');
    await user.selectOptions(within(dialog).getByLabelText('How'), 'signed_form');
    await user.selectOptions(within(dialog).getByLabelText(/Language of the notice/), 'hi');
    expect(within(dialog).getByText(/SMS पर \+919876543210 पर/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('Consent recorded')).toBeVisible();
    expect(recorded).toEqual({
      channel: 'sms',
      state: 'withdrawn',
      method: 'signed_form',
      language: 'hi',
      noticeVersion: '2026-10',
    });
    expect(await within(messages).findAllByText('Not asked')).toHaveLength(3);
  });

  it('hides collections from members without receivables:read and recording from those who only read parties', async () => {
    renderApp({
      path: `/parties/${PARTY.id}`,
      routes: partyRoutes(profile(['parties:read']), {
        'GET /parties/:id/messages': () => json([]),
      }),
    });
    const messages = await screen.findByRole('region', { name: 'Messages and consent' });
    expect(await within(messages).findByText('No messages yet.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Collections' })).toBeNull();
    expect(within(messages).queryByRole('button', { name: 'Record consent' })).toBeNull();
  });

  it('shows earlier promises only, and no buttons, to a branch manager’s read-only colleague', async () => {
    renderApp({
      path: `/parties/${PARTY.id}`,
      routes: partyRoutes(profile(['parties:read', 'receivables:read']), {
        'GET /parties/:id/promises': () => json([{ ...PROMISE, status: 'broken' }]),
      }),
    });
    const collections = await screen.findByRole('region', { name: 'Collections' });
    expect(await within(collections).findByText('Broken')).toBeVisible();
    expect(within(collections).queryByRole('button')).toBeNull();
    expect(MANAGER.permissions).toContain('receivables:read');
  });
});
