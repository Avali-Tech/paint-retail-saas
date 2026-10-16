import { Logger } from '@nestjs/common';
import { migrateDatabase, schema, withTenant } from '@paint/db';
import type {
  MessageView,
  MessagingStatus,
  PartyConsentsView,
  QueueResult,
  TemplateView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { LogMessagingProvider } from './messaging-provider.js';
import {
  MAX_MESSAGE_ATTEMPTS,
  queueMessage,
  sendDueMessages,
  type MessageToQueue,
} from './outbox.js';

const { messageOutbox } = schema;

let database: TestDatabase;
/** WhatsApp through the log provider, email set up, SMS through the fake. */
let t: TestApp;
/** Nothing configured. */
let off: TestApp;
let b: BillingBusiness;
let manager: string;
let employee: string;
let ravi: string;
let ravisPhone: string;
let suresh: string;

const consent = (partyId: string, body: object, token = b.owner) =>
  api(t, token).post(`/parties/${partyId}/consents`, {
    channel: 'whatsapp',
    state: 'granted',
    method: 'counter_with_notice',
    language: 'en',
    noticeVersion: '2026-10',
    ...body,
  });

const queue = (message: Partial<MessageToQueue> & { partyId: string }): Promise<QueueResult> =>
  withTenant(t.connection.db, b.organizationId, (tx) =>
    queueMessage(tx, {
      organizationId: b.organizationId,
      channel: 'whatsapp',
      templateKey: 'order_ready',
      variables: { number: 'SO-000042' },
      memberId: null,
      ...message,
    }),
  );

const outboxRow = async (id: string) =>
  (await t.connection.db.select().from(messageOutbox).where(eq(messageOutbox.id, id)))[0];

const messageId = (result: QueueResult) => {
  if (!result.queued) throw new Error(`Not queued: ${result.reason}`);
  return result.messageId;
};

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    MESSAGING_PROVIDER: 'log',
    EMAIL_PROVIDER: 'smtp',
    SMTP_URL: 'smtp://127.0.0.1:1',
    EMAIL_FROM: 'ABC Paints <alerts@abc.example>',
  });
  off = await startTestApp(database.connectionString, {}, { fakeSms: false });
  b = await billingBusiness(t);
  manager = await b.member('branch_manager', [b.stores.amp]);
  employee = await b.member('store_employee', [b.stores.amp]);
  ravisPhone = uniquePhone();
  ravi = ok(
    await api(t, b.owner).post('/parties', {
      displayName: 'Ravi Painter',
      phone: ravisPhone,
      email: 'ravi.painter@example.in',
      roles: ['painter'],
    }),
  ).json<{ id: string }>().id;
  suresh = ok(
    await api(t, b.owner).post('/parties', {
      displayName: 'Suresh Kukatpally',
      phone: uniquePhone(),
      homeStoreId: b.stores.kkp,
      roles: ['customer'],
    }),
  ).json<{ id: string }>().id;
});

afterAll(async () => {
  await t.close();
  await off.close();
  await database.stop();
});

describe('what the server can send on', () => {
  it('reports the configured channels to any member', async () => {
    expect(ok(await api(t, employee).get('/messaging/status')).json<MessagingStatus>()).toEqual({
      whatsapp: 'log',
      sms: true,
      email: true,
    });
    expect(ok(await api(off, b.owner).get('/messaging/status')).json<MessagingStatus>()).toEqual({
      whatsapp: null,
      sms: false,
      email: false,
    });
  });

  it('sends party SMS through the sign-in SMS provider when it prints to the log', async () => {
    const printing = await startTestApp(
      database.connectionString,
      { SMS_PROVIDER: 'log' },
      { fakeSms: false },
    );
    try {
      expect(
        ok(await api(printing, b.owner).get('/messaging/status')).json<MessagingStatus>().sms,
      ).toBe(true);
    } finally {
      await printing.close();
    }
  });
});

