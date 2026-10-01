import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { NotificationsWorker } from '../notifications/notifications-worker.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Activity {
  id: string;
  record: { type: string; id: string; label: string };
  type: string;
  subject: string;
  notes: string | null;
  outcome: string | null;
  status: string;
  dueAt: string | null;
  overdue: boolean;
  completedAt: string | null;
  cancelledAt: string | null;
  assignedTo: { memberId: string; name: string };
  createdBy: { memberId: string; name: string };
}
interface FollowUps {
  items: Activity[];
  total: number;
  counts: { overdue: number; today: number };
}
type Response = Awaited<ReturnType<ReturnType<typeof api>['post']>>;

let database: TestDatabase;
let t: TestApp;
let owner: string;
let sales: string;
let sales2: string;
let punSales: string;
let cashier: string;
let hyd: string;
let pune: string;
const ids: Record<string, string> = {};
const members: Record<string, string> = {};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});
const message = (response: Response) => response.json<{ message: string }>().message;
const issues = (response: Response) =>
  response.json<{ issues: { path: string }[] }>().issues.map((issue) => issue.path);
const idOf = async (response: Promise<Response>) => (await response).json<{ id: string }>().id;

/** A date in India, `days` from today, as YYYY-MM-DD. */
const istDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
const at = (days: number, time: string) => `${istDate(days)}T${time}+05:30`;

const log = (token: string, body: object) => api(token).post('/activities', body);
const onLead = (body: object, token = sales) =>
  log(token, {
    recordType: 'lead',
    recordId: ids.lead,
    type: 'call',
    subject: 'Called about the quote',
    ...body,
  });

async function signup(name: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  return response.json<{ token: string }>().token;
}

