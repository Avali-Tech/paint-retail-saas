import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDatabase, schema, type DatabaseConnection } from '@paint/db';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../app.js';
import { hashPassword } from '../auth/credentials.js';
import type { SmsSender } from '../auth/sms.js';
import { loadConfig } from '../config.js';

export const TEST_AUTH_SECRET = 'integration-test-secret-of-at-least-32-chars';

/** Records messages instead of sending them, so tests can read one-time codes. */
export class FakeSmsSender implements SmsSender {
  readonly sent: { phone: string; message: string }[] = [];

  send(phone: string, message: string): Promise<void> {
    this.sent.push({ phone, message });
    return Promise.resolve();
  }

  lastCodeFor(phone: string): string {
    const message = this.sent.findLast((sms) => sms.phone === phone)?.message ?? '';
    const code = /^\d{6}/.exec(message)?.[0];
    if (!code) throw new Error(`No code was sent to ${phone}`);
    return code;
  }
}

export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly connection: DatabaseConnection;
  readonly sms: FakeSmsSender;
  close(): Promise<void>;
}

export async function startTestApp(
  databaseUrl: string,
  env: Record<string, string> = {},
  { fakeSms = true } = {},
): Promise<TestApp> {
  const connection = createDatabase(databaseUrl);
  const sms = new FakeSmsSender();
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: TEST_AUTH_SECRET,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    // Tests run the background worker by hand.
    WORKER_INTERVAL_SECONDS: '0',
    ...env,
  });
  const app = await createApp(config, connection, fakeSms ? { smsSender: sms } : {});
  return { app, connection, sms, close: () => app.close() };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let counter = 0;
/** A phone number no other test uses. */
export function uniquePhone(): string {
  counter += 1;
  return `+9198${String(Date.now() % 1_000_000).padStart(6, '0')}${String(counter).padStart(2, '0')}`;
}

interface NewMember {
  organizationId: string;
  roleKey: string;
  fullName?: string;
  phone?: string;
  email?: string;
  password?: string;
  allStores?: boolean;
  storeIds?: string[];
}

/** Adds a person to an organisation directly in the database (until a members API exists). */
export async function addMember(
  connection: DatabaseConnection,
  member: NewMember,
): Promise<{ userId: string; memberId: string }> {
  const { db } = connection;
  const [role] = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.organizationId, member.organizationId),
        eq(schema.roles.key, member.roleKey),
      ),
    );
  if (!role) throw new Error(`No role ${member.roleKey}`);
  const [user] = await db
    .insert(schema.users)
    .values({
      fullName: member.fullName ?? 'Team Member',
      phone: member.phone ?? null,
      email: member.email ?? null,
      passwordHash: member.password ? await hashPassword(member.password) : null,
    })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('User not created');
  return { userId: user.id, memberId: await addMembership(connection, user.id, member, role.id) };
}

/** Gives an existing user a membership of another organisation. */
export async function addMembership(
  connection: DatabaseConnection,
  userId: string,
  member: Omit<NewMember, 'roleKey'> & { roleKey?: string },
  roleId?: string,
): Promise<string> {
  const { db } = connection;
  let resolvedRoleId = roleId;
  if (!resolvedRoleId) {
    const [role] = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.organizationId, member.organizationId),
          eq(schema.roles.key, member.roleKey ?? 'store_employee'),
        ),
      );
    resolvedRoleId = role?.id;
  }
  if (!resolvedRoleId) throw new Error('Role not found');
  const [row] = await db
    .insert(schema.organizationMembers)
    .values({
      organizationId: member.organizationId,
      userId,
      roleId: resolvedRoleId,
      allStores: member.allStores ?? false,
    })
    .returning({ id: schema.organizationMembers.id });
  if (!row) throw new Error('Membership not created');
  if (member.storeIds?.length) {
    await db.insert(schema.memberStores).values(
      member.storeIds.map((storeId) => ({
        organizationId: member.organizationId,
        memberId: row.id,
        storeId,
      })),
    );
  }
  return row.id;
}