describe('consent', () => {
  it('is recorded at the party’s current address after the current notice, and kept as history', async () => {
    ok(await consent(ravi, { language: 'te' }));
    ok(await consent(ravi, { channel: 'email', method: 'signed_form' }));
    const withdrawn = ok(
      await consent(ravi, { channel: 'email', state: 'withdrawn' }),
    ).json<PartyConsentsView>();

    expect(withdrawn.phone).toBe(ravisPhone);
    expect(withdrawn.email).toBe('ravi.painter@example.in');
    expect(withdrawn.current.map((c) => [c.channel, c.state, c.address, c.language])).toEqual([
      ['whatsapp', 'granted', ravisPhone, 'te'],
      ['email', 'withdrawn', 'ravi.painter@example.in', 'en'],
    ]);
    expect(withdrawn.history.map((c) => [c.channel, c.state, c.method])).toEqual([
      ['email', 'withdrawn', 'counter_with_notice'],
      ['email', 'granted', 'signed_form'],
      ['whatsapp', 'granted', 'counter_with_notice'],
    ]);
    expect(withdrawn.history[0]).toMatchObject({ recordedBy: 'Owner', noticeVersion: '2026-10' });
    // Anyone who sees parties may read it.
    expect(ok(await api(t, employee).get(`/parties/${ravi}/consents`)).json()).toEqual(withdrawn);
  });

  it('needs an address, the current notice, a staff method and parties:manage', async () => {
    const noEmail = await consent(suresh, { channel: 'email' });
    const noPhone = ok(
      await api(t, b.owner).post('/parties', { displayName: 'No Phone', roles: ['customer'] }),
    ).json<{ id: string }>().id;
    const noMobile = await consent(noPhone, { channel: 'sms' });
    const oldNotice = await consent(ravi, { noticeVersion: '2025-01' });
    const byReply = await consent(ravi, { method: 'whatsapp_reply' });

    expect([noEmail.statusCode, noMobile.statusCode, oldNotice.statusCode]).toEqual([
      400, 400, 400,
    ]);
    expect(noEmail.json<{ issues: { message: string }[] }>().issues[0]?.message).toBe(
      'Add the customer’s email address first',
    );
    expect(noMobile.json<{ issues: { message: string }[] }>().issues[0]?.message).toBe(
      'Add the customer’s mobile number first',
    );
    expect(issuesOf(oldNotice)).toEqual(['noticeVersion']);
    expect(byReply.statusCode).toBe(400);
    expect((await consent(ravi, {}, employee)).statusCode).toBe(403);
    expect((await api(t, manager).get(`/parties/${suresh}/consents`)).statusCode).toBe(404);
    expect((await consent(suresh, {}, manager)).statusCode).toBe(404);
  });
});

describe('templates', () => {
  it('list every message in every channel and language, and are reworded or reset by the owner', async () => {
    const all = ok(await api(t, b.owner).get('/message-templates')).json<TemplateView[]>();
    expect(all).toHaveLength(9 * 3 * 3);
    expect(all[0]).toEqual({
      key: 'invoice_issued',
      channel: 'whatsapp',
      language: 'en',
      body: 'Dear {{name}}, thank you for shopping at {{business}}. Invoice {{number}} for {{amount}}.{{payLink}}',
      variables: ['name', 'business', 'number', 'amount', 'payLink'],
      custom: false,
      providerTemplateName: null,
    });

    const key = { key: 'order_ready', channel: 'whatsapp', language: 'te' };
    const bad = await api(t, b.owner).put('/message-templates', {
      ...key,
      body: 'Hello {{name}}, pay {{amount}}',
    });
    const badName = await api(t, b.owner).put('/message-templates', {
      ...key,
      body: 'Hi',
      providerTemplateName: 'Order Ready',
    });
    const refused = await api(t, manager).put('/message-templates', { ...key, body: 'Hi' });
    ok(await api(t, b.owner).put('/message-templates', { ...key, body: 'First wording' }));
    const saved = ok(
      await api(t, b.owner).put('/message-templates', {
        ...key,
        body: '{{name}} గారు, మీ ఆర్డర్ {{number}} సిద్ధం — {{business}}',
        providerTemplateName: 'order_ready_te_v2',
      }),
    ).json<TemplateView[]>();

    expect([bad.statusCode, badName.statusCode, refused.statusCode]).toEqual([400, 400, 403]);
    expect(bad.json<{ issues: { message: string }[] }>().issues[0]?.message).toBe(
      '{{amount}} is not a variable of this message',
    );
    const own = saved.find(
      (v) => v.key === 'order_ready' && v.channel === 'whatsapp' && v.language === 'te',
    );
    expect(own).toMatchObject({ custom: true, providerTemplateName: 'order_ready_te_v2' });

    // The business's wording is what goes out, and the BSP name rides along.
    const result = await queue({ partyId: ravi });
    expect((await outboxRow(messageId(result)))?.body).toBe(
      `Ravi Painter గారు, మీ ఆర్డర్ SO-000042 సిద్ధం — ${String(
        (
          await t.connection.db.execute<{ name: string }>(
            sql`select name from organizations where id = ${b.organizationId}`,
          )
        ).rows[0]?.name,
      )}`,
    );

    const reset = ok(
      await api(t, b.owner).delete('/message-templates/order_ready/whatsapp/te'),
    ).json<TemplateView[]>();
    expect(
      reset.find((v) => v.key === 'order_ready' && v.language === 'te' && v.channel === 'whatsapp')
        ?.custom,
    ).toBe(false);
    expect((await api(t, b.owner).delete('/message-templates/nope/whatsapp/te')).statusCode).toBe(
      400,
    );
  });
});

