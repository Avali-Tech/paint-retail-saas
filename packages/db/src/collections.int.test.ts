import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

// MVP 3 round 2a (migrations 0074–0075): promises to pay, escalations, the daily
// collections runs, reminder schedules, consent, templates, the message outbox
// and stored statement links.

const {
  activities,
  auditLog,
  collectionEscalations,
  collectionRuns,
  messageOutbox,
  messageTemplates,
  messagingConsents,
  organizationMembers,
  organizations,
  parties,
  promisesToPay,
  reminderSchedules,
  roles,
  statementLinks,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let party: string;
let otherParty: string;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

function id(rows: { id: string }[]): string {
  const [row] = rows;
  if (!row) throw new Error('Expected a row');
  return row.id;
}

async function auditOf(table: string, recordId: string) {
  return connection.db
    .select({ action: auditLog.action, newValues: auditLog.newValues })
    .from(auditLog)
    .where(sql`${auditLog.tableName} = ${table} and ${auditLog.recordId} = ${recordId}`)
    .orderBy(auditLog.id);
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  org = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  otherOrg = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  const role = id(
    await db.insert(roles).values({ organizationId: org, key: 'owner', name: 'Owner' }).returning(),
  );
  const user = id(
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100031' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  party = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Sharma Constructions', phone: '+919811100032' })
      .returning(),
  );
  otherParty = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Ravi Painter' })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

const promise = (values: Partial<typeof promisesToPay.$inferInsert> = {}) =>
  connection.db
    .insert(promisesToPay)
    .values({
      organizationId: org,
      partyId: otherParty,
      amountPaise: 50_000_00,
      promisedOn: '2099-01-10',
      madeOn: '2099-01-01',
      createdByMemberId: member,
      ...values,
    })
    .returning();

describe('promises to pay', () => {
  it.each([
    [{ amountPaise: 0 }, /promises_to_pay_amount_positive/],
    [{ promisedOn: '2098-12-31' }, /promises_to_pay_dates/],
    [{ status: 'kept' as const }, /promises_to_pay_closed/],
    [{ status: 'cancelled' as const, closedAt: new Date() }, /promises_to_pay_closed/],
    [{ note: 'x'.repeat(1001) }, /promises_to_pay_text_lengths/],
  ])('refuse inconsistent promises: %o', async (values, constraint) => {
    expect(await failureMessage(promise(values))).toMatch(constraint);
  });

  it('allow one open promise per party, link its activity and stay private', async () => {
    const activity = id(
      await connection.db
        .insert(activities)
        .values({
          organizationId: org,
          recordType: 'party',
          recordId: party,
          type: 'promise_to_pay',
          subject: 'Promised ₹50,000 by 10 Jan',
          completedAt: new Date(),
          assignedMemberId: member,
          createdByMemberId: member,
        })
        .returning(),
    );
    const [open] = await promise({ partyId: party, activityId: activity });

    expect(open).toMatchObject({ status: 'open', paidPaise: null, activityId: activity });
    expect(await failureMessage(promise({ partyId: party }))).toMatch(
      /promises_to_pay_one_open_per_party/,
    );
    expect(await failureMessage(promise({ activityId: crypto.randomUUID() }))).toMatch(
      /promises_to_pay_activity_fk/,
    );
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(promisesToPay)),
    ).toEqual([]);
  });

  it('keep what was promised and move forward only, once; audited', async () => {
    const [made] = await promise({ partyId: otherParty });
    const promiseId = String(made?.id);
    const set = (values: Partial<typeof promisesToPay.$inferInsert>) =>
      connection.db.update(promisesToPay).set(values).where(eq(promisesToPay.id, promiseId));

    expect(await failureMessage(set({ amountPaise: 1 }))).toMatch(/keeps what was promised/);
    expect(await failureMessage(set({ status: 'open' }))).toMatch(
      /open promise to pay cannot become open/,
    );
    await set({ status: 'broken', paidPaise: 10_000_00, closedAt: new Date() });
    expect(
      await failureMessage(
        set({
          status: 'cancelled',
          paidPaise: null,
          cancelReason: 'x',
          closedByMemberId: member,
        }),
      ),
    ).toMatch(/broken promise to pay cannot become cancelled/);
    expect(
      await failureMessage(
        withTenant(connection.db, org, (tx) =>
          tx.delete(promisesToPay).where(eq(promisesToPay.id, promiseId)),
        ),
      ),
    ).toMatch(/permission denied/);

    expect((await auditOf('promises_to_pay', promiseId)).map((row) => row.action)).toEqual([
      'insert',
      'update',
    ]);
  });

  it('record who cancelled one and why', async () => {
    const [made] = await promise({ partyId: otherParty, promisedOn: '2099-02-01' });
    const cancel = (values: Partial<typeof promisesToPay.$inferInsert>) =>
      connection.db
        .update(promisesToPay)
        .set({ status: 'cancelled', closedAt: new Date(), ...values })
        .where(eq(promisesToPay.id, String(made?.id)));

    expect(await failureMessage(cancel({ cancelReason: 'Paid elsewhere' }))).toMatch(
      /promises_to_pay_closed/,
    );
    await cancel({ cancelReason: 'Paid elsewhere', closedByMemberId: member });
  });
});

