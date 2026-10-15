import { migrateDatabase, schema } from '@paint/db';
import type { StatementLinkView, StatementShareResult } from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { PUBLIC_STATEMENT_RATE } from './statements.controller.js';
import { tokenHash, whatsappLink } from './statement-links.service.js';

const { messageOutbox, organizations, statementLinks } = schema;

let database: TestDatabase;
/** WhatsApp through the log provider; links on https://app.example.in/api. */
let t: TestApp;
/** WhatsApp not set up. */
let off: TestApp;
let b: BillingBusiness;
let other: BillingBusiness;
let kkpStaff: string;
let employee: string;
let deccan: string;
let deccanPhone: string;
let kkpParty: string;
let today: string;

const share = (partyId: string, body: object = {}, token = b.owner, app = t) =>
  api(app, token).post(`/parties/${partyId}/statement/links`, {
    from: '2026-04-01',
    to: today,
    lang: 'en',
    ...body,
  });

const tokenOf = (url: string) => String(url.split('/').at(-1));
let ip = 0;
/** A public request from its own client address, so the rate limit never mixes tests. */
const open = (token: string, address = `203.0.113.${String((ip += 1))}`) =>
  t.app.inject({
    method: 'GET',
    url: `/public/statements/${token}`,
    headers: { 'x-forwarded-for': address },
  });

async function pdfText(body: Buffer): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(body)), {
    mergePages: true,
  });
  return text;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, {
    MESSAGING_PROVIDER: 'log',
    PUBLIC_API_URL: 'https://app.example.in/api/',
  });
  off = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  other = await billingBusiness(t);
  today = await dbToday(t);
  kkpStaff = await b.member('sales_executive', [b.stores.kkp]);
  employee = await b.member('store_employee', [b.stores.amp]);
  deccanPhone = uniquePhone();
  deccan = ok(
    await api(t, b.owner).post('/parties', {
      displayName: 'Deccan Builders',
      phone: deccanPhone,
      homeStoreId: b.stores.amp,
      roles: ['customer'],
    }),
  ).json<{ id: string }>().id;
  kkpParty = ok(
    await api(t, b.owner).post('/parties', {
      displayName: 'No Phone Traders',
      roles: ['customer'],
    }),
  ).json<{ id: string }>().id;
  await b.invoice({ partyId: deccan, quantity: 10 }); // ₹1,180, unpaid
});

afterAll(async () => {
  await t.close();
  await off.close();
  await database.stop();
});

describe('sharing a statement as a stored link', () => {
  it('stores only the token’s hash and answers with the link, a wa.me message and the link’s record', async () => {
    const result = ok(await share(deccan, { lang: 'hi' })).json<StatementShareResult>();

    expect(result.url).toMatch(
      /^https:\/\/app\.example\.in\/api\/public\/statements\/[A-Za-z0-9_-]{43}$/,
    );
    expect(result.message).toBeNull();
    expect(result.link).toMatchObject({
      from: '2026-04-01',
      to: today,
      language: 'hi',
      status: 'active',
      revokedAt: null,
      openedCount: 0,
      lastOpenedAt: null,
      createdBy: 'Owner',
    });
    expect(Date.parse(result.link.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(result.waMeUrl).toMatch(new RegExp(`^https://wa\\.me/${deccanPhone.slice(1)}\\?text=`));
    expect(decodeURIComponent(String(result.waMeUrl))).toContain(`खाता विवरण देखें: ${result.url}`);
    const [stored] = await t.connection.db
      .select({ hash: statementLinks.tokenHash })
      .from(statementLinks)
      .where(eq(statementLinks.id, result.link.id));
    expect(stored?.hash).toBe(tokenHash(tokenOf(result.url)));
    expect(JSON.stringify(stored)).not.toContain(tokenOf(result.url));
  });

  it('has no wa.me link for a party without a mobile, and checks the period and who may share', async () => {
    const noPhone = ok(await share(kkpParty)).json<StatementShareResult>();
    expect(noPhone.waMeUrl).toBeNull();
    expect((await share(deccan, { from: today, to: '2026-04-01' })).statusCode).toBe(400);
    expect((await share(deccan, {}, kkpStaff)).statusCode).toBe(404);
    expect((await share(deccan, {}, employee)).statusCode).toBe(201);
  });

  it('queues the WhatsApp statement message when a provider is set up and the party agreed', async () => {
    const offReply = await share(deccan, { send: 'whatsapp' }, b.owner, off);
    expect(offReply.statusCode).toBe(409);
    expect(offReply.json<{ code: string }>().code).toBe('whatsapp_off');

    const noConsent = ok(await share(deccan, { send: 'whatsapp' })).json<StatementShareResult>();
    expect(noConsent.message).toEqual({ queued: false, reason: 'no_consent' });

    ok(
      await api(t, b.owner).post(`/parties/${deccan}/consents`, {
        channel: 'whatsapp',
        state: 'granted',
        method: 'counter_with_notice',
        language: 'en',
        noticeVersion: '2026-10',
      }),
    );
    const sent = ok(await share(deccan, { send: 'whatsapp' })).json<StatementShareResult>();
    expect(sent.message).toEqual({ queued: true, messageId: expect.any(String) as string });
    const [message] = await t.connection.db
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.id, sent.message?.queued ? sent.message.messageId : ''));
    expect(message).toMatchObject({
      templateKey: 'statement_ready',
      referenceType: 'statement_link',
      referenceId: sent.link.id,
      toAddress: deccanPhone,
    });
    expect(message?.body).toContain('balance ₹1,180.00');
    expect(message?.body).toContain(sent.url);
  });
});

