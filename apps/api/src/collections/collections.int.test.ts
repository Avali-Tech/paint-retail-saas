import { migrateDatabase, schema, withTenant } from '@paint/db';
import type {
  AuthProfile,
  EscalationView,
  PromiseView,
  ReminderScheduleView,
  WorklistPage,
} from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Notifier } from '../notifications/notifier.js';
import { NotificationsWorker } from '../notifications/notifications-worker.js';
import {
  api,
  billingBusiness,
  dbToday,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { runCollections, runCollectionsForBusinesses } from './collections-job.js';

const {
  activities,
  collectionEscalations,
  collectionRuns,
  messageOutbox,
  notifications,
  promisesToPay,
} = schema;

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
const day = (offset: number) => dbToday(t, offset);
let sales: { token: string; memberId: string };
let manager: { token: string; memberId: string };
let employee: string;
let kkpSales: string;
/** Krishna owes ₹590 (45 days late) and ₹118 (not yet due); looked after by `sales`. */
let krishna: string;
/** Lakshmi owes ₹236, 10 days late; nobody looks after her. */
let lakshmi: string;
/** Venkat owes nothing overdue. */
let venkat: string;
/** A Kukatpally customer the Ameerpet staff never see. */
let kkpParty: string;

const get = async <T>(url: string, token = b.owner) => ok(await api(t, token).get(url)).json<T>();

async function customer(body: object): Promise<string> {
  return ok(
    await api(t, b.owner).post('/parties', { phone: uniquePhone(), roles: ['customer'], ...body }),
  ).json<{ id: string }>().id;
}

async function bill(partyId: string, quantity: number, dueOn: string, storeId = b.stores.amp) {
  const draft = await b.draft({
    storeId,
    partyId,
    dueOn,
    lines: [{ variantId: b.apex, quantity }],
  });
  ok(await api(t, b.owner).post(`/invoices/${draft.id}/issue`, {}));
}

async function member(roleKey: string, storeIds: string[]) {
  const token = await b.member(roleKey, storeIds);
  return { token, memberId: (await get<AuthProfile>('/auth/me', token)).memberId };
}

async function pay(partyId: string, amountPaise: number, receivedOn: string, extra: object = {}) {
  return ok(
    await api(t, b.owner).post('/payments', {
      storeId: b.stores.amp,
      partyId,
      modeId: b.modes.upi.id,
      amountPaise,
      receivedOn,
      ...extra,
    }),
  ).json<{ id: string }>();
}

/** A promise as an earlier day's code would have left it (the API only takes today on). */
async function pastPromise(
  partyId: string,
  amountPaise: number,
  madeOn: string,
  promisedOn: string,
) {
  const [row] = await t.connection.db
    .insert(promisesToPay)
    .values({
      organizationId: b.organizationId,
      partyId,
      amountPaise,
      madeOn,
      promisedOn,
      createdByMemberId: sales.memberId,
    })
    .returning({ id: promisesToPay.id });
  return String(row?.id);
}

const notifier = () => t.app.get(Notifier);
const run = () =>
  withTenant(t.connection.db, b.organizationId, (tx) =>
    runCollections(tx, notifier(), b.organizationId),
  );
/** Lets the daily run happen again (tests only; runs are append-only to tenants). */
async function forgetRuns() {
  await withPgClient(database.connectionString, async (client) => {
    await client.query('ALTER TABLE collection_runs DISABLE TRIGGER collection_runs_append_only');
    await client.query('DELETE FROM collection_runs');
    await client.query('ALTER TABLE collection_runs ENABLE TRIGGER collection_runs_append_only');
  });
}
async function grantConsent(
  partyId: string,
  channel: 'whatsapp' | 'sms' | 'email',
  language = 'en',
) {
  ok(
    await api(t, b.owner).post(`/parties/${partyId}/consents`, {
      channel,
      state: 'granted',
      method: 'counter_with_notice',
      language,
      noticeVersion: '2026-10',
    }),
  );
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  sales = await member('sales_executive', [b.stores.amp]);
  manager = await member('branch_manager', [b.stores.amp]);
  employee = await b.member('store_employee', [b.stores.amp]);
  kkpSales = await b.member('sales_executive', [b.stores.kkp]);

  krishna = await customer({
    displayName: 'Krishna Constructions',
    homeStoreId: b.stores.amp,
    email: 'krishna@example.in',
    customer: { assignedMemberId: sales.memberId },
  });
  lakshmi = await customer({ displayName: 'Lakshmi Interiors' });
  venkat = await customer({ displayName: 'Venkat Homes' });
  kkpParty = await customer({ displayName: 'Kukatpally Builders', homeStoreId: b.stores.kkp });

  await bill(krishna, 5, await day(-45)); // ₹590, 45 days late
  await bill(krishna, 1, await day(10)); // ₹118, not yet due
  await bill(lakshmi, 2, await day(-10)); // ₹236, 10 days late
  await bill(venkat, 1, await day(5)); // ₹118, not yet due
  await bill(kkpParty, 1, await day(-3), b.stores.kkp); // ₹118, 3 days late
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('promises to pay', () => {
  it('are recorded for a date from today to 60 days ahead, up to what is owed, one open at a time', async () => {
    const promise = (body: object, token = sales.token) =>
      api(t, token).post(`/parties/${krishna}/promises`, body);

    const late = await promise({ amountPaise: 10_000, promisedOn: await day(-1) });
    const far = await promise({ amountPaise: 10_000, promisedOn: await day(61) });
    const tooMuch = await promise({ amountPaise: 70_900, promisedOn: today });
    const created = ok(
      await promise({
        amountPaise: 50_000,
        promisedOn: await day(3),
        note: 'Pays after site bill',
      }),
    ).json<PromiseView>();
    const second = await promise({ amountPaise: 1_000, promisedOn: today });

    expect([late.statusCode, far.statusCode, tooMuch.statusCode]).toEqual([400, 400, 400]);
    expect(issuesOf(late)).toEqual(['promisedOn']);
    expect(tooMuch.json<{ issues: { message: string }[] }>().issues[0]?.message).toBe(
      'More than the customer owes (₹708.00)',
    );
    expect(created).toMatchObject({
      partyId: krishna,
      amountPaise: 50_000,
      promisedOn: await day(3),
      madeOn: today,
      status: 'open',
      note: 'Pays after site bill',
      paidPaise: 0,
      createdBy: 'Staff sales_executive',
      closedAt: null,
      cancelReason: null,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('promise_open');

    // The timeline shows it as an activity of its own type.
    const [activity] = await t.connection.db
      .select({ type: activities.type, subject: activities.subject })
      .from(activities)
      .where(and(eq(activities.recordId, krishna), eq(activities.type, 'promise_to_pay')));
    expect(activity).toEqual({
      type: 'promise_to_pay',
      subject: `Promised ₹500.00 by ${await day(3)}`,
    });
    // Staff cannot log one by hand.
    const byHand = await api(t, b.owner).post('/activities', {
      recordType: 'party',
      recordId: krishna,
      type: 'promise_to_pay',
      subject: 'Promised',
    });
    expect(byHand.statusCode).toBe(400);
  });

  it('refuse a customer who owes nothing, and one the member cannot see', async () => {
    const nothing = await customer({ displayName: 'Paid Up Traders' });
    const refused = await api(t, sales.token).post(`/parties/${nothing}/promises`, {
      amountPaise: 100,
      promisedOn: today,
    });
    expect(refused.json<{ issues: { message: string }[] }>().issues[0]?.message).toBe(
      'The customer owes nothing now',
    );
    const hidden = await api(t, sales.token).post(`/parties/${kkpParty}/promises`, {
      amountPaise: 100,
      promisedOn: today,
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('count payments since they were made and are listed newest first; cancelled with a reason', async () => {
    await pay(krishna, 20_000, today);
    const [open] = await get<PromiseView[]>(`/parties/${krishna}/promises`, sales.token);
    expect(open).toMatchObject({ status: 'open', paidPaise: 20_000 });

    const id = String(open?.id);
    const noReason = await api(t, sales.token).post(`/promises/${id}/cancel`, {});
    const otherStore = await api(t, kkpSales).post(`/promises/${id}/cancel`, { reason: 'x' });
    const missing = await api(t, sales.token).post(`/promises/${crypto.randomUUID()}/cancel`, {
      reason: 'x',
    });
    const cancelled = ok(
      await api(t, sales.token).post(`/promises/${id}/cancel`, { reason: 'Recorded twice' }),
    ).json<PromiseView>();
    const again = await api(t, sales.token).post(`/promises/${id}/cancel`, { reason: 'x' });

    expect([noReason.statusCode, otherStore.statusCode, missing.statusCode]).toEqual([
      400, 404, 404,
    ]);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Recorded twice' });
    expect(cancelled.closedAt).not.toBeNull();
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toBe('This promise is already cancelled');
  });

  it('turn a race for the one open promise into a 409', async () => {
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        api(t, b.owner).post(`/parties/${lakshmi}/promises`, {
          amountPaise: 1_000,
          promisedOn: today,
        }),
      ),
    );
    expect([first?.statusCode, second?.statusCode].sort()).toEqual([201, 409]);
    const [open] = await get<PromiseView[]>(`/parties/${lakshmi}/promises`);
    ok(await api(t, b.owner).post(`/promises/${String(open?.id)}/cancel`, { reason: 'Test' }));
  });

  it('need the right permissions', async () => {
    expect((await api(t, employee).get(`/parties/${krishna}/promises`)).statusCode).toBe(403);
    expect(
      (
        await api(t, employee).post(`/parties/${krishna}/promises`, {
          amountPaise: 1,
          promisedOn: today,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await api(t, employee).get(`/parties/${crypto.randomUUID()}/promises`)).statusCode,
    ).toBe(403);
    expect((await api(t, sales.token).get(`/parties/${kkpParty}/promises`)).statusCode).toBe(404);
  });
});

describe('the worklist', () => {
  it('lists customers with something overdue, escalations and due promises first, then the oldest debt', async () => {
    const promised = ok(
      await api(t, b.owner).post(`/parties/${lakshmi}/promises`, {
        amountPaise: 10_000,
        promisedOn: today,
      }),
    ).json<PromiseView>();
    ok(
      await api(t, b.owner).post('/activities', {
        recordType: 'party',
        recordId: krishna,
        type: 'call',
        subject: 'Called about the March bill',
      }),
    );

    const page = await get<WorklistPage>('/collections/worklist');

    expect(page.asOf).toBe(today);
    expect(page.total).toBe(3);
    expect(page.overduePaise).toBe(59_000 - 20_000 + 23_600 + 11_800);
    expect(page.rows.map((row) => [row.name, row.nextStep])).toEqual([
      ['Lakshmi Interiors', 'follow_up_promise'],
      ['Krishna Constructions', 'contact'],
      ['Kukatpally Builders', 'contact'],
    ]);
    const [lakshmiRow, krishnaRow] = page.rows;
    expect(lakshmiRow).toMatchObject({
      partyId: lakshmi,
      salesperson: null,
      overduePaise: 23_600,
      maxDaysPastDue: 10,
      oldestBucket: 'days_0_30',
      openPromise: { id: promised.id, amountPaise: 10_000 },
      openEscalationId: null,
      lastActivity: { type: 'promise_to_pay', subject: `Promised ₹100.00 by ${today}` },
    });
    expect(krishnaRow).toMatchObject({
      salesperson: { id: sales.memberId, name: 'Staff sales_executive' },
      // ₹590 − the ₹200 paid, allocated to the oldest bill first; ₹118 not yet due.
      outstandingPaise: 59_000 - 20_000 + 11_800,
      overduePaise: 39_000,
      maxDaysPastDue: 45,
      oldestBucket: 'days_31_60',
      openPromise: null,
      lastActivity: { type: 'call', subject: 'Called about the March bill' },
    });
  });

  it('narrows to a salesperson, nobody, a store, and pages', async () => {
    const mine = await get<WorklistPage>('/collections/worklist?salespersonId=me', sales.token);
    const nobody = await get<WorklistPage>('/collections/worklist?salespersonId=none');
    const kkp = await get<WorklistPage>(`/collections/worklist?storeId=${b.stores.kkp}`);
    const paged = await get<WorklistPage>('/collections/worklist?limit=1&offset=1');
    const ampStaff = await get<WorklistPage>('/collections/worklist', manager.token);

    expect(mine.rows.map((row) => row.name)).toEqual(['Krishna Constructions']);
    expect(nobody.rows.map((row) => row.name)).toEqual([
      'Lakshmi Interiors',
      'Kukatpally Builders',
    ]);
    expect(kkp.rows.map((row) => row.name)).toEqual(['Kukatpally Builders']);
    expect([paged.total, paged.rows.map((row) => row.name)]).toEqual([
      3,
      ['Krishna Constructions'],
    ]);
    // Kukatpally's customer is not theirs to see.
    expect(ampStaff.rows.map((row) => row.name)).not.toContain('Kukatpally Builders');
  });

  it('is empty when nothing is overdue, refuses other stores and needs receivables:read', async () => {
    const empty = await get<WorklistPage>(
      `/collections/worklist?salespersonId=${manager.memberId}`,
    );
    expect(empty).toEqual({ asOf: today, rows: [], total: 0, overduePaise: 0 });
    expect(
      (await api(t, sales.token).get(`/collections/worklist?storeId=${b.stores.kkp}`)).statusCode,
    ).toBe(404);
    expect((await api(t, employee).get('/collections/worklist')).statusCode).toBe(403);
    expect((await api(t, b.owner).get('/collections/worklist?salespersonId=x')).statusCode).toBe(
      400,
    );
  });
});

describe('the daily collections run', () => {
  it('keeps a promise covered by payments, breaks a lapsed one and escalates it once', async () => {
    await forgetRuns();
    // Lakshmi's open promise is due today: not settled until paid or past its date.
    // Venkat promised ₹100 by yesterday and paid only ₹50 (a bounced cheque does not count).
    const lapsed = await pastPromise(venkat, 10_000, await day(-5), await day(-1));
    await pay(venkat, 5_000, await day(-2));
    const cheque = await pay(venkat, 9_000, await day(-2), {
      modeId: b.modes.cheque.id,
      reference: '112233',
      chequeDate: await day(-2),
    });
    ok(
      await api(t, b.owner).post(`/payments/${cheque.id}/bounce`, {
        bouncedOn: await day(-1),
        reason: 'Funds insufficient',
      }),
    );
    // Krishna promised ₹150 by next week and has paid ₹200 since: kept early.
    const early = await pastPromise(krishna, 15_000, today, await day(7));

    const first = await run();
    const second = await run();

    expect(first).toEqual({ kept: 1, broken: 1, remindersQueued: 0 });
    expect(second).toBeNull();
    const settled = await t.connection.db
      .select({ id: promisesToPay.id, status: promisesToPay.status, paid: promisesToPay.paidPaise })
      .from(promisesToPay)
      .where(sql`${promisesToPay.id} in (${lapsed}, ${early})`);
    expect(new Map(settled.map((row) => [row.id, [row.status, row.paid]]))).toEqual(
      new Map([
        [lapsed, ['broken', 5_000]],
        [early, ['kept', 20_000]],
      ]),
    );
    const [escalation] = await t.connection.db
      .select()
      .from(collectionEscalations)
      .where(eq(collectionEscalations.promiseId, lapsed));
    expect(escalation).toMatchObject({ partyId: venkat, raisedOn: today, acknowledgedAt: null });
    // Venkat has no salesperson: the people who approve credit are told (owner, admin).
    expect(escalation?.notifiedCount).toBeGreaterThanOrEqual(1);
    const [notice] = await t.connection.db
      .select({ title: notifications.title, body: notifications.body, link: notifications.link })
      .from(notifications)
      .where(eq(notifications.event, 'promise_broken'));
    expect(notice).toEqual({
      title: 'Promise broken: Venkat Homes',
      body: `₹100.00 was promised by ${await day(-1)}; ₹50.00 came in.`,
      link: `/parties/${venkat}/ledger`,
    });
  });

  it('tells the salesperson’s branch managers about their customer’s broken promise', async () => {
    await forgetRuns();
    const promiseId = await pastPromise(krishna, 90_000, await day(-3), await day(-1));
    expect(await run()).toMatchObject({ broken: 1 });

    const told = await t.connection.db
      .select({ memberId: notifications.memberId })
      .from(notifications)
      .where(
        and(
          eq(notifications.event, 'promise_broken'),
          eq(notifications.title, 'Promise broken: Krishna Constructions'),
        ),
      );
    expect(told.map((row) => row.memberId)).toContain(manager.memberId);
    const [escalation] = await t.connection.db
      .select({ count: collectionEscalations.notifiedCount })
      .from(collectionEscalations)
      .where(eq(collectionEscalations.promiseId, promiseId));
    expect(escalation?.count).toBe(told.length);
  });

  it('lets only one server run a business at a time, and runs every business once a day', async () => {
    await forgetRuns();
    await withPgClient(database.connectionString, async (holder) => {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('paint:collections'), hashtext($1))",
        [b.organizationId],
      );
      expect(await run()).toBeNull();
      await holder.query('ROLLBACK');
    });

    const all = await runCollectionsForBusinesses(t.connection.db, notifier());
    const again = await runCollectionsForBusinesses(t.connection.db, notifier());
    expect(all).toEqual({ kept: 0, broken: 0, remindersQueued: 0 });
    expect(again).toEqual({ kept: 0, broken: 0, remindersQueued: 0 });
    const runs = await t.connection.db
      .select({ id: collectionRuns.id })
      .from(collectionRuns)
      .where(eq(collectionRuns.organizationId, b.organizationId));
    expect(runs).toHaveLength(1);
  });

  it('skips a business another server is running in the batch', async () => {
    await forgetRuns();
    await withPgClient(database.connectionString, async (holder) => {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('paint:collections'), hashtext($1))",
        [b.organizationId],
      );
      expect(await runCollectionsForBusinesses(t.connection.db, notifier())).toEqual({
        kept: 0,
        broken: 0,
        remindersQueued: 0,
      });
      await holder.query('ROLLBACK');
    });
  });
});

describe('escalations', () => {
  it('are listed for the stores a member sees and acknowledged once', async () => {
    const open = await get<EscalationView[]>('/collections/escalations');
    expect(open.map((e) => e.party.name).sort()).toEqual(['Krishna Constructions', 'Venkat Homes']);
    const [venkatEscalation] = open.filter((e) => e.party.id === venkat) as [EscalationView];
    expect(venkatEscalation).toMatchObject({
      raisedOn: today,
      promise: { partyId: venkat, status: 'broken', paidPaise: 5_000 },
      acknowledgedBy: null,
    });

    const worklist = await get<WorklistPage>('/collections/worklist');
    expect(worklist.rows[0]).toMatchObject({
      name: 'Krishna Constructions',
      nextStep: 'acknowledge_escalation',
    });

    const [krishnaEscalation] = open.filter((e) => e.party.id === krishna) as [EscalationView];
    const hidden = await api(t, kkpSales).post(
      `/collections/escalations/${krishnaEscalation.id}/acknowledge`,
      {},
    );
    const missing = await api(t, sales.token).post(
      `/collections/escalations/${crypto.randomUUID()}/acknowledge`,
      {},
    );
    const done = await api(t, sales.token).post(
      `/collections/escalations/${krishnaEscalation.id}/acknowledge`,
      { note: 'Spoke to the owner; pays Monday' },
    );
    const again = await api(t, sales.token).post(
      `/collections/escalations/${krishnaEscalation.id}/acknowledge`,
      {},
    );
    ok(
      await api(t, b.owner).post(`/collections/escalations/${venkatEscalation.id}/acknowledge`, {}),
    );

    expect([hidden.statusCode, missing.statusCode, done.statusCode, again.statusCode]).toEqual([
      404, 404, 204, 409,
    ]);
    expect(await get<EscalationView[]>('/collections/escalations')).toEqual([]);
    const all = await get<EscalationView[]>('/collections/escalations?open=false&limit=10');
    expect(all.find((e) => e.id === krishnaEscalation.id)).toMatchObject({
      acknowledgedBy: 'Staff sales_executive',
      acknowledgeNote: 'Spoke to the owner; pays Monday',
    });
    expect(all.find((e) => e.id === venkatEscalation.id)?.acknowledgeNote).toBeNull();
    // Kukatpally staff see the business-wide customer's, never Ameerpet's.
    const kkpView = await get<EscalationView[]>('/collections/escalations?open=false', kkpSales);
    expect(kkpView.map((e) => e.party.name)).toEqual(['Venkat Homes']);
  });
});

describe('reminder schedules and reminders', () => {
  it('are set by credit approvers, one per day offset, and turned off by an empty list', async () => {
    const save = (schedules: object[], token = b.owner) =>
      api(t, token).put('/collections/reminder-schedules', { schedules });

    const refused = await save([{ offsetDays: 0, channels: ['sms'] }], manager.token);
    const duplicate = await save([
      { offsetDays: 0, channels: ['sms'] },
      { offsetDays: 0, channels: ['email'] },
    ]);
    const noChannel = await save([{ offsetDays: 0, channels: [] }]);
    const twice = await save([{ offsetDays: 0, channels: ['sms', 'sms'] }]);
    const outOfRange = await save([{ offsetDays: 91, channels: ['sms'] }]);
    ok(await save([{ offsetDays: 30, channels: ['sms'] }]));
    const saved = ok(
      await save([
        { offsetDays: 45, channels: ['whatsapp', 'sms', 'email'] },
        { offsetDays: -10, channels: ['email'], isActive: false },
        { offsetDays: 10, channels: ['sms'] },
      ]),
    ).json<ReminderScheduleView[]>();

    expect([
      refused.statusCode,
      duplicate.statusCode,
      noChannel.statusCode,
      twice.statusCode,
      outOfRange.statusCode,
    ]).toEqual([403, 400, 400, 400, 400]);
    expect(
      saved.map(({ offsetDays, channels, isActive }) => [offsetDays, channels, isActive]),
    ).toEqual([
      [-10, ['email'], false],
      [10, ['sms'], true],
      [45, ['whatsapp', 'sms', 'email'], true],
    ]);
    expect(
      await get<ReminderScheduleView[]>('/collections/reminder-schedules', sales.token),
    ).toEqual(saved);
    expect(ok(await save([])).json()).toEqual([]);
    ok(await save([{ offsetDays: 45, channels: ['whatsapp', 'sms', 'email'] }]));
  });

  it('queue one message per party, channel and day, with consent, never while a promise runs', async () => {
    await forgetRuns();
    // Krishna: ₹590 bill due 45 days ago (₹200 paid). Lakshmi: ₹236 due 10 days ago, but an
    // open promise still runs (due today). Kukatpally: nothing due on those days.
    await grantConsent(krishna, 'whatsapp', 'te');
    await grantConsent(krishna, 'sms');
    await grantConsent(lakshmi, 'sms');

    const first = await run();

    expect(first).toEqual({ kept: 0, broken: 0, remindersQueued: 2 });
    const queued = await t.connection.db
      .select({
        partyId: messageOutbox.partyId,
        channel: messageOutbox.channel,
        templateKey: messageOutbox.templateKey,
        language: messageOutbox.language,
        body: messageOutbox.body,
        dedupeKey: messageOutbox.dedupeKey,
        createdBy: messageOutbox.createdByMemberId,
      })
      .from(messageOutbox)
      .orderBy(messageOutbox.channel);
    expect(queued).toEqual([
      {
        partyId: krishna,
        channel: 'whatsapp',
        templateKey: 'payment_reminder_overdue',
        language: 'te',
        body: expect.stringContaining('₹390.00') as string,
        dedupeKey: `reminder:${krishna}:${today}:whatsapp`,
        createdBy: null,
      },
      {
        partyId: krishna,
        channel: 'sms',
        templateKey: 'payment_reminder_overdue',
        language: 'en',
        body: `Dear Krishna Constructions, ₹390.00 owed to ${(await get<AuthProfile>('/auth/me')).organization.name} is overdue by 45 days. Please pay at the earliest.`,
        dedupeKey: `reminder:${krishna}:${today}:sms`,
        createdBy: null,
      },
    ]);
  });

  it('never remind a party twice a day on a channel: the overdue reminder wins', async () => {
    await forgetRuns();
    ok(
      await api(t, b.owner).put('/collections/reminder-schedules', {
        schedules: [
          { offsetDays: -10, channels: ['sms'] },
          { offsetDays: 45, channels: ['sms'] },
        ],
      }),
    );
    // Today's overdue SMS to Krishna is already queued: the reminder before a due date
    // (his ₹118 bill) is not sent on top of it.
    expect(await run()).toEqual({ kept: 0, broken: 0, remindersQueued: 0 });
  });

  it('remind before the due date with the due date', async () => {
    await forgetRuns();
    // As if today's messages had gone out on an earlier day.
    await t.connection.db.delete(messageOutbox);
    ok(
      await api(t, b.owner).put('/collections/reminder-schedules', {
        schedules: [{ offsetDays: -10, channels: ['sms', 'email'] }],
      }),
    );
    expect(await run()).toEqual({ kept: 0, broken: 0, remindersQueued: 1 });
    const queued = await t.connection.db
      .select({ templateKey: messageOutbox.templateKey, body: messageOutbox.body })
      .from(messageOutbox);
    // No email consent: only the SMS.
    expect(queued).toEqual([
      {
        templateKey: 'payment_reminder_due',
        body: expect.stringContaining(`₹118.00 falls due on ${await day(10)}`) as string,
      },
    ]);
  });
});

describe('the worker', () => {
  it('runs collections and sends messages only between 09:00 and 20:00 India time', async () => {
    await forgetRuns();
    ok(
      await api(t, b.owner).put('/collections/reminder-schedules', {
        schedules: [{ offsetDays: -10, channels: ['sms', 'whatsapp'] }],
      }),
    );
    const worker = t.app.get(NotificationsWorker);
    const night = new Date(`${today}T17:00:00Z`); // 22:30 IST
    const morning = new Date(`${today}T05:00:00Z`); // 10:30 IST

    const atNight = await worker.runOnce(night);
    expect(atNight).toMatchObject({ promisesSettled: 0, remindersQueued: 0, messagesSent: 0 });
    expect(
      await t.connection.db
        .select({ id: collectionRuns.id })
        .from(collectionRuns)
        .where(eq(collectionRuns.organizationId, b.organizationId)),
    ).toEqual([]);

    const inTheMorning = await worker.runOnce(morning);
    // SMS goes through the test SMS sender; WhatsApp is not configured here.
    expect(inTheMorning.messagesSent).toBeGreaterThanOrEqual(1);
    expect(t.sms.sent.map((sms) => sms.message).join('\n')).toContain('Krishna Constructions');
    const whatsapp = await t.connection.db
      .select({ status: messageOutbox.status, reason: messageOutbox.skipReason })
      .from(messageOutbox)
      .where(eq(messageOutbox.channel, 'whatsapp'));
    expect(whatsapp).toEqual([{ status: 'skipped', reason: 'channel_disabled' }]);
  });
});