describe('collection escalations', () => {
  it('are acknowledged once, with an optional note, and never removed', async () => {
    const [broken] = await promise({
      partyId: otherParty,
      promisedOn: '2099-03-01',
    });
    const promiseId = String(broken?.id);
    const escalation = id(
      await connection.db
        .insert(collectionEscalations)
        .values({ organizationId: org, partyId: otherParty, promiseId, notifiedCount: 2 })
        .returning(),
    );
    const update = (values: Partial<typeof collectionEscalations.$inferInsert>) =>
      connection.db
        .update(collectionEscalations)
        .set(values)
        .where(eq(collectionEscalations.id, escalation));

    expect(
      await failureMessage(
        connection.db
          .insert(collectionEscalations)
          .values({ organizationId: org, partyId: otherParty, promiseId, notifiedCount: 0 }),
      ),
    ).toMatch(/collection_escalations_promise_unique/);
    expect(await failureMessage(update({ acknowledgeNote: 'Called' }))).toMatch(
      /collection_escalations_acknowledged/,
    );
    expect(await failureMessage(update({ notifiedCount: 5 }))).toMatch(/only acknowledged, once/);
    await update({
      acknowledgedByMemberId: member,
      acknowledgedAt: new Date(),
      acknowledgeNote: 'Called, pays Friday',
    });
    expect(await failureMessage(update({ acknowledgeNote: 'Again' }))).toMatch(
      /only acknowledged, once/,
    );
    expect(
      await failureMessage(
        withTenant(connection.db, org, (tx) =>
          tx.delete(collectionEscalations).where(eq(collectionEscalations.id, escalation)),
        ),
      ),
    ).toMatch(/permission denied/);
    expect((await auditOf('collection_escalations', escalation)).length).toBe(2);
  });
});

describe('collection runs', () => {
  it('are once a day per business and append-only', async () => {
    const run = id(
      await connection.db
        .insert(collectionRuns)
        .values({ organizationId: org, keptCount: 1, brokenCount: 0, remindersQueued: 3 })
        .returning(),
    );

    expect(
      await failureMessage(
        connection.db
          .insert(collectionRuns)
          .values({ organizationId: org, keptCount: 0, brokenCount: 0, remindersQueued: 0 }),
      ),
    ).toMatch(/collection_runs_daily_unique/);
    expect(
      await failureMessage(
        connection.db
          .insert(collectionRuns)
          .values({ organizationId: otherOrg, keptCount: -1, brokenCount: 0, remindersQueued: 0 }),
      ),
    ).toMatch(/collection_runs_counts/);
    expect(
      await failureMessage(
        connection.db
          .update(collectionRuns)
          .set({ keptCount: 2 })
          .where(eq(collectionRuns.id, run)),
      ),
    ).toMatch(/append-only/);
    expect(await failureMessage(connection.db.execute(sql`truncate collection_runs`))).toMatch(
      /append-only/,
    );
  });
});

describe('reminder schedules', () => {
  const schedule = (values: Partial<typeof reminderSchedules.$inferInsert>) =>
    connection.db
      .insert(reminderSchedules)
      .values({
        organizationId: org,
        offsetDays: 0,
        channels: ['whatsapp'],
        createdByMemberId: member,
        ...values,
      })
      .returning();

  it('take one row per offset, within limits, with one to three channels; audited', async () => {
    expect(await failureMessage(schedule({ offsetDays: -31 }))).toMatch(
      /reminder_schedules_offset/,
    );
    expect(await failureMessage(schedule({ offsetDays: 91 }))).toMatch(/reminder_schedules_offset/);
    expect(await failureMessage(schedule({ channels: [] }))).toMatch(/reminder_schedules_channels/);
    const [due] = await schedule({ offsetDays: -3, channels: ['whatsapp', 'sms', 'email'] });
    expect(await failureMessage(schedule({ offsetDays: -3 }))).toMatch(
      /reminder_schedules_offset_unique/,
    );
    expect((await auditOf('reminder_schedules', String(due?.id)))[0]?.newValues).toEqual({
      offset_days: -3,
      channels: ['whatsapp', 'sms', 'email'],
      is_active: true,
    });
  });
});

