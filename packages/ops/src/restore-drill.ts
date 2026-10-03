import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { compareDatabases } from './compare.ts';
import { inspectDatabase, type DatabaseFacts } from './inspect.ts';
import { libpqConnection, localPgTools, type PgTools } from './pg-tools.ts';

export interface RestoreDrillOptions {
  /** The database to back up: in production, an RDS instance restored to a point in time. */
  readonly sourceUrl: string;
  /** Any database on the server to restore onto; the drill creates a fresh database there. */
  readonly targetServerUrl: string;
  readonly tools?: PgTools;
  /** Keep the restored database for inspection instead of dropping it. */
  readonly keep?: boolean;
  readonly workDir?: string;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface RestoreDrillReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** The fresh database the dump was restored into. */
  readonly restoredDatabase: string;
  readonly kept: boolean;
  readonly dumpBytes: number;
  readonly source: DatabaseFacts;
  readonly restored: DatabaseFacts;
  readonly durationMs: number;
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

const withDatabase = (url: string, database: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

/** restore_drill_20261002_143000 */
export function drillDatabaseName(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  return `restore_drill_${stamp}`;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Creates the roles the dump grants to (they are server-wide, so not in the dump). */
async function ensureRoles(client: pg.ClientBase, roles: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  for (const role of roles) {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE ROLE ${quoteIdent(role)} NOLOGIN`);
      created.push(role);
    }
  }
  return created;
}

/**
 * The restore drill: dumps the source with pg_dump (custom format), restores it into
 * a brand-new database with pg_restore, then checks the copy has the same migrations,
 * the same tables with the same row counts, row-level security and policies, and the
 * same grants. The counts are read from the same snapshot pg_dump used, so they match
 * exactly even while the source takes writes.
 */
export async function runRestoreDrill(options: RestoreDrillOptions): Promise<RestoreDrillReport> {
  const {
    sourceUrl,
    targetServerUrl,
    tools = localPgTools(),
    keep = false,
    now = () => new Date(),
    log = () => undefined,
  } = options;
  const startedAt = now();
  const workDir = await mkdtemp(join(options.workDir ?? tmpdir(), 'restore-drill-'));
  const dumpFile = join(workDir, 'source.dump');
  const restoredDatabase = drillDatabaseName(startedAt);
  const restoredUrl = withDatabase(targetServerUrl, restoredDatabase);
  const admin = await connect(targetServerUrl);
  let created = false;
  try {
    log('Reading the source and dumping it from one snapshot');
    const sourceClient = await connect(sourceUrl);
    let source: DatabaseFacts;
    try {
      await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const exported = await sourceClient.query('SELECT pg_export_snapshot() AS snapshot');
      const [{ snapshot }] = exported.rows as [{ snapshot: string }];
      source = await inspectDatabase(sourceClient);
      const connection = libpqConnection(sourceUrl);
      await tools('pg_dump', [...connection.args, '--format=custom', `--snapshot=${snapshot}`], {
        stdoutFile: dumpFile,
        env: connection.env,
      });
      await sourceClient.query('COMMIT');
    } finally {
      await sourceClient.end();
    }
    const { size: dumpBytes } = await stat(dumpFile);

    log(`Restoring ${String(dumpBytes)} bytes into a new database, ${restoredDatabase}`);
    const createdRoles = await ensureRoles(admin, source.roles);
    if (createdRoles.length > 0) log(`Created missing roles: ${createdRoles.join(', ')}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(restoredDatabase)}`);
    created = true;
    const target = libpqConnection(restoredUrl);
    await tools('pg_restore', [...target.args, '--no-owner', '--exit-on-error'], {
      stdinFile: dumpFile,
      env: target.env,
    });

    log('Comparing the restored database with the source');
    const restoredClient = await connect(restoredUrl);
    const restored = await inspectDatabase(restoredClient).finally(() => restoredClient.end());
    const problems = compareDatabases(source, restored);
    return {
      ok: problems.length === 0,
      problems,
      restoredDatabase,
      kept: keep,
      dumpBytes,
      source,
      restored,
      durationMs: now().getTime() - startedAt.getTime(),
    };
  } finally {
    if (created && !keep) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(restoredDatabase)} WITH (FORCE)`);
    }
    await admin.end();
    await rm(workDir, { recursive: true, force: true });
  }
}

/** A short, human-readable summary for the drill log. */
export function formatReport(report: RestoreDrillReport): string {
  const rows = report.source.tables.reduce((total, table) => total + table.rows, 0);
  const lines = [
    report.ok ? 'RESTORE DRILL PASSED' : 'RESTORE DRILL FAILED',
    `  migrations: ${String(report.restored.migrations.count)} (latest ${String(report.restored.migrations.latest)})`,
    `  tables: ${String(report.restored.tables.length)}, rows: ${String(rows)}, dump: ${String(report.dumpBytes)} bytes`,
    `  restored into: ${report.restoredDatabase}${report.kept ? ' (kept)' : ' (dropped)'}`,
    `  took: ${String(Math.round(report.durationMs / 1000))} s`,
    ...report.problems.map((problem) => `  PROBLEM: ${problem}`),
  ];
  return lines.join('\n');
}