describe('the public statement', () => {
  it('serves the PDF without signing in, in the link’s language, never cached, counting opens', async () => {
    const { url, link } = ok(await share(deccan, { lang: 'te' })).json<StatementShareResult>();

    const reply = await open(tokenOf(url));

    expect(reply.statusCode).toBe(200);
    expect(reply.headers['content-type']).toBe('application/pdf');
    expect(reply.headers['content-disposition']).toMatch(
      /^inline; filename="Statement-Deccan-Builders-/,
    );
    expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(reply.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    const text = await pdfText(reply.rawPayload);
    expect(text).toContain('Deccan Builders');
    expect(text).toContain('1,180.00');
    const [listed] = ok(await api(t, b.owner).get(`/parties/${deccan}/statement/links`)).json<
      StatementLinkView[]
    >();
    expect(listed).toMatchObject({
      id: link.id,
      openedCount: 1,
      lastOpenedAt: expect.any(String) as string,
    });
  });

  it('serves an English-only statement for an English link', async () => {
    const { url } = ok(await share(deccan)).json<StatementShareResult>();
    expect((await open(tokenOf(url))).statusCode).toBe(200);
  });

  it('answers the same 404 for a malformed, unknown, revoked, expired or suspended link', async () => {
    const revoke = ok(await share(deccan)).json<StatementShareResult>();
    const expire = ok(await share(deccan)).json<StatementShareResult>();
    const suspended = ok(
      await share(other.parties.contractor, {}, other.owner),
    ).json<StatementShareResult>();
    ok(await api(t, b.owner).post(`/statement-links/${revoke.link.id}/revoke`));
    await withPgClient(database.connectionString, async (client) => {
      await client.query("SET session_replication_role = 'replica'");
      await client.query(
        "UPDATE statement_links SET expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' WHERE id = $1",
        [expire.link.id],
      );
    });
    await t.connection.db
      .update(organizations)
      .set({ suspendedAt: new Date(), suspendReason: 'Unpaid subscription' })
      .where(eq(organizations.id, other.organizationId));

    const replies = await Promise.all(
      [
        'short',
        'A'.repeat(43),
        tokenOf(revoke.url),
        tokenOf(expire.url),
        tokenOf(suspended.url),
      ].map((token) => open(token)),
    );

    expect(replies.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect(new Set(replies.map((r) => r.body)).size).toBe(1);
    expect(replies[0]?.body).not.toMatch(/Deccan|Rangoli/);
    const statuses = ok(await api(t, b.owner).get(`/parties/${deccan}/statement/links`))
      .json<StatementLinkView[]>()
      .filter((l) => [revoke.link.id, expire.link.id].includes(l.id))
      .map((l) => l.status)
      .sort();
    expect(statuses).toEqual(['expired', 'revoked']);
  });

  it('limits how often one client may open links', async () => {
    const { url } = ok(await share(deccan)).json<StatementShareResult>();
    const address = '198.51.100.7';
    const replies = [];
    for (let i = 0; i <= PUBLIC_STATEMENT_RATE.limit; i += 1) {
      replies.push((await open('malformed', address)).statusCode);
    }
    expect(replies.slice(0, -1).every((code) => code === 404)).toBe(true);
    expect(replies.at(-1)).toBe(429);
    // Another client is not held up.
    expect((await open(tokenOf(url))).statusCode).toBe(200);
  });
});

describe('managing links', () => {
  it('lists a party’s links and revokes one once, for members who may see the party', async () => {
    const { link } = ok(await share(deccan)).json<StatementShareResult>();
    const hidden = await api(t, kkpStaff).post(`/statement-links/${link.id}/revoke`);
    const missing = await api(t, b.owner).post(`/statement-links/${crypto.randomUUID()}/revoke`);
    const revoked = ok(
      await api(t, employee).post(`/statement-links/${link.id}/revoke`),
    ).json<StatementLinkView>();
    const again = await api(t, b.owner).post(`/statement-links/${link.id}/revoke`);

    expect([hidden.statusCode, missing.statusCode, again.statusCode]).toEqual([404, 404, 409]);
    expect(revoked).toMatchObject({ status: 'revoked', revokedAt: expect.any(String) as string });
    expect((await api(t, kkpStaff).get(`/parties/${deccan}/statement/links`)).statusCode).toBe(404);
  });

  it('builds wa.me links without the plus sign', () => {
    expect(whatsappLink('+919876543210', 'Hi & bye')).toBe(
      'https://wa.me/919876543210?text=Hi%20%26%20bye',
    );
  });
});