async function hire(key: string, roleKey: string, storeIds: string[], name: string) {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  members[key] = await idOf(
    api(owner).post('/members', {
      fullName: name,
      phone,
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === roleKey)?.id,
      storeIds,
    }),
  );
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyd = await idOf(api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' }));
  pune = await idOf(api(owner).post('/stores', { name: 'Pune', code: 'PUN' }));
  sales = await hire('sales', 'sales_executive', [hyd], 'Ravi Sales');
  sales2 = await hire('sales2', 'sales_executive', [hyd], 'Anita Sales');
  punSales = await hire('punSales', 'sales_executive', [pune], 'Pune Sales');
  cashier = await hire('cashier', 'store_employee', [hyd], 'Cashier');
  await hire('stockman', 'inventory_manager', [hyd], 'Stock Lead');
  const o = api(owner);
  ids.customer = await idOf(
    o.post('/parties', {
      displayName: 'Sharma Builders',
      phone: uniquePhone(),
      homeStoreId: hyd,
      roles: ['customer'],
    }),
  );
  ids.supplier = await idOf(
    o.post('/parties', { kind: 'organization', displayName: 'Asian Depot', roles: ['supplier'] }),
  );
  ids.punParty = await idOf(
    o.post('/parties', {
      displayName: 'Pune Customer',
      phone: uniquePhone(),
      homeStoreId: pune,
      roles: ['customer'],
    }),
  );
  ids.lead = await idOf(
    o.post('/leads', {
      storeId: hyd,
      partyId: ids.customer,
      title: 'Kondapur tower',
      source: 'phone_call',
    }),
  );
  ids.punLead = await idOf(
    o.post('/leads', {
      storeId: pune,
      partyId: ids.punParty,
      title: 'Pune villa',
      source: 'walk_in',
    }),
  );
  ids.opportunity = await idOf(
    o.post('/opportunities', {
      storeId: hyd,
      partyId: ids.customer,
      title: 'Tower order',
      expectedValuePaise: 1,
    }),
  );
  ids.project = await idOf(
    o.post('/projects', { storeId: hyd, customerPartyId: ids.customer, name: 'Tower site' }),
  );
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('logging and scheduling', () => {
  it('logs something already done, now or at a given time', async () => {
    const now = await onLead({ notes: 'Wants a quote by Friday', outcome: 'Interested' });
    const earlier = await onLead({
      type: 'visit',
      subject: 'Site visit',
      completedAt: at(-1, '16:30:00'),
    });

    expect(now.statusCode).toBe(201);
    expect(now.json<Activity>()).toMatchObject({
      record: { type: 'lead', id: ids.lead },
      type: 'call',
      notes: 'Wants a quote by Friday',
      outcome: 'Interested',
      status: 'done',
      dueAt: null,
      overdue: false,
      assignedTo: { memberId: members.sales, name: 'Ravi Sales' },
      createdBy: { memberId: members.sales, name: 'Ravi Sales' },
    });
    expect(Date.now() - Date.parse(String(now.json<Activity>().completedAt))).toBeLessThan(60_000);
    expect(earlier.json<Activity>().completedAt).toBe(new Date(at(-1, '16:30:00')).toISOString());
  });

  it('schedules a follow-up for someone who can see the record', async () => {
    const response = await onLead({
      type: 'follow_up',
      subject: 'Send revised quote',
      dueAt: at(1, '11:00:00'),
      assignedMemberId: members.sales2,
    });

    expect(response.json<Activity>()).toMatchObject({
      status: 'scheduled',
      dueAt: new Date(at(1, '11:00:00')).toISOString(),
      overdue: false,
      completedAt: null,
      assignedTo: { memberId: members.sales2, name: 'Anita Sales' },
      createdBy: { memberId: members.sales },
    });
  });

  it.each([
    [
      { dueAt: '2026-10-02T11:00:00+05:30', completedAt: '2026-10-01T11:00:00+05:30' },
      'completedAt',
    ],
    [{ dueAt: '2026-10-02T11:00:00+05:30', outcome: 'Too soon' }, 'outcome'],
    [{ dueAt: '2026-10-02 11:00' }, 'dueAt'],
    [{ type: 'fax' }, 'type'],
    [{ recordType: 'store' }, 'recordType'],
    [{ subject: 'x' }, 'subject'],
  ])('answers 400 for %o', async (overrides, field) => {
    const response = await onLead(overrides);

    expect(response.statusCode).toBe(400);
    expect(issues(response)).toContain(field);
  });
});

describe('who can see and add activities', () => {
  it('follows the record’s permissions and store', async () => {
    const supplierCall = await log(sales, {
      recordType: 'party',
      recordId: ids.supplier,
      type: 'whatsapp',
      subject: 'Asked for the new rate list',
    });
    const responses = await Promise.all([
      api(cashier).get(`/activities?recordType=party&recordId=${String(ids.supplier)}`),
      log(cashier, {
        recordType: 'party',
        recordId: ids.supplier,
        type: 'note',
        subject: 'Cashier note',
      }),
      api(cashier).get(`/activities?recordType=lead&recordId=${String(ids.lead)}`),
      onLead({ recordId: ids.punLead }),
      onLead({ dueAt: at(1, '10:00:00'), assignedMemberId: members.stockman }),
      onLead({ dueAt: at(1, '10:00:00'), assignedMemberId: members.punSales }),
      log(sales, {
        recordType: 'party',
        recordId: ids.supplier,
        type: 'follow_up',
        subject: 'Chase the rate list',
        dueAt: at(1, '10:00:00'),
        assignedMemberId: members.punSales,
      }),
    ]);

    expect(supplierCall.statusCode).toBe(201);
    expect(responses.map((r) => [r.statusCode, r.statusCode === 201 ? null : message(r)])).toEqual([
      [200, undefined],
      [403, 'You cannot change activities on this record'],
      [403, 'You cannot see activities on this record'],
      [404, 'Record not found'],
      [400, 'Choose someone who works at this store and handles leads'],
      [400, 'Choose someone who works at this store and handles leads'],
      // A business-wide supplier can be followed up from any store.
      [201, null],
    ]);
  });
});

describe('timelines', () => {
  it('lists a record’s activities latest first, labelled by record', async () => {
    const project = (recordType: string, recordId: string) =>
      log(sales, {
        recordType,
        recordId,
        type: 'meeting',
        subject: 'Kick-off',
        completedAt: at(-2, '10:00:00'),
      });
    await project('project', String(ids.project));
    await log(sales, {
      recordType: 'project',
      recordId: ids.project,
      type: 'visit',
      subject: 'Survey',
      completedAt: at(-1, '10:00:00'),
    });
    await log(sales, {
      recordType: 'project',
      recordId: ids.project,
      type: 'follow_up',
      subject: 'Share specs',
      dueAt: at(3, '10:00:00'),
    });
    await project('opportunity', String(ids.opportunity));

    const timeline = (
      await api(sales).get(`/activities?recordType=project&recordId=${String(ids.project)}`)
    ).json<{
      items: Activity[];
      total: number;
    }>();
    const opportunityTimeline = (
      await api(sales).get(
        `/activities?recordType=opportunity&recordId=${String(ids.opportunity)}&limit=1`,
      )
    ).json<{ items: Activity[]; total: number }>();
    const partyTimeline = (
      await api(sales).get(`/activities?recordType=party&recordId=${String(ids.supplier)}`)
    ).json<{
      items: Activity[];
    }>();
    const leadTimeline = (
      await api(sales).get(`/activities?recordType=lead&recordId=${String(ids.lead)}`)
    ).json<{
      items: Activity[];
    }>();

    expect(timeline.total).toBe(3);
    expect(timeline.items.map((a) => a.subject)).toEqual(['Share specs', 'Survey', 'Kick-off']);
    expect(timeline.items[0]?.record.label).toMatch(/^PJ-\d{6} · Tower site$/);
    expect(opportunityTimeline.items[0]?.record.label).toMatch(/^OP-\d{6} · Tower order$/);
    expect(partyTimeline.items[0]?.record.label).toBe('Asian Depot');
    expect(leadTimeline.items[0]?.record.label).toMatch(/^LD-\d{6} · Kondapur tower$/);
  });
});

describe('my follow-ups', () => {
  it('splits open follow-ups into overdue, today and upcoming, in India time', async () => {
    const owners = await signup('Follow Paints');
    const store = await idOf(api(owners).post('/stores', { name: 'Store', code: 'STR' }));
    const party = await idOf(
      api(owners).post('/parties', { displayName: 'Shared Party', roles: ['customer'] }),
    );
    const lead = await idOf(
      api(owners).post('/leads', {
        storeId: store,
        partyId: party,
        title: 'Lead',
        source: 'walk_in',
      }),
    );
    const follow = (subject: string, dueAt: string, recordType = 'lead', recordId = lead) =>
      api(owners).post('/activities', { recordType, recordId, type: 'follow_up', subject, dueAt });
    const late = (await follow('Yesterday', at(-1, '18:00:00'))).json<Activity>();
    const today = (await follow('Today', at(0, '00:01:00'))).json<Activity>();
    const later = (await follow('Tomorrow', at(1, '09:00:00'))).json<Activity>();
    const partyWide = (
      await follow('Party, next week', at(7, '09:00:00'), 'party', party)
    ).json<Activity>();
    await api(owners).post(
      `/activities/${(await follow('Done already', at(0, '00:02:00'))).json<Activity>().id}/complete`,
    );
    await api(owners).post('/activities', {
      recordType: 'lead',
      recordId: lead,
      type: 'call',
      subject: 'Logged call',
    });

    const list = async (query: string) =>
      (await api(owners).get(`/activities/follow-ups?${query}`)).json<FollowUps>();
    const open = await list('');
    const overdue = await list('when=overdue');
    const todayOnly = await list('when=today');
    const upcoming = await list(`when=upcoming&storeId=${store}`);

    expect(open.items.map((a) => a.id)).toEqual([late.id, today.id, later.id, partyWide.id]);
    expect(open).toMatchObject({ total: 4, counts: { overdue: 1, today: 1 } });
    expect(late.overdue).toBe(true);
    expect(overdue.items.map((a) => a.id)).toEqual([late.id]);
    expect(todayOnly.items.map((a) => a.id)).toEqual([today.id]);
    // A store filter leaves out business-wide parties.
    expect(upcoming).toMatchObject({
      total: 1,
      items: [{ id: later.id }],
      counts: { overdue: 1, today: 1 },
    });
  });

  it('shows a member’s follow-ups to others who can see them, within their stores', async () => {
    await onLead({
      type: 'follow_up',
      subject: 'For Anita',
      dueAt: at(2, '10:00:00'),
      assignedMemberId: members.sales2,
    });

    const asOwner = (
      await api(owner).get(`/activities/follow-ups?assignedTo=${String(members.sales2)}`)
    ).json<FollowUps>();
    const own = (await api(sales2).get('/activities/follow-ups?limit=200')).json<FollowUps>();
    const punView = (
      await api(punSales).get(`/activities/follow-ups?assignedTo=${String(members.sales2)}`)
    ).json<FollowUps>();

    expect(asOwner.items.map((a) => a.subject)).toContain('For Anita');
    expect(own.items.every((a) => a.assignedTo.memberId === members.sales2)).toBe(true);
    expect(punView.total).toBe(0);
    expect((await api(sales).get(`/activities/follow-ups?storeId=${pune}`)).statusCode).toBe(404);
  });
});

describe('changing activities', () => {
  it('reschedules, reassigns, completes with a next step, and cancels', async () => {
    const followUp = (
      await onLead({ type: 'follow_up', subject: 'Quote follow-up', dueAt: at(1, '10:00:00') })
    ).json<Activity>();
    await t.connection.db
      .update(schema.activities)
      .set({ remindedAt: new Date() })
      .where(eq(schema.activities.id, followUp.id));

    const moved = (
      await api(sales).patch(`/activities/${followUp.id}`, {
        dueAt: at(2, '15:00:00'),
        subject: 'Quote follow-up (moved)',
        notes: 'Customer travelling',
      })
    ).json<Activity>();
    const [row] = await t.connection.db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.id, followUp.id));
    const reassigned = (
      await api(sales).patch(`/activities/${followUp.id}`, { assignedMemberId: members.sales2 })
    ).json<Activity>();
    const badAssignee = await api(sales).patch(`/activities/${followUp.id}`, {
      assignedMemberId: members.punSales,
    });
    const cleared = (
      await api(sales).patch(`/activities/${followUp.id}`, { notes: null })
    ).json<Activity>();
    const done = await api(sales).post(`/activities/${followUp.id}/complete`, {
      outcome: 'Agreed on price',
      next: { dueAt: at(5, '11:00:00') },
    });
    const again = await api(sales).post(`/activities/${followUp.id}/complete`);
    const editDone = await api(sales).patch(`/activities/${followUp.id}`, {
      subject: 'Too late now',
    });

    expect(moved).toMatchObject({
      subject: 'Quote follow-up (moved)',
      notes: 'Customer travelling',
    });
    expect(row?.remindedAt).toBeNull();
    expect(reassigned.assignedTo.memberId).toBe(members.sales2);
    expect(badAssignee.statusCode).toBe(400);
    expect(cleared.notes).toBeNull();
    const { completed, next } = done.json<{ completed: Activity; next: Activity }>();
    expect(completed).toMatchObject({ status: 'done', outcome: 'Agreed on price' });
    expect(next).toMatchObject({
      status: 'scheduled',
      type: 'follow_up',
      subject: 'Quote follow-up (moved)',
      record: { type: 'lead', id: ids.lead },
      assignedTo: { memberId: members.sales2 },
      dueAt: new Date(at(5, '11:00:00')).toISOString(),
    });
    expect([again.statusCode, message(again)]).toEqual([409, 'This activity is already done']);
    expect(editDone.statusCode).toBe(409);

    const plain = (
      await api(sales).post(`/activities/${next.id}/complete`, {
        next: { dueAt: at(9, '10:00:00'), subject: 'Visit', type: 'visit' },
      })
    ).json<{
      next: Activity;
    }>();
    expect(plain.next).toMatchObject({ subject: 'Visit', type: 'visit' });
    const cancelled = (
      await api(sales).post(`/activities/${plain.next.id}/cancel`)
    ).json<Activity>();
    const cancelAgain = await api(sales).post(`/activities/${plain.next.id}/cancel`);
    const noNext = (
      await api(sales).post(
        `/activities/${(await onLead({ type: 'follow_up', dueAt: at(1, '12:00:00') })).json<Activity>().id}/complete`,
      )
    ).json<{
      next: Activity | null;
    }>();

    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String) });
    expect([cancelAgain.statusCode, message(cancelAgain)]).toEqual([
      409,
      'This activity was cancelled',
    ]);
    expect(noNext.next).toBeNull();
    expect((await api(sales).patch(`/activities/${followUp.id}`, {})).statusCode).toBe(400);
  });

  it('answers 404 for activities that do not exist or belong to other stores', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const punActivity = (
      await log(punSales, {
        recordType: 'lead',
        recordId: ids.punLead,
        type: 'call',
        subject: 'Pune call',
      })
    ).json<Activity>();

    expect((await api(sales).get(`/activities/${ghost}`)).statusCode).toBe(404);
    expect((await api(sales).post(`/activities/${ghost}/cancel`)).statusCode).toBe(404);
    expect((await api(sales).get(`/activities/${punActivity.id}`)).statusCode).toBe(404);
    expect((await api(punSales).get(`/activities/${punActivity.id}`)).statusCode).toBe(200);
  });
});