describe('messaging consents', () => {
  const consent = (values: Partial<typeof messagingConsents.$inferInsert>) =>
    connection.db
      .insert(messagingConsents)
      .values({
        organizationId: org,
        partyId: party,
        channel: 'whatsapp',
        address: '+919811100032',
        state: 'granted',
        method: 'counter_with_notice',
        noticeVersion: '2026-10',
        language: 'hi',
        recordedByMemberId: member,
        ...values,
      })
      .returning();

  it.each([
    [{ address: '9811100032' }, /messaging_consents_address/],
    [{ channel: 'email' as const, address: 'Ravi@Example.com' }, /messaging_consents_address/],
    [{ channel: 'email' as const, address: 'not an address' }, /messaging_consents_address/],
    [{ recordedByMemberId: null }, /messaging_consents_member/],
    [{ noticeVersion: '' }, /messaging_consents_notice_version/],
  ])('refuse incomplete records: %o', async (values, constraint) => {
    expect(await failureMessage(consent(values))).toMatch(constraint);
  });

  it('are append-only, audited and private to their business', async () => {
    const [granted] = await consent({});
    await consent({ channel: 'email', address: 'sharma@example.com' });
    // A STOP reply is recorded with no member.
    await consent({ state: 'withdrawn', method: 'whatsapp_reply', recordedByMemberId: null });

    expect(
      await failureMessage(
        connection.db
          .update(messagingConsents)
          .set({ state: 'withdrawn' })
          .where(eq(messagingConsents.id, String(granted?.id))),
      ),
    ).toMatch(/append-only/);
    expect(await failureMessage(connection.db.execute(sql`truncate messaging_consents`))).toMatch(
      /append-only/,
    );
    expect((await auditOf('messaging_consents', String(granted?.id)))[0]?.newValues).toMatchObject({
      state: 'granted',
      method: 'counter_with_notice',
      address: '+919811100032',
    });
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(messagingConsents)),
    ).toEqual([]);
  });
});

describe('message templates', () => {
  it('are one per key, channel and language, with a BSP-style name; audited', async () => {
    const template = (values: Partial<typeof messageTemplates.$inferInsert>) =>
      connection.db
        .insert(messageTemplates)
        .values({
          organizationId: org,
          key: 'payment_reminder_due',
          channel: 'sms',
          language: 'en',
          body: 'Dear {{name}}, {{amount}} is due on {{dueOn}}. {{business}}',
          updatedByMemberId: member,
          ...values,
        })
        .returning();

    expect(await failureMessage(template({ body: '' }))).toMatch(/message_templates_body/);
    expect(await failureMessage(template({ providerTemplateName: 'Bad Name' }))).toMatch(
      /message_templates_provider_name/,
    );
    const [saved] = await template({ providerTemplateName: 'payment_reminder_due_v1' });
    expect(await failureMessage(template({}))).toMatch(/message_templates_key_unique/);
    expect((await auditOf('message_templates', String(saved?.id)))[0]?.action).toBe('insert');
  });
});

