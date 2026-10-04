import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDatabase } from '@paint/db';
import {
  createIsolatedDatabase,
  POSTGRES_IMAGE,
  withPgClient,
  type TestDatabase,
} from '@paint/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { inspectDatabase } from './inspect.ts';
import { dockerPgTools, type PgTools } from './pg-tools.ts';
import { runRestoreDrill } from './restore-drill.ts';

// The drill against real PostgreSQL 17: the source is a migrated database with data
// on the shared test server; the target is a second, empty server (as when restoring
// onto a new RDS instance), so the drill must also recreate the app_tenant role.
// pg_dump and pg_restore run from the postgres:17 image, matching the server version.

let source: TestDatabase;
let targetServer: StartedPostgreSqlContainer;
let workDir: string;
const tools = dockerPgTools(POSTGRES_IMAGE);

const databasesOn = (url: string) =>
  withPgClient(url, async (client) => {
    const result = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'restore_drill_%'",
    );
    return result.rows.map((row) => row.datname);
  });

beforeAll(async () => {
  [source, targetServer, workDir] = await Promise.all([
    createIsolatedDatabase(inject('databaseUrl')),
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    mkdtemp(join(tmpdir(), 'drill-test-')),
  ]);
  await migrateDatabase(source.connectionString);
  await withPgClient(source.connectionString, async (client) => {
    await client.query(`
      WITH orgs AS (
        INSERT INTO organizations (name) SELECT 'Business ' || n FROM generate_series(1, 3) n
        RETURNING id
      )
      INSERT INTO stores (organization_id, name, code)
      SELECT id, 'Main', 'MAIN' FROM orgs`);
  });
}, 180_000);

afterAll(async () => {
  await source.stop();
  await targetServer.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe('restore drill', { timeout: 120_000 }, () => {
  it('restores into a fresh database on another server with the same migrations, rows and RLS', async () => {
    const messages: string[] = [];

    const report = await runRestoreDrill({
      sourceUrl: source.connectionString,
      targetServerUrl: targetServer.getConnectionUri(),
      tools,
      workDir,
      log: (message) => messages.push(message),
    });

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.restored.migrations.count).toBeGreaterThan(0);
    expect(report.restored.migrations).toEqual(report.source.migrations);
    const rows = Object.fromEntries(report.restored.tables.map((t) => [t.name, t.rows]));
    expect(rows['public.organizations']).toBe(3);
    expect(rows['public.stores']).toBe(3);
    expect(
      report.restored.tables.filter((t) => t.name.startsWith('public.') && !t.rowLevelSecurity),
    ).toEqual([]);
    expect(report.restored.grants).toContain('app_tenant public.stores SELECT');
    expect(report.dumpBytes).toBeGreaterThan(0);
    expect(messages).toContain('Created missing roles: app_tenant');
    // The copy is dropped and the dump deleted afterwards.
    expect(await databasesOn(targetServer.getConnectionUri())).toEqual([]);
    expect(await readdir(workDir)).toEqual([]);
  });

  it('keeps the restored database when asked, reusing roles that exist', async () => {
    const times = [new Date('2026-10-02T01:00:00Z'), new Date('2026-10-02T01:00:05Z')];
    const messages: string[] = [];

    const report = await runRestoreDrill({
      sourceUrl: source.connectionString,
      targetServerUrl: targetServer.getConnectionUri(),
      tools,
      workDir,
      keep: true,
      now: () => times.shift() ?? new Date(),
      log: (message) => messages.push(message),
    });

    expect(report.ok).toBe(true);
    expect(report.kept).toBe(true);
    expect(report.durationMs).toBe(5_000);
    expect(report.restoredDatabase).toBe('restore_drill_20261002_010000');
    expect(messages.some((message) => message.startsWith('Created missing roles'))).toBe(false);
    expect(await databasesOn(targetServer.getConnectionUri())).toEqual([
      'restore_drill_20261002_010000',
    ]);
  });

  it('drops the half-restored database and reports the error when pg_restore fails', async () => {
    const failingRestore: PgTools = (tool, args, io) =>
      tool === 'pg_restore'
        ? Promise.reject(new Error('pg_restore exited with code 1'))
        : tools(tool, args, io);
    const before = await databasesOn(targetServer.getConnectionUri());

    await expect(
      runRestoreDrill({
        sourceUrl: source.connectionString,
        targetServerUrl: targetServer.getConnectionUri(),
        tools: failingRestore,
        workDir,
      }),
    ).rejects.toThrow('pg_restore exited with code 1');

    expect(await databasesOn(targetServer.getConnectionUri())).toEqual(before);
  });

  it('does not create anything when the dump fails', async () => {
    const failingDump: PgTools = () => Promise.reject(new Error('pg_dump exited with code 1'));
    const before = await databasesOn(targetServer.getConnectionUri());

    await expect(
      runRestoreDrill({
        sourceUrl: source.connectionString,
        targetServerUrl: targetServer.getConnectionUri(),
        tools: failingDump,
      }),
    ).rejects.toThrow('pg_dump exited with code 1');

    expect(await databasesOn(targetServer.getConnectionUri())).toEqual(before);
  });

  it('reads an empty database as having no migrations', async () => {
    const empty = await createIsolatedDatabase(inject('databaseUrl'));
    try {
      const facts = await withPgClient(empty.connectionString, inspectDatabase);
      expect(facts).toEqual({
        migrations: { count: 0, latest: null },
        tables: [],
        grants: [],
        roles: [],
      });
    } finally {
      await empty.stop();
    }
  });
});
