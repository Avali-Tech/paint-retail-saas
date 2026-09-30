import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import {
  createDatabase,
  enterTenantScope,
  migrateDatabase,
  schema,
  withTenant,
  type DatabaseConnection,
} from './index.js';

const { organizations, stores } = schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let orgA: string;
let orgB: string;

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

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

// Each test starts with two organisations, each with its own stores. Seeding runs
// outside tenant scope, as the platform would when onboarding a new business.
beforeEach(async () => {
  const { db } = connection;
  await db.delete(stores);
  await db.delete(organizations);
  const [a, b] = await db
    .insert(organizations)
    .values([{ name: 'ABC Paints' }, { name: 'XYZ Paints' }])
    .returning({ id: organizations.id });
  orgA = a?.id ?? '';
  orgB = b?.id ?? '';
  await db.insert(stores).values([
    { organizationId: orgA, name: 'Hyderabad', code: 'HYD' },
    { organizationId: orgA, name: 'Gachibowli Godown', code: 'GCB', type: 'godown' },
    { organizationId: orgB, name: 'Secunderabad', code: 'SEC' },
  ]);
});

describe('withTenant: reading', () => {
  it("returns only the current organisation's stores, even without a WHERE clause", async () => {
    const aStores = await withTenant(connection.db, orgA, (tx) =>
      tx.select({ code: stores.code }).from(stores).orderBy(stores.code),
    );
    const bStores = await withTenant(connection.db, orgB, (tx) =>
      tx.select({ code: stores.code }).from(stores),
    );

    expect(aStores.map((s) => s.code)).toEqual(['GCB', 'HYD']);
    expect(bStores.map((s) => s.code)).toEqual(['SEC']);
  });

  it('cannot read another organisation even when asking for it by id', async () => {
    const found = await withTenant(connection.db, orgA, (tx) =>
      tx.select().from(stores).where(eq(stores.organizationId, orgB)),
    );

    expect(found).toEqual([]);
  });

  it('sees only its own organisation record', async () => {
    const visible = await withTenant(connection.db, orgA, (tx) =>
      tx.select({ name: organizations.name }).from(organizations),
    );

    expect(visible).toEqual([{ name: 'ABC Paints' }]);
  });

  it('sees nothing for an organisation id that does not exist', async () => {
    const found = await withTenant(connection.db, '00000000-0000-4000-8000-000000000000', (tx) =>
      tx.select().from(stores),
    );

    expect(found).toEqual([]);
  });
});

describe('withTenant: writing', () => {
  it('creates stores for its own organisation', async () => {
    await withTenant(connection.db, orgA, (tx) =>
      tx.insert(stores).values({ organizationId: orgA, name: 'Kukatpally', code: 'KKP' }),
    );

    const codes = await withTenant(connection.db, orgA, (tx) =>
      tx.select({ code: stores.code }).from(stores).orderBy(stores.code),
    );
    expect(codes.map((s) => s.code)).toEqual(['GCB', 'HYD', 'KKP']);
  });

  it("cannot create a store in another organisation's name", async () => {
    const message = await failureMessage(
      withTenant(connection.db, orgA, (tx) =>
        tx.insert(stores).values({ organizationId: orgB, name: 'Sneaky', code: 'SNK' }),
      ),
    );

    expect(message).toMatch(/row-level security/);
  });

  it("cannot change or delete another organisation's stores", async () => {
    const updated = await withTenant(connection.db, orgA, (tx) =>
      tx
        .update(stores)
        .set({ name: 'Hijacked' })
        .where(eq(stores.organizationId, orgB))
        .returning(),
    );
    const deleted = await withTenant(connection.db, orgA, (tx) =>
      tx.delete(stores).where(eq(stores.code, 'SEC')).returning(),
    );

    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const bStores = await withTenant(connection.db, orgB, (tx) =>
      tx.select({ name: stores.name }).from(stores),
    );
    expect(bStores).toEqual([{ name: 'Secunderabad' }]);
  });

  it('cannot move its own store into another organisation', async () => {
    const message = await failureMessage(
      withTenant(connection.db, orgA, (tx) =>
        tx.update(stores).set({ organizationId: orgB }).where(eq(stores.code, 'HYD')),
      ),
    );

    expect(message).toMatch(/row-level security/);
  });

  it('can rename its own organisation but cannot create or delete organisations', async () => {
    await withTenant(connection.db, orgA, (tx) =>
      tx.update(organizations).set({ name: 'ABC Paints & Hardware' }),
    );
    const createMessage = await failureMessage(
      withTenant(connection.db, orgA, (tx) => tx.insert(organizations).values({ name: 'New Co' })),
    );
    const deleted = await withTenant(connection.db, orgA, (tx) =>
      tx.delete(organizations).returning(),
    );

    const names = await connection.db
      .select({ name: organizations.name })
      .from(organizations)
      .orderBy(organizations.name);
    expect(names.map((o) => o.name)).toEqual(['ABC Paints & Hardware', 'XYZ Paints']);
    expect(createMessage).toMatch(/row-level security/);
    expect(deleted).toEqual([]);
  });

  it('allows the same store code in different organisations but not twice in one', async () => {
    await withTenant(connection.db, orgB, (tx) =>
      tx.insert(stores).values({ organizationId: orgB, name: 'Hyderabad (B)', code: 'HYD' }),
    );
    const message = await failureMessage(
      withTenant(connection.db, orgA, (tx) =>
        tx.insert(stores).values({ organizationId: orgA, name: 'Duplicate', code: 'HYD' }),
      ),
    );

    expect(message).toMatch(/stores_organization_code_unique/);
  });
});

