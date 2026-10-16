import { createDatabase, migrateDatabase, schema, type DatabaseConnection } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { receiveGatewayWebhook } from './gateway-events.js';
import type { VerifiedGatewayEvent, WebhookVerifier } from './payment-gateway.js';
import { hmacHex, signatureMatches } from './signatures.js';

const { organizations, paymentGatewayEvents } = schema;
const SECRET = 'gateway-events-test-secret';

let database: TestDatabase;
let connection: DatabaseConnection;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
}, 180_000);

afterAll(async () => {
  await connection.close();
  await database.stop();
});

interface LinkEvent extends VerifiedGatewayEvent {
  readonly linkId: string | null;
}

/** A gateway of the shape P2-M32's payment links will have: signed JSON bodies. */
const verifier: WebhookVerifier<LinkEvent> = {
  name: 'fake',
  verifyWebhook(rawBody, headers) {
    if (!signatureMatches(SECRET, rawBody, headers['x-signature'])) return null;
    const body = JSON.parse(rawBody.toString('utf8')) as { id: string; linkId: string | null };
    return { id: body.id, gatewayType: 'link.paid', linkId: body.linkId };
  },
};

const signed = (body: object) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { rawBody, headers: { 'x-signature': hmacHex(SECRET, rawBody) } };
};

const stored = (eventId: string) =>
  connection.db
    .select()
    .from(paymentGatewayEvents)
    .where(eq(paymentGatewayEvents.eventId, eventId));

describe('receiveGatewayWebhook', () => {
  it('refuses a bad signature before reading the body, and stores nothing', async () => {
    const applied: string[] = [];
    const result = await receiveGatewayWebhook(
      connection.db,
      verifier,
      { rawBody: Buffer.from('not json'), headers: { 'x-signature': 'forged' } },
      {
        objectId: (event) => event.linkId,
        apply: (_tx, event) => {
          applied.push(event.id);
          return Promise.resolve('applied');
        },
      },
    );
    expect(result).toBeNull();
    expect(applied).toEqual([]);
  });

  it('applies an event once, attaches it to its business and ignores a redelivery', async () => {
    const [business] = (await connection.db
      .insert(organizations)
      .values({ name: 'Gateway Events Paints' })
      .returning({ id: organizations.id })) as [{ id: string }];
    const applied: string[] = [];
    const handler = {
      objectId: (event: LinkEvent) => event.linkId,
      apply: async (
        _tx: unknown,
        event: LinkEvent,
        context: { attach(id: string): Promise<void> },
      ) => {
        applied.push(event.id);
        await context.attach(business.id);
        return 'applied' as const;
      },
    };
    const webhook = signed({ id: 'evt_once', linkId: 'plink_1' });

    const first = await receiveGatewayWebhook(connection.db, verifier, webhook, handler);
    const again = await receiveGatewayWebhook(connection.db, verifier, webhook, handler);

    expect(first?.outcome).toBe('applied');
    expect(again?.outcome).toBe('duplicate');
    expect(applied).toEqual(['evt_once']);
    expect(await stored('evt_once')).toEqual([
      expect.objectContaining({
        gateway: 'fake',
        type: 'link.paid',
        objectId: 'plink_1',
        organizationId: business.id,
      }),
    ]);
  });

  it('keeps an event the caller ignores, so a redelivery is a duplicate too', async () => {
    const webhook = signed({ id: 'evt_ignored', linkId: null });
    const handler = {
      objectId: (event: LinkEvent) => event.linkId,
      apply: () => Promise.resolve('ignored' as const),
    };
    expect((await receiveGatewayWebhook(connection.db, verifier, webhook, handler))?.outcome).toBe(
      'ignored',
    );
    expect((await receiveGatewayWebhook(connection.db, verifier, webhook, handler))?.outcome).toBe(
      'duplicate',
    );
    expect(await stored('evt_ignored')).toEqual([
      expect.objectContaining({ objectId: null, organizationId: null }),
    ]);
  });

  it('stores nothing when applying fails, so the gateway retry applies it', async () => {
    const webhook = signed({ id: 'evt_retry', linkId: 'plink_2' });
    await expect(
      receiveGatewayWebhook(connection.db, verifier, webhook, {
        objectId: (event) => event.linkId,
        apply: () => Promise.reject(new Error('allocation failed')),
      }),
    ).rejects.toThrow('allocation failed');
    expect(await stored('evt_retry')).toEqual([]);

    const retried = await receiveGatewayWebhook(connection.db, verifier, webhook, {
      objectId: (event) => event.linkId,
      apply: () => Promise.resolve('applied'),
    });
    expect(retried?.outcome).toBe('applied');
  });
});
