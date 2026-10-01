import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createDatabase,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const {
  organizationMembers,
  organizations,
  parties,
  projectParties,
  projects,
  roles,
  stores,
  users,
} = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let member: string;
let store: string;
let customer: string;
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

const newProject = (values: Partial<typeof projects.$inferInsert> = {}) => {
  seq += 1;
  return connection.db
    .insert(projects)
    .values({
      organizationId: org,
      number: `PJ-${String(seq)}`,
      storeId: store,
      name: 'Gachibowli apartments',
      customerPartyId: customer,
      assignedMemberId: member,
      createdByMemberId: member,
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
    await db.insert(users).values({ fullName: 'Owner', phone: '+919811100005' }).returning(),
  );
  member = id(
    await db
      .insert(organizationMembers)
      .values({ organizationId: org, userId: user, roleId: role })
      .returning(),
  );
  store = id(
    await db.insert(stores).values({ organizationId: org, name: 'HYD', code: 'HYD' }).returning(),
  );
  customer = id(
    await db
      .insert(parties)
      .values({ organizationId: org, displayName: 'Sharma Builders' })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

describe('projects', () => {
  it('start identified, with a full site record, private to their business', async () => {
    const [project] = await newProject({
      latitude: 17.440081,
      longitude: 78.348915,
      startDate: '2026-11-01',
      expectedCompletionDate: '2027-01-31',
      estimatedAreaSqFt: 42_000.5,
      estimatedPaintLitres: 1_850.25,
      expectedOrderValuePaise: 85_000_000,
    });

    expect(project).toMatchObject({
      stage: 'identified',
      latitude: 17.440081,
      estimatedPaintLitres: 1_850.25,
    });
    expect(await withTenant(connection.db, otherOrg, (tx) => tx.select().from(projects))).toEqual(
      [],
    );
  });

  it.each([
    [{ latitude: 17.4 }, /projects_pin_complete/],
    [{ latitude: 91, longitude: 0 }, /projects_latitude_range/],
    [{ latitude: 0, longitude: 181 }, /projects_longitude_range/],
    [{ estimatedAreaSqFt: 0 }, /projects_area_positive/],
    [{ estimatedPaintLitres: 0 }, /projects_paint_positive/],
    [{ expectedOrderValuePaise: -1 }, /projects_value_not_negative/],
    [{ startDate: '2026-12-01', expectedCompletionDate: '2026-11-01' }, /projects_dates_in_order/],
    [{ stage: 'cancelled' as const, closedAt: new Date() }, /projects_cancel_reason/],
    [{ stage: 'completed' as const }, /projects_closed_when_closed/],
  ])('refuses inconsistent values: %o', async (values, constraint) => {
    expect(await failureMessage(newProject(values))).toMatch(constraint);
  });

  it('links parties by role, removing the links with the project', async () => {
    const project = id(await newProject());
    const architect = id(
      await connection.db
        .insert(parties)
        .values({ organizationId: org, displayName: 'Ar. Rao' })
        .returning(),
    );
    const link = {
      organizationId: org,
      projectId: project,
      partyId: architect,
      role: 'architect' as const,
    };
    await connection.db.insert(projectParties).values(link);
    // The same person can also be the contractor, but not the architect twice.
    await connection.db.insert(projectParties).values({ ...link, role: 'contractor' });

    expect(await failureMessage(connection.db.insert(projectParties).values(link))).toMatch(
      /project_parties_project_id_party_id_role_pk/,
    );
    await connection.db.delete(projects).where(eq(projects.id, project));
    expect(
      await connection.db
        .select()
        .from(projectParties)
        .where(eq(projectParties.projectId, project)),
    ).toEqual([]);
  });
});
