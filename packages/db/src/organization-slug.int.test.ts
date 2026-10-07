import { RESERVED_SLUGS } from '@paint/shared';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const { organizations } = schema;

let database: TestDatabase;
let connection: DatabaseConnection;

/** Message of a rejected query, including PostgreSQL's own error wrapped by Drizzle. */
async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

async function create(name: string, slug?: string): Promise<{ id: string; slug: string }> {
  const [row] = await connection.db
    .insert(organizations)
    .values({ name, ...(slug === undefined ? {} : { slug }) })
    .returning({ id: organizations.id, slug: organizations.slug });
  if (!row) throw new Error('Organisation not created');
  return row;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('organisation slugs', () => {
  it('are derived from the name when left out, numbered when taken', async () => {
    expect((await create('Sharma Paints & Hardware')).slug).toBe('sharma-paints-hardware');
    expect((await create('  SHARMA paints -- hardware!! ')).slug).toBe('sharma-paints-hardware-2');
    expect((await create('Sharma Paints & Hardware')).slug).toBe('sharma-paints-hardware-3');
  });

  it('fall back to "business" for names without Latin letters or digits, and cut long names', async () => {
    expect((await create('शर्मा पेंट्स')).slug).toBe('business');
    expect((await create('శర్మ పెయింట్స్')).slug).toBe('business-2');
    expect((await create('AB')).slug).toBe('ab-business');
    const long = await create(`${'Very Long Business Name '.repeat(4)}Paints`);
    // Cut to 34 characters (room for a number), without a hyphen at the end.
    expect(long.slug).toBe('very-long-business-name-very-long');
  });

  it('never hands out a reserved name, keeping the database list in step with @paint/shared', async () => {
    const generated = await withPgClient(database.connectionString, async (client) => {
      const result = await client.query<{ slug: string }>(
        'SELECT generate_organization_slug(name, NULL) AS slug FROM unnest($1::text[]) AS name',
        [RESERVED_SLUGS],
      );
      return result.rows.map((row) => row.slug);
    });

    expect(generated).toEqual(RESERVED_SLUGS.map((reserved) => `${reserved}-2`));
    expect((await create('Platform')).slug).toBe('platform-2');
  });

  it('are unique ignoring case, and must be lower-case words joined by hyphens', async () => {
    await create('Unique One', 'unique-one');

    expect(await failureMessage(create('Other', 'unique-one'))).toContain(
      'organizations_slug_unique',
    );
    for (const bad of ['Unique-One', 'ab', '-lead', 'two--hyphens', 'with space', 'a'.repeat(41)]) {
      expect(await failureMessage(create('Bad', bad)), bad).toContain('organizations_slug_format');
    }
  });

  it('can be changed by the business itself only, and the change is audited', async () => {
    const own = await create('Own Paints');
    const other = await create('Other Paints');

    await withTenant(connection.db, own.id, (tx) =>
      tx.update(organizations).set({ slug: 'own-brand' }).where(eq(organizations.id, own.id)),
    );
    // Row-level security hides the other business: its slug stays.
    await withTenant(connection.db, own.id, (tx) =>
      tx.update(organizations).set({ slug: 'stolen' }).where(eq(organizations.id, other.id)),
    );

    const slugs = await connection.db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(sql`${organizations.id} in (${own.id}, ${other.id})`);
    expect(new Map(slugs.map((row) => [row.id, row.slug]))).toEqual(
      new Map([
        [own.id, 'own-brand'],
        [other.id, 'other-paints'],
      ]),
    );
    const audit = await connection.db
      .select({ oldValues: schema.auditLog.oldValues, newValues: schema.auditLog.newValues })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.recordId, own.id));
    expect(audit).toEqual([
      { oldValues: { slug: 'own-paints' }, newValues: { slug: 'own-brand' } },
    ]);
  });

  it('cannot be read for other businesses inside tenant scope', async () => {
    const own = await create('Scoped Paints');
    await create('Hidden Paints');

    const visible = await withTenant(connection.db, own.id, (tx) =>
      tx.select({ slug: organizations.slug }).from(organizations),
    );

    expect(visible).toEqual([{ slug: 'scoped-paints' }]);
  });

  it('cannot be generated by the tenant role directly', async () => {
    const own = await create('Generator Paints');

    expect(
      await failureMessage(
        withTenant(connection.db, own.id, (tx) =>
          tx.execute(sql`select generate_organization_slug('x', null)`),
        ),
      ),
    ).toContain('permission denied');
  });
});
