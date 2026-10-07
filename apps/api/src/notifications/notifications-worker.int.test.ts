import { Logger } from '@nestjs/common';
import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { MAX_EMAIL_ATTEMPTS, NotificationsWorker } from './notifications-worker.js';

interface MailpitMessage {
  To: { Address: string }[];
  Subject: string;
  Snippet: string;
}

const emailEnv = () => ({
  EMAIL_PROVIDER: 'smtp',
  SMTP_URL: inject('mailSmtpUrl'),
  EMAIL_FROM: 'ABC Paints <alerts@abc.example>',
});

let database: TestDatabase;
let t: TestApp;
let owner: string;
let manager: string;
let managerEmail: string;
let hyd: string;
let ownerMember: string;
let seq = 0;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
});
const worker = (app: TestApp = t) => app.app.get(NotificationsWorker);

/** Messages Mailpit caught for one address. */
async function mailFor(address: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${inject('mailApiUrl')}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

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

/** A product at HYD with a reorder level of 5, stocked with `quantity`. */
async function product(quantity: number): Promise<{ id: string; sku: string }> {
  seq += 1;
  const sku = `LOW-${String(seq)}`;
  const brandId = (await api(owner).post('/brands', { name: `Brand ${String(seq)}` })).json<{
    id: string;
  }>().id;
  const id = String(
    (
      await api(owner).post('/products', {
        brandId,
        name: `Paint ${String(seq)}`,
        type: 'interior_paint',
        hsnCode: '3209',
        variants: [{ sku, packSize: 1, unit: 'l' }],
      })
    ).json<{ variants: { id: string }[] }>().variants[0]?.id,
  );
  if (quantity > 0) {
    await api(owner).post('/stock/movements', {
      storeId: hyd,
      type: 'opening',
      lines: [{ variantId: id, quantity }],
    });
  }
  await api(owner).put('/reorder-rules', {
    rules: [{ storeId: hyd, variantId: id, minQuantity: 2, reorderLevel: 5, maxQuantity: 20 }],
  });
  return { id, sku };
}

const move = (variantId: string, quantity: number) =>
  api(owner).post('/stock/movements', {
    storeId: hyd,
    type: 'adjustment',
    note: 'Test movement',
    lines: [{ variantId, quantity }],
  });

const lowNotices = async (token: string) =>
  (await api(token).get('/notifications'))
    .json<{ items: { event: string; title: string; body: string; link: string }[] }>()
    .items.filter((n) => n.event === 'low_stock');

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    ...emailEnv(),
    APP_URL: 'https://app.abc.example',
  });
  owner = await signup('ABC Paints');
  // The only member so far is the owner who signed up.
  ownerMember = String((await t.connection.db.select().from(schema.organizationMembers))[0]?.id);
  hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  managerEmail = `manager.${phone.slice(-6)}@abc.example`;
  await api(owner).post('/members', {
    fullName: 'Hyd Manager',
    phone,
    email: managerEmail,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === 'branch_manager')?.id,
    storeIds: [hyd],
  });
  manager = (
    await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Staff@2026' },
    })
  ).json<{ token: string }>().token;
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('low stock', () => {
  it('announces products at or below their reorder level once per dip, one notice per store', async () => {
    // Another business with an all-stores owner must never hear about ours.
    const other = await signup('XYZ Paints');
    const healthy = await product(10);
    const empty = await product(0);
    const dipping = await product(8);

    const first = await worker().runOnce();
    const again = await worker().runOnce();
    await move(dipping.id, -4);
    const afterDip = await worker().runOnce();

    expect(first).toEqual({
      lowStock: 1,
      followUps: 0,
      contractRenewals: 0,
      loyaltyExpiries: 0,
      emailsSent: 1,
      emailsFailed: 0,
    });
    expect(again).toEqual({
      lowStock: 0,
      followUps: 0,
      contractRenewals: 0,
      loyaltyExpiries: 0,
      emailsSent: 0,
      emailsFailed: 0,
    });
    expect(afterDip.lowStock).toBe(1);
    const notices = await lowNotices(manager);
    expect(notices).toEqual([
      expect.objectContaining({
        event: 'low_stock',
        title: 'Low stock at Hyderabad: 1 product(s)',
        body: `${dipping.sku} Paint ${String(seq)} 1 l: 4 left (reorder at 5)`,
        link: `/stock/low?storeId=${hyd}`,
      }),
      expect.objectContaining({
        body: `${empty.sku} Paint ${String(seq - 1)} 1 l: 0 left (reorder at 5)`,
      }),
    ]);
    expect(notices.map((n) => n.body).join()).not.toContain(healthy.sku);
    // The owner works at every store too.
    expect(await lowNotices(owner)).toHaveLength(2);
    expect(await lowNotices(other)).toEqual([]);

    const mail = await mailFor(managerEmail);
    expect(mail.map((m) => m.Subject)).toEqual([
      'Low stock at Hyderabad: 1 product(s)',
      'Low stock at Hyderabad: 1 product(s)',
    ]);
    expect(mail[0]?.Snippet).toContain(`Open it: https://app.abc.example/stock/low?storeId=${hyd}`);
  });

  it('announces a product again after it recovers and dips once more, grouping a store’s products', async () => {
    const a = await product(6);
    const b = await product(6);
    await move(a.id, -2);
    await worker().runOnce();
    await move(a.id, 10);
    await worker().runOnce();

    await move(a.id, -12);
    await move(b.id, -3);
    const run = await worker().runOnce();

    expect(run.lowStock).toBe(2);
    const [latest] = await lowNotices(manager);
    expect(latest?.title).toBe('Low stock at Hyderabad: 2 product(s)');
    expect(latest?.body.split('\n')).toEqual([
      `${a.sku} Paint ${String(seq - 1)} 1 l: 2 left (reorder at 5)`,
      `${b.sku} Paint ${String(seq)} 1 l: 3 left (reorder at 5)`,
    ]);
  });

  it('lets only one server check at a time', async () => {
    const c = await product(1);
    const holder = new pg.Client({ connectionString: database.connectionString });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('paint:low-stock-check'))`);
      expect(await worker().checkLowStock()).toBe(0);
    } finally {
      await holder.end();
    }

    expect(await worker().checkLowStock()).toBe(1);
    expect((await lowNotices(manager))[0]?.body).toContain(c.sku);
    // Send the email it queued, so later tests start with an empty outbox.
    expect(await worker().sendDueEmails()).toEqual({ sent: 1, failed: 0 });
  });
});

const queue = async (
  toAddress: string,
  values: Partial<typeof schema.emailOutbox.$inferInsert> = {},
): Promise<string> => {
  const [member] = await t.connection.db
    .select()
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.id, ownerMember));
  const [row] = await t.connection.db
    .insert(schema.emailOutbox)
    .values({
      organizationId: String(member?.organizationId),
      memberId: ownerMember,
      event: 'low_stock',
      toAddress,
      subject: 'Queued by a test',
      textBody: 'Hello',
      ...values,
    })
    .returning();
  return String(row?.id);
};
const outbox = async (id: string) =>
  (await t.connection.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, id)))[0];

describe('sending email', () => {
  it('retries failures with growing gaps, then gives up', async () => {
    const broken = await startTestApp(database.connectionString, {
      ...emailEnv(),
      SMTP_URL: 'smtp://127.0.0.1:1',
    });
    try {
      const id = await queue('nobody@abc.example');

      const run = await worker(broken).sendDueEmails();
      const afterFirst = await outbox(id);
      // Not due yet, so a second run leaves it alone.
      const notDue = await worker(broken).sendDueEmails();
      await t.connection.db
        .update(schema.emailOutbox)
        .set({ attempts: MAX_EMAIL_ATTEMPTS - 1, nextAttemptAt: sql`now()` })
        .where(eq(schema.emailOutbox.id, id));
      await worker(broken).sendDueEmails();
      const givenUp = await outbox(id);

      expect(run).toEqual({ sent: 0, failed: 1 });
      expect(afterFirst).toMatchObject({ status: 'pending', attempts: 1, sentAt: null });
      expect(afterFirst?.lastError).toMatch(/ECONNREFUSED/);
      expect(Number(afterFirst?.nextAttemptAt) - Date.now()).toBeGreaterThan(60_000);
      expect(notDue).toEqual({ sent: 0, failed: 0 });
      expect(givenUp).toMatchObject({ status: 'failed', attempts: MAX_EMAIL_ATTEMPTS });
    } finally {
      await broken.close();
    }
  });

  it('leaves email queued when the server has no email set up', async () => {
    const quiet = await startTestApp(database.connectionString);
    try {
      const id = await queue('later@abc.example');

      expect(await worker(quiet).sendDueEmails()).toEqual({ sent: 0, failed: 0 });
      expect((await outbox(id))?.status).toBe('pending');

      await worker().sendDueEmails();
      expect(await outbox(id)).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
      expect((await mailFor('later@abc.example')).map((m) => m.Subject)).toEqual([
        'Queued by a test',
      ]);
    } finally {
      await quiet.close();
    }
  });
});

describe('running on a timer', () => {
  it('sends queued email by itself, and logs each job that fails without stopping', async () => {
    const timed = await startTestApp(database.connectionString, {
      ...emailEnv(),
      WORKER_INTERVAL_SECONDS: '1',
    });
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const id = await queue('timer@abc.example', { subject: 'Sent by the timer' });

      await vi.waitFor(
        async () => {
          expect((await outbox(id))?.status).toBe('sent');
        },
        { timeout: 10_000, interval: 200 },
      );

      // Break the timed app's database connection; its next run fails and is logged.
      await timed.connection.close();
      await vi.waitFor(
        () => {
          expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^Low stock check failed: /));
          expect(errors).toHaveBeenCalledWith(
            expect.stringMatching(/^Follow-up reminders failed: /),
          );
          expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^Sending email failed: /));
        },
        { timeout: 10_000, interval: 200 },
      );
    } finally {
      errors.mockRestore();
      await timed.close();
    }
  });
});