describe('withTenant: transactions', () => {
  it('rolls back everything when the work fails', async () => {
    await expect(
      withTenant(connection.db, orgA, async (tx) => {
        await tx.insert(stores).values({ organizationId: orgA, name: 'Temp', code: 'TMP' });
        throw new Error('something went wrong');
      }),
    ).rejects.toThrow('something went wrong');

    const codes = await withTenant(connection.db, orgA, (tx) =>
      tx.select({ code: stores.code }).from(stores),
    );
    expect(codes.map((s) => s.code)).not.toContain('TMP');
  });

  it('does not leak the organisation or role to the next query on the connection', async () => {
    await withTenant(connection.db, orgA, (tx) => tx.select().from(stores));

    const [after] = await connection.db
      .execute<{ role: string; org: string | null }>(
        sql`select current_user as role, nullif(current_setting('app.current_organization_id', true), '') as org`,
      )
      .then((result) => result.rows);

    expect(after?.role).not.toBe('app_tenant');
    expect(after?.org).toBeNull();
  });

  it('keeps concurrent tenants apart on the shared connection pool', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const org = i % 2 === 0 ? orgA : orgB;
        return withTenant(connection.db, org, (tx) =>
          tx.select({ organizationId: stores.organizationId }).from(stores),
        ).then((rows) => ({ org, rows }));
      }),
    );

    for (const { org, rows } of results) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.organizationId === org)).toBe(true);
    }
  });
});

describe('enterTenantScope', () => {
  it('lets one transaction do platform work, then tenant-scoped work, committing both together', async () => {
    const created = await connection.db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name: 'New Co' }).returning();
      const id = org?.id ?? '';
      await tx.insert(stores).values({ organizationId: id, name: 'First', code: 'FST' });

      await enterTenantScope(tx, id);

      const visible = await tx.select({ code: stores.code }).from(stores);
      const role = await tx.execute<{ role: string }>(sql`select current_user as role`);
      return { id, visible, role: role.rows[0]?.role };
    });

    expect(created.visible).toEqual([{ code: 'FST' }]);
    expect(created.role).toBe('app_tenant');
    const [org] = await connection.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, created.id));
    expect(org?.name).toBe('New Co');
  });

  it('rolls back the platform work too when the tenant work fails', async () => {
    await expect(
      connection.db.transaction(async (tx) => {
        await tx.insert(organizations).values({ name: 'Doomed Co' });
        await enterTenantScope(tx, orgA);
        await tx.insert(stores).values({ organizationId: orgB, name: 'Sneaky', code: 'SNK' });
      }),
    ).rejects.toThrow();

    const doomed = await connection.db
      .select()
      .from(organizations)
      .where(eq(organizations.name, 'Doomed Co'));
    expect(doomed).toEqual([]);
  });

  it('rejects an invalid organisation id', async () => {
    await expect(connection.db.transaction((tx) => enterTenantScope(tx, 'nope'))).rejects.toThrow(
      TypeError,
    );
  });
});

describe('organisation integrity', () => {
  it('cannot delete an organisation that still has stores', async () => {
    const message = await failureMessage(
      connection.db.delete(organizations).where(eq(organizations.id, orgA)),
    );

    expect(message).toMatch(/foreign key/);
  });
});

describe('createDatabase', () => {
  it('survives the server dropping an idle pooled connection, and reconnects', async () => {
    const errors: Error[] = [];
    const resilient = createDatabase(database.connectionString, {
      onIdleConnectionError: (error) => errors.push(error),
    });
    try {
      const [{ pid } = { pid: 0 }] = (
        await resilient.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      ).rows;

      // Kill the now-idle pooled connection from another session, as a failover would.
      await connection.db.execute(sql`select pg_terminate_backend(${pid})`);
      await vi.waitFor(() => {
        expect(errors).toHaveLength(1);
      });

      const [row] = (await resilient.db.execute<{ ok: number }>(sql`select 1 as ok`)).rows;
      expect(row?.ok).toBe(1);
      expect(errors[0]?.message).toMatch(/terminat/);
    } finally {
      await resilient.close();
    }
  });

  it('logs dropped idle connections to stderr by default', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const defaults = createDatabase(database.connectionString);
    try {
      const [{ pid } = { pid: 0 }] = (
        await defaults.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      ).rows;

      await connection.db.execute(sql`select pg_terminate_backend(${pid})`);

      await vi.waitFor(() => {
        expect(stderr).toHaveBeenCalledWith(
          expect.stringMatching(/^PostgreSQL idle connection error \(connection discarded\): /),
        );
      });
    } finally {
      stderr.mockRestore();
      await defaults.close();
    }
  });

  it('gives up connecting after the timeout instead of hanging', async () => {
    // 10.255.255.1 is a non-routable address: connection attempts are never answered.
    const unreachable = createDatabase('postgres://user:pass@10.255.255.1:5432/db', {
      connectionTimeoutMillis: 300,
    });
    const started = Date.now();

    await expect(unreachable.db.select().from(organizations)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);

    await unreachable.close();
  });

  it('stops accepting queries after close', async () => {
    const temporary = createDatabase(database.connectionString);
    await temporary.db.select().from(organizations);

    await temporary.close();

    await expect(temporary.db.select().from(organizations)).rejects.toThrow();
  });
});
