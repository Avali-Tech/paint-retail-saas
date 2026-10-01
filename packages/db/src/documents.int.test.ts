import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const { documents, organizationMembers, organizations, roles, users } = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let seq = 0;

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

const newDocument = (values: Partial<typeof documents.$inferInsert> = {}) => {
  seq += 1;
  return connection.db
    .insert(documents)
    .values({
      organizationId: org,
      recordType: 'party',
      recordId: crypto.randomUUID(),
      category: 'gst_certificate',
      fileName: 'gst.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      storageKey: `org/${org}/documents/${String(seq)}`,
      uploadedByMemberId: member,
      ...values,
    })
    .returning();
};

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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100002' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('documents', () => {
  it('stores a document, visible only to its business', async () => {
    const [saved] = await newDocument();

    const seenByOther = await withTenant(connection.db, otherOrg, (tx) =>
      tx.select().from(documents),
    );

    expect(saved).toMatchObject({ deletedAt: null, deletedByMemberId: null });
    expect(seenByOther).toEqual([]);
  });

  it.each([
    [{ sizeBytes: 0 }, /documents_size_positive/],
    [{ sha256: 'ABC' }, /documents_sha256_format/],
    [{ deletedAt: new Date() }, /documents_deleted_together/],
    [
      { deletedByMemberId: '00000000-0000-4000-8000-000000000000' },
      /documents_deleted_by_fk|documents_deleted_together/,
    ],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newDocument(values))).toMatch(constraint);
  });

  it('keeps storage keys unique, and uploaders within the business', async () => {
    await newDocument({ storageKey: 'org/x/documents/same' });

    expect(await failureMessage(newDocument({ storageKey: 'org/x/documents/same' }))).toMatch(
      /documents_storage_key_unique/,
    );
    expect(await failureMessage(newDocument({ organizationId: otherOrg }))).toMatch(
      /documents_uploaded_by_fk/,
    );
  });
});