describe('reminders', () => {
  it('reminds the assignee once when a follow-up falls due, and again after rescheduling', async () => {
    const worker = t.app.get(NotificationsWorker);
    await worker.remindFollowUps();
    const soon = new Date(Date.now() + 10 * 60_000);
    const due = (
      await onLead({
        type: 'follow_up',
        subject: 'Call before the site meeting',
        dueAt: soon.toISOString(),
        assignedMemberId: members.sales2,
      })
    ).json<Activity>();
    const supplierDue = (
      await log(sales, {
        recordType: 'party',
        recordId: ids.supplier,
        type: 'follow_up',
        subject: 'Rates',
        dueAt: soon.toISOString(),
      })
    ).json<Activity>();
    await onLead({
      type: 'follow_up',
      subject: 'Not yet',
      dueAt: at(2, '10:00:00'),
      assignedMemberId: members.sales2,
    });

    const first = await worker.remindFollowUps();
    const second = await worker.remindFollowUps();
    const inbox = async (token: string) =>
      (await api(token).get('/notifications'))
        .json<{ items: { event: string; title: string; body: string; link: string }[] }>()
        .items.filter((n) => n.event === 'follow_up_due');

    expect([first, second]).toEqual([2, 0]);
    const [notice] = await inbox(sales2);
    expect(notice).toMatchObject({
      title: 'Follow-up due: Call before the site meeting',
      link: `/leads/${String(ids.lead)}`,
    });
    expect(notice?.body).toMatch(
      /^LD-\d{6} · Kondapur tower — due \d{2} \w{3} \d{4}, \d{2}:\d{2} [AP]M \(IST\)$/,
    );
    expect((await inbox(sales))[0]).toMatchObject({
      title: 'Follow-up due: Rates',
      link: `/parties/${String(ids.supplier)}`,
    });
    expect((await inbox(owner)).length).toBe(0);

    await api(sales).patch(`/activities/${due.id}`, {
      dueAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    expect(await worker.remindFollowUps()).toBe(1);
    expect(await inbox(sales2)).toHaveLength(2);
    expect(supplierDue.status).toBe('scheduled');
  });
});
