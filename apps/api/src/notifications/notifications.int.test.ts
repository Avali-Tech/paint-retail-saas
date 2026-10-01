import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Notification {
  id: string;
  event: string;
  title: string;
  body: string;
  link: string;
  readAt: string | null;
}
interface Page {
  items: Notification[];
  total: number;
  unread: number;
}

const EMAIL_ENV = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_URL: 'smtp://localhost:2525',
  EMAIL_FROM: 'ABC Paints <alerts@abc.example>',
  APP_URL: 'https://app.abc.example/',
};

let database: TestDatabase;
let t: TestApp;
let owner: string;
let hydManager: string;
let puneManager: string;
let puneManager2: string;
let puneEmployee: string;
let hyd: string;
let pune: string;
let variant: string;
let seq = 0;

const api = (token: string, app = () => t) => ({
  get: (url: string) => app().app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    app().app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    app().app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
});

const inbox = async (token: string, query = '') =>
  (await api(token).get(`/notifications${query}`)).json<Page>();

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

async function hire(roleKey: string, storeIds: string[], name: string, email?: string) {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await api(owner).post('/members', {
    fullName: name,
    phone,
    ...(email ? { email } : {}),
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    storeIds,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

/** Emails queued since the last call, as [to, subject] pairs. */
let seenEmails = 0;
async function newEmails() {
  const rows = await t.connection.db
    .select()
    .from(schema.emailOutbox)
    .orderBy(asc(schema.emailOutbox.createdAt), asc(schema.emailOutbox.toAddress));
  const fresh = rows.slice(seenEmails);
  seenEmails = rows.length;
  return fresh;
}

async function requestTransfer(token = hydManager) {
  seq += 1;
  return (
    await api(token).post('/transfers', {
      fromStoreId: pune,
      toStoreId: hyd,
      note: `Request ${String(seq)}`,
      lines: [{ variantId: variant, quantity: 1 }],
    })
  ).json<{ id: string; number: string }>();
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, EMAIL_ENV);
  owner = await signup('ABC Paints');
  hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  pune = (await api(owner).post('/stores', { name: 'Pune', code: 'PUN' })).json<{ id: string }>()
    .id;
  hydManager = await hire('branch_manager', [hyd], 'Hyd Manager', 'hyd@abc.example');
  puneManager = await hire('branch_manager', [pune], 'Pune Manager', 'pune@abc.example');
  puneManager2 = await hire('inventory_manager', [pune], 'Pune Stock Lead');
  puneEmployee = await hire('store_employee', [pune], 'Pune Cashier', 'cashier@abc.example');
  const brandId = (await api(owner).post('/brands', { name: 'Asian Paints' })).json<{
    id: string;
  }>().id;
  variant = String(
    (
      await api(owner).post('/products', {
        brandId,
        name: 'Apex',
        type: 'exterior_paint',
        hsnCode: '3209',
        gstRatePercent: 18,
        variants: [{ sku: 'APX-1L', packSize: 1, unit: 'l' }],
      })
    ).json<{ variants: { id: string }[] }>().variants[0]?.id,
  );
  await api(owner).post('/stock/movements', {
    storeId: pune,
    type: 'opening',
    lines: [{ variantId: variant, quantity: 100, unitCostPaise: 50_000 }],
  });
  await newEmails();
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('who hears about what', () => {
  it('asks the sending store’s stock managers to approve a transfer request', async () => {
    const transfer = await requestTransfer();

    const [first] = (await inbox(puneManager)).items;
    expect(first).toMatchObject({
      event: 'transfer_awaiting_approval',
      title: `Transfer ${transfer.number} needs your approval`,
      body: 'Hyderabad has asked Pune for 1 product(s).',
      link: `/transfers/${transfer.id}`,
      readAt: null,
    });
    expect((await inbox(puneManager2)).items[0]?.link).toBe(`/transfers/${transfer.id}`);
    // The owner works at every store.
    expect((await inbox(owner)).items[0]?.link).toBe(`/transfers/${transfer.id}`);
    // Not the requester, nor staff without stock permissions, nor other stores.
    expect((await inbox(hydManager)).total).toBe(0);
    expect((await inbox(puneEmployee)).total).toBe(0);

    const emails = await newEmails();
    // Only members with an email address get one.
    expect(emails.map((e) => [e.toAddress, e.subject, e.status])).toEqual([
      ['pune@abc.example', `Transfer ${transfer.number} needs your approval`, 'pending'],
    ]);
    expect(emails[0]?.textBody).toBe(
      [
        'Hyderabad has asked Pune for 1 product(s).',
        '',
        `Open it: https://app.abc.example/transfers/${transfer.id}`,
        '',
        'You can choose which emails you get under Settings → Notifications.',
      ].join('\n'),
    );
  });

  it('tells the receiving store when a transfer is dispatched', async () => {
    const transfer = await requestTransfer();
    await api(puneManager).post(`/transfers/${transfer.id}/approve`);
    await api(puneManager).post(`/transfers/${transfer.id}/dispatch`);

    const [latest] = (await inbox(hydManager)).items;
    expect(latest).toMatchObject({
      event: 'transfer_awaiting_receipt',
      title: `Transfer ${transfer.number} is on its way`,
      body: 'Pune has dispatched 1 product(s) to Hyderabad. Record what arrives.',
    });
    expect((await newEmails()).map((e) => [e.toAddress, e.event])).toEqual([
      ['pune@abc.example', 'transfer_awaiting_approval'],
      ['hyd@abc.example', 'transfer_awaiting_receipt'],
    ]);
  });

  it('asks for a submitted stock count to be approved by someone else', async () => {
    const count = (await api(puneManager).post('/stock-counts', { storeId: pune })).json<{
      id: string;
      number: string;
    }>();
    await api(puneManager).post(`/stock-counts/${count.id}/submit`, { uncountedAsZero: true });

    expect((await inbox(puneManager2)).items[0]).toMatchObject({
      event: 'stock_count_awaiting_approval',
      title: `Stock count ${count.number} needs your approval`,
      body: 'Pune Manager has counted 1 product(s) at Pune. Check the differences and approve.',
      link: `/stock-counts/${count.id}`,
    });
    expect((await inbox(owner)).items[0]?.event).toBe('stock_count_awaiting_approval');
    expect((await inbox(puneManager)).items[0]?.event).not.toBe('stock_count_awaiting_approval');
    // Nobody else with an email address manages Pune's stock.
    expect(await newEmails()).toEqual([]);
  });
});

describe('preferences', () => {
  it('starts with every channel on, and saves changes per event', async () => {
    const defaults = (await api(hydManager).get('/notifications/preferences')).json<
      { event: string; title: string; inApp: boolean; email: boolean }[]
    >();
    const saved = await api(hydManager).put('/notifications/preferences', {
      preferences: [
        { event: 'transfer_awaiting_receipt', inApp: false, email: true },
        { event: 'low_stock', inApp: true, email: false },
      ],
    });
    const changedAgain = await api(hydManager).put('/notifications/preferences', {
      preferences: [{ event: 'low_stock', inApp: false, email: false }],
    });

    expect(defaults).toEqual([
      {
        event: 'transfer_awaiting_approval',
        title: 'A transfer needs your approval',
        inApp: true,
        email: true,
      },
      {
        event: 'transfer_awaiting_receipt',
        title: 'A transfer is on its way to your store',
        inApp: true,
        email: true,
      },
      {
        event: 'stock_count_awaiting_approval',
        title: 'A stock count needs your approval',
        inApp: true,
        email: true,
      },
      {
        event: 'low_stock',
        title: 'A product falls to its reorder level',
        inApp: true,
        email: true,
      },
      {
        event: 'follow_up_due',
        title: 'A follow-up assigned to you is due',
        inApp: true,
        email: true,
      },
      {
        event: 'support_access_requested',
        title: 'Platform support asks to access your business',
        inApp: true,
        email: true,
      },
      {
        event: 'contract_renewal_due',
        title: 'A contract assigned to you is due for renewal',
        inApp: true,
        email: true,
      },
      {
        event: 'credit_request_awaiting_approval',
        title: 'A credit request needs your approval',
        inApp: true,
        email: true,
      },
      {
        event: 'credit_request_decided',
        title: 'Your credit request is approved or rejected',
        inApp: true,
        email: true,
      },
      {
        event: 'loyalty_tier_reached',
        title: 'A customer you look after reaches a new loyalty tier',
        inApp: true,
        email: true,
      },
    ]);
    expect(saved.statusCode).toBe(200);
    expect(
      changedAgain
        .json<{ event: string; inApp: boolean; email: boolean }[]>()
        .map((p) => [p.event, p.inApp, p.email]),
    ).toEqual([
      ['transfer_awaiting_approval', true, true],
      ['transfer_awaiting_receipt', false, true],
      ['stock_count_awaiting_approval', true, true],
      ['low_stock', false, false],
      ['follow_up_due', true, true],
      ['support_access_requested', true, true],
      ['contract_renewal_due', true, true],
      ['credit_request_awaiting_approval', true, true],
      ['credit_request_decided', true, true],
      ['loyalty_tier_reached', true, true],
    ]);
    const duplicate = await api(hydManager).put('/notifications/preferences', {
      preferences: [
        { event: 'low_stock', inApp: true, email: true },
        { event: 'low_stock', inApp: true, email: true },
      ],
    });
    expect(duplicate.statusCode).toBe(400);
  });

  it('skips the channels a member turned off', async () => {
    // Hyd Manager keeps email only (set above); the owner turns this event off entirely.
    await api(owner).put('/notifications/preferences', {
      preferences: [{ event: 'transfer_awaiting_receipt', inApp: false, email: false }],
    });
    const before = (await inbox(hydManager)).total;
    const ownerBefore = (await inbox(owner)).total;
    const transfer = await requestTransfer();
    await api(puneManager).post(`/transfers/${transfer.id}/approve`);
    await api(puneManager).post(`/transfers/${transfer.id}/dispatch`);

    expect((await inbox(hydManager)).total).toBe(before);
    // The owner still hears about the new request, but not the dispatch.
    expect((await inbox(owner)).total).toBe(ownerBefore + 1);
    expect((await newEmails()).map((e) => [e.toAddress, e.event])).toEqual([
      ['pune@abc.example', 'transfer_awaiting_approval'],
      ['hyd@abc.example', 'transfer_awaiting_receipt'],
    ]);
  });
});

describe('the notification centre', () => {
  it('lists newest first with the unread count, and marks notifications read', async () => {
    const all = await inbox(puneManager2);
    const [newest, second] = all.items;

    const marked = await api(puneManager2).post(`/notifications/${String(newest?.id)}/read`);
    const markedAgain = await api(puneManager2).post(`/notifications/${String(newest?.id)}/read`);
    const othersNotification = await api(owner).post(`/notifications/${String(newest?.id)}/read`);
    const unread = await inbox(puneManager2, '?unread=true&limit=1');
    const firstReadAt = (await inbox(puneManager2)).items[0]?.readAt;

    expect(all.unread).toBe(all.total);
    expect(all.total).toBeGreaterThanOrEqual(3);
    expect(marked.statusCode).toBe(204);
    expect(markedAgain.statusCode).toBe(204);
    expect(othersNotification.statusCode).toBe(404);
    expect(unread).toMatchObject({ total: all.total - 1, unread: all.total - 1 });
    expect(unread.items.map((n) => n.id)).toEqual([second?.id]);
    expect(firstReadAt).toEqual(expect.any(String));

    const readAll = await api(puneManager2).post('/notifications/read-all');
    expect(readAll.json<{ marked: number }>()).toEqual({ marked: all.total - 1 });
    expect(await inbox(puneManager2, '?unread=true')).toEqual({ items: [], total: 0, unread: 0 });
    expect((await t.app.inject({ method: 'GET', url: '/notifications' })).statusCode).toBe(401);
  });
});

describe('with email turned off', () => {
  it('still notifies in the app, but queues no email', async () => {
    const quiet = await startTestApp(database.connectionString);
    try {
      const transfer = (
        await api(hydManager, () => quiet).post('/transfers', {
          fromStoreId: pune,
          toStoreId: hyd,
          lines: [{ variantId: variant, quantity: 1 }],
        })
      ).json<{ id: string }>();

      expect((await inbox(puneManager)).items[0]?.link).toBe(`/transfers/${transfer.id}`);
      expect(await newEmails()).toEqual([]);
    } finally {
      await quiet.close();
    }
  });
});