describe('the message outbox', () => {
  const message = (values: Partial<typeof messageOutbox.$inferInsert> = {}) =>
    connection.db
      .insert(messageOutbox)
      .values({
        organizationId: org,
        partyId: party,
        channel: 'whatsapp',
        templateKey: 'payment_reminder_overdue',
        language: 'en',
        toAddress: '+919811100032',
        variables: { name: 'Sharma Constructions', amount: '₹18,000.00' },
        body: 'Dear Sharma Constructions, ₹18,000.00 is overdue.',
        ...values,
      })
      .returning();

  it.each([
    [{ status: 'sent' as const }, /message_outbox_states/],
    [{ status: 'skipped' as const }, /message_outbox_states/],
    [{ referenceType: 'tax_document' }, /message_outbox_states/],
    [{ body: '' }, /message_outbox_text_lengths/],
    [{ attempts: -1 }, /message_outbox_attempts_not_negative/],
  ])('refuses inconsistent messages: %o', async (values, constraint) => {
    expect(await failureMessage(message(values))).toMatch(constraint);
  });

  it('refuses variables that are not an object', async () => {
    expect(
      await failureMessage(
        connection.db.execute(sql`
          insert into message_outbox (organization_id, party_id, channel, template_key, language,
            to_address, variables, body)
          values (${org}, ${party}, 'sms', 'receipt_issued', 'en', '+919811100032', '[]', 'Hi')`),
      ),
    ).toMatch(/message_outbox_variables_object/);
  });

  it('queues a message once per dedupe key', async () => {
    await message({ dedupeKey: 'reminder:2099-01-01' });
    expect(await failureMessage(message({ dedupeKey: 'reminder:2099-01-01' }))).toMatch(
      /message_outbox_dedupe_unique/,
    );
  });

  it('keeps its content and moves its status forward only', async () => {
    const [queued] = await message();
    const messageId = String(queued?.id);
    const set = (values: Partial<typeof messageOutbox.$inferInsert>) =>
      connection.db.update(messageOutbox).set(values).where(eq(messageOutbox.id, messageId));

    expect(await failureMessage(set({ body: 'Changed' }))).toMatch(/keeps its content/);
    await set({ attempts: 1, lastError: 'timeout' });
    await set({
      status: 'sent',
      attempts: 2,
      provider: 'log',
      providerRef: 'log-1',
      sentAt: new Date(),
    });
    expect(await failureMessage(set({ status: 'queued' }))).toMatch(
      /sent message cannot become queued/,
    );
    await set({ status: 'delivered' });
    await set({ status: 'read' });
    expect(await failureMessage(set({ status: 'failed' }))).toMatch(
      /read message cannot become failed/,
    );
    expect(
      await failureMessage(
        withTenant(connection.db, org, (tx) =>
          tx.delete(messageOutbox).where(eq(messageOutbox.id, messageId)),
        ),
      ),
    ).toMatch(/permission denied/);
  });

  it('lets a skipped message stay skipped', async () => {
    const [queued] = await message();
    const skip = () =>
      connection.db
        .update(messageOutbox)
        .set({ status: 'skipped', skipReason: 'no_consent' })
        .where(eq(messageOutbox.id, String(queued?.id)));
    await skip();
    await skip();
  });
});

describe('statement links', () => {
  const link = (
    values: Partial<Omit<typeof statementLinks.$inferInsert, 'expiresAt'>> & {
      expiresAt?: Date | SQL;
    } = {},
  ) =>
    connection.db
      .insert(statementLinks)
      .values({
        organizationId: org,
        partyId: party,
        fromOn: '2026-04-01',
        toOn: '2026-10-16',
        language: 'te',
        tokenHash: crypto.randomUUID().replaceAll('-', '').repeat(2),
        expiresAt: sql`now() + interval '7 days'`,
        createdByMemberId: member,
        ...values,
      })
      .returning();

  it.each([
    [{ toOn: '2026-03-31' }, /statement_links_period/],
    [{ tokenHash: 'ABC' }, /statement_links_token_hash/],
    [{ expiresAt: sql`now() - interval '1 second'` }, /statement_links_expiry/],
    [{ revokedAt: new Date() }, /statement_links_revoked/],
    [{ openedCount: 1 }, /statement_links_opened/],
  ])('refuse inconsistent links: %o', async (values, constraint) => {
    expect(await failureMessage(link(values))).toMatch(constraint);
  });

  it('keep their token unique, are revoked once and only count opens up; audited', async () => {
    const [created] = await link();
    const linkId = String(created?.id);
    const set = (values: Partial<typeof statementLinks.$inferInsert>) =>
      connection.db.update(statementLinks).set(values).where(eq(statementLinks.id, linkId));

    expect(await failureMessage(link({ tokenHash: String(created?.tokenHash) }))).toMatch(
      /statement_links_token_hash_unique/,
    );
    await set({ openedCount: 1, lastOpenedAt: new Date() });
    expect(await failureMessage(set({ openedCount: 0, lastOpenedAt: null }))).toMatch(
      /only revoked, once, or opened/,
    );
    expect(await failureMessage(set({ toOn: '2026-10-17' }))).toMatch(
      /only revoked, once, or opened/,
    );
    await set({ revokedAt: new Date(), revokedByMemberId: member });
    expect(await failureMessage(set({ revokedAt: new Date() }))).toMatch(
      /only revoked, once, or opened/,
    );
    expect((await auditOf('statement_links', linkId)).map((row) => row.action)).toEqual([
      'insert',
      'update',
    ]);
    expect(
      await withTenant(connection.db, otherOrg, (tx) => tx.select().from(statementLinks)),
    ).toEqual([]);
  });
});