describe('queueing a message', () => {
  it('needs an address and consent at it, and queues once per dedupe key', async () => {
    const noAddress = await queue({ partyId: suresh, channel: 'email' });
    const noConsent = await queue({ partyId: suresh });
    const withdrawn = await queue({ partyId: ravi, channel: 'email' });
    const first = await queue({
      partyId: ravi,
      dedupeKey: 'order:42',
      reference: { type: 'sales_order', id: ravi },
    });
    const again = await queue({ partyId: ravi, dedupeKey: 'order:42' });

    expect(noAddress).toEqual({ queued: false, reason: 'no_address' });
    expect(noConsent).toEqual({ queued: false, reason: 'no_consent' });
    expect(withdrawn).toEqual({ queued: false, reason: 'no_consent' });
    expect(again).toEqual({ queued: false, reason: 'duplicate' });
    expect(await outboxRow(messageId(first))).toMatchObject({
      channel: 'whatsapp',
      language: 'te',
      toAddress: ravisPhone,
      templateKey: 'order_ready',
      referenceType: 'sales_order',
      status: 'queued',
      body: expect.stringContaining('SO-000042') as string,
    });
  });
});

describe('sending messages', () => {
  it('sends WhatsApp through the provider, SMS and email through theirs, and lists them on the party', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await t.connection.db.delete(messageOutbox);
    ok(await consent(ravi, { channel: 'sms' }));
    ok(await consent(ravi, { channel: 'email' }));
    const whatsapp = messageId(await queue({ partyId: ravi }));
    const sms = messageId(await queue({ partyId: ravi, channel: 'sms' }));
    const email = messageId(
      await queue({
        partyId: ravi,
        channel: 'email',
        templateKey: 'receipt_issued',
        variables: { number: 'RC-000007', amount: '₹500.00' },
      }),
    );

    const run = await sendDueMessages(t.connection.db, {
      whatsapp: new LogMessagingProvider(),
      sms: t.sms,
      email: { send: recordMail, close: () => undefined },
    });

    expect(run).toEqual({ sent: 3, failed: 0, skipped: 0 });
    expect(await outboxRow(whatsapp)).toMatchObject({
      status: 'sent',
      provider: 'log',
      providerRef: `log-${whatsapp}`,
      attempts: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`To ${ravisPhone} (order_ready, te)`),
    );
    expect(await outboxRow(sms)).toMatchObject({ status: 'sent', provider: 'sms' });
    expect(t.sms.sent.at(-1)).toEqual({
      phone: ravisPhone,
      message: expect.stringContaining('SO-000042') as string,
    });
    expect(await outboxRow(email)).toMatchObject({ status: 'sent', provider: 'email' });
    expect(mails.at(-1)).toMatchObject({
      to: 'ravi.painter@example.in',
      subject: expect.stringMatching(/^Dear Ravi Painter, /) as string,
    });

    const listed = ok(await api(t, employee).get(`/parties/${ravi}/messages?limit=2`)).json<
      MessageView[]
    >();
    expect(listed.map((m) => m.channel)).toEqual(['email', 'sms']);
    expect(listed[0]).toMatchObject({
      status: 'sent',
      sentAt: expect.any(String) as string,
      skipReason: null,
    });
    expect((await api(t, manager).get(`/parties/${suresh}/messages`)).statusCode).toBe(404);
  });

  it('skips a message when consent was withdrawn or the number changed before it went, or the channel is off', async () => {
    await t.connection.db.delete(messageOutbox);
    const optedOut = messageId(await queue({ partyId: ravi, channel: 'sms' }));
    ok(await consent(ravi, { channel: 'sms', state: 'withdrawn' }));
    const renumbered = messageId(await queue({ partyId: ravi }));
    const offline = messageId(
      await queue({
        partyId: ravi,
        channel: 'email',
        templateKey: 'invoice_issued',
        variables: { number: 'INV-1', amount: '₹1.00' },
      }),
    );

    // The WhatsApp goes after the party's number changed.
    const newPhone = uniquePhone();
    ok(await api(t, b.owner).patch(`/parties/${ravi}`, { phone: newPhone }));
    const run = await sendDueMessages(t.connection.db, { whatsapp: null, sms: null, email: null });
    expect(run).toEqual({ sent: 0, failed: 0, skipped: 3 });
    expect((await outboxRow(optedOut))?.skipReason).toBe('no_consent');
    expect((await outboxRow(renumbered))?.skipReason).toBe('no_consent');
    expect((await outboxRow(offline))?.skipReason).toBe('channel_disabled');

    // Each channel off on its own.
    ok(await api(t, b.owner).patch(`/parties/${ravi}`, { phone: ravisPhone }));
    ok(await consent(ravi, { channel: 'sms' }));
    const whatsapp = messageId(await queue({ partyId: ravi }));
    const sms = messageId(await queue({ partyId: ravi, channel: 'sms' }));
    expect(
      await sendDueMessages(t.connection.db, { whatsapp: null, sms: null, email: null }),
    ).toEqual({ sent: 0, failed: 0, skipped: 2 });
    expect([(await outboxRow(whatsapp))?.skipReason, (await outboxRow(sms))?.skipReason]).toEqual([
      'channel_disabled',
      'channel_disabled',
    ]);
    const [latest] = ok(await api(t, b.owner).get(`/parties/${ravi}/messages`)).json<
      MessageView[]
    >();
    expect(latest).toMatchObject({
      status: 'skipped',
      sentAt: null,
      skipReason: 'channel_disabled',
    });
  });

  it('retries a failed send with growing gaps, then gives up', async () => {
    await t.connection.db.delete(messageOutbox);
    const id = messageId(await queue({ partyId: ravi }));
    const failing = {
      whatsapp: { name: 'flaky', send: () => Promise.reject(new Error('BSP timed out')) },
      sms: null,
      email: null,
    };

    const first = await sendDueMessages(t.connection.db, failing);
    const afterFirst = await outboxRow(id);
    const notDue = await sendDueMessages(t.connection.db, failing);
    await t.connection.db
      .update(messageOutbox)
      .set({ attempts: MAX_MESSAGE_ATTEMPTS - 1, nextAttemptAt: sql`now()` })
      .where(eq(messageOutbox.id, id));
    await sendDueMessages(t.connection.db, failing);

    expect(first).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(afterFirst).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'Error: BSP timed out',
    });
    expect(Number(afterFirst?.nextAttemptAt) - Date.now()).toBeGreaterThan(60_000);
    expect(notDue).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(await outboxRow(id)).toMatchObject({ status: 'failed', attempts: MAX_MESSAGE_ATTEMPTS });
  });
});

/** Emails "sent" by the test sender (SMTP itself is tested with the notifications worker). */
const mails: { to: string; subject: string; text: string }[] = [];
function recordMail(message: { to: string; subject: string; text: string }): Promise<void> {
  mails.push(message);
  return Promise.resolve();
}
