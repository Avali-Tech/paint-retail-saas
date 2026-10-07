import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createDatabase, migrateDatabase } from '@paint/db';
import pg from 'pg';
import { createApp } from '../app.js';
import type { SmsSender } from '../auth/sms.js';
import { loadConfig } from '../config.js';
import { formatCredentials } from './credentials.js';
import { indiaDate } from './history-clock.js';
import { LARGE_SCALE, type LargeScale } from './large-plan.js';
import { DEMO_BUSINESS, DEMO_SIZES, type DemoSize } from './plan.js';
import { seedDemo, type SeedResult } from './seed.js';

export const SEED_COMMANDS = ['seed', 'reset', 'status'] as const;
export type SeedCommand = (typeof SEED_COMMANDS)[number];

export const SEED_USAGE = `Demo data for ${DEMO_BUSINESS}.

Usage: seed.js <seed|reset|status>
  seed     create the demo database if needed, migrate it and seed it if empty
  reset    drop the demo database, create it again and seed it
  status   print "seeded YYYY-MM-DD" or "empty"

Environment: DATABASE_URL, AUTH_SECRET (the API's, 32+ characters),
DEMO_SIZE (full, small or large, default full; large adds a large shop's volume for
performance testing, not for client demos), DEMO_CREDENTIALS_FILE, DEMO_WEB_URL.`;

/** Keeps the codes the API texts, so the seed can sign counter staff in with one. */
export class CapturingSmsSender implements SmsSender {
  private readonly codes = new Map<string, string>();

  send(phone: string, message: string): Promise<void> {
    this.codes.set(phone, message.slice(0, 6));
    return Promise.resolve();
  }

  codeFor(phone: string): string {
    const code = this.codes.get(phone);
    if (code === undefined) throw new Error(`No sign-in code was sent to ${phone}`);
    return code;
  }
}

interface Settings {
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly size: DemoSize;
  readonly credentialsFile: string | null;
  readonly webUrl: string;
}

function settingsFrom(env: Readonly<Record<string, string | undefined>>): Settings {
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\/.+\/[^/]+$/.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a postgres:// URL naming the demo database');
  }
  const authSecret = env.AUTH_SECRET ?? '';
  if (authSecret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters');
  const size = (env.DEMO_SIZE ?? 'full') as DemoSize;
  if (!DEMO_SIZES.includes(size)) throw new Error('DEMO_SIZE must be full, small or large');
  return {
    databaseUrl,
    authSecret,
    size,
    credentialsFile: env.DEMO_CREDENTIALS_FILE ?? null,
    webUrl: env.DEMO_WEB_URL ?? 'http://localhost:5173',
  };
}

/** The demo database's name and a URL for the server's maintenance database. */
function server(databaseUrl: string): { name: string; maintenanceUrl: string } {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  return { name, maintenanceUrl: url.toString() };
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function onServer<T>(
  databaseUrl: string,
  work: (client: pg.Client, name: string) => Promise<T>,
) {
  const { name, maintenanceUrl } = server(databaseUrl);
  const client = new pg.Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    return await work(client, name);
  } finally {
    await client.end();
  }
}

/** Creates the demo database if it does not exist; true when it was created. */
export function ensureDatabase(databaseUrl: string): Promise<boolean> {
  return onServer(databaseUrl, async (client, name) => {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 1) return false;
    await client.query(`CREATE DATABASE ${quoted(name)}`);
    return true;
  });
}

/** Drops the demo database, disconnecting anyone still using it. */
export function dropDatabase(databaseUrl: string): Promise<void> {
  return onServer(databaseUrl, async (client, name) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`);
  });
}

/** The India date the demo was seeded, from the note left on the database; null when empty. */
export function seededOn(databaseUrl: string): Promise<string | null> {
  return onServer(databaseUrl, async (client, name) => {
    const result = await client.query<{ note: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE datname = $1`,
      [name],
    );
    const note = result.rows[0]?.note ?? '';
    return /seeded (\d{4}-\d{2}-\d{2})/.exec(note)?.[1] ?? null;
  });
}

async function hasBusinesses(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM organizations LIMIT 1');
    return result.rowCount === 1;
  } finally {
    await client.end();
  }
}

/** Seeds the demo through an in-process API and notes the date on the database. */
async function seed(settings: Settings, largeScale: LargeScale): Promise<SeedResult> {
  // Only this in-process API can create the demo's platform operator; the running demo API cannot.
  const platformBootstrapToken = randomBytes(32).toString('hex');
  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: settings.databaseUrl,
    AUTH_SECRET: settings.authSecret,
    LOG_LEVEL: 'error',
    // The running API's worker sends the emails and reminders; the seed runs it once itself.
    WORKER_INTERVAL_SECONDS: '0',
    SIGNUP_PLAN: 'standard',
    PLATFORM_BOOTSTRAP_TOKEN: platformBootstrapToken,
  });
  const sms = new CapturingSmsSender();
  const connection = createDatabase(settings.databaseUrl);
  const app = await createApp(config, connection, { smsSender: sms });
  try {
    const result = await seedDemo({
      app,
      databaseUrl: settings.databaseUrl,
      authSecret: settings.authSecret,
      platformBootstrapToken,
      size: settings.size,
      large: settings.size === 'large' ? largeScale : null,
      readSmsCode: (phone) => sms.codeFor(phone),
    });
    await onServer(settings.databaseUrl, (client, name) =>
      client.query(
        `COMMENT ON DATABASE ${quoted(name)} IS '${DEMO_BUSINESS.replaceAll("'", "''")} demo, seeded ${indiaDate(0)}'`,
      ),
    );
    return result;
  } finally {
    await app.close();
  }
}

/**
 * Runs `seed`, `reset` or `status` and answers the process exit code. Lines
 * for the person running it go to `print`. Tests pass a smaller `largeScale`.
 */
export async function runSeedCommand(
  command: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  print: (line: string) => void,
  largeScale: LargeScale = LARGE_SCALE,
): Promise<number> {
  if (!SEED_COMMANDS.includes(command as SeedCommand)) {
    print(SEED_USAGE);
    return 2;
  }
  const settings = settingsFrom(env);
  if (command === 'status') {
    const created = await ensureDatabase(settings.databaseUrl);
    const date = created ? null : await seededOn(settings.databaseUrl);
    print(date === null ? 'empty' : `seeded ${date}`);
    return 0;
  }
  if (command === 'reset') {
    print('Dropping the demo database…');
    await dropDatabase(settings.databaseUrl);
  }
  await ensureDatabase(settings.databaseUrl);
  await migrateDatabase(settings.databaseUrl);
  const date = await seededOn(settings.databaseUrl);
  if (date !== null) {
    print(`The demo data is already there (seeded ${date}). \`pnpm demo:reset\` starts it afresh.`);
    return 0;
  }
  if (await hasBusinesses(settings.databaseUrl)) {
    print('A previous seed did not finish. `pnpm demo:reset` starts the demo data afresh.');
    return 1;
  }
  print(`Seeding ${DEMO_BUSINESS} (${settings.size}); this takes a minute…`);
  const started = Date.now();
  const result = await seed(settings, largeScale);
  const sheet = formatCredentials(result.credentials, settings.webUrl);
  if (settings.credentialsFile !== null) {
    mkdirSync(dirname(settings.credentialsFile), { recursive: true });
    writeFileSync(settings.credentialsFile, sheet);
  }
  print(
    `Seeded in ${String(Math.round((Date.now() - started) / 1000))} s: ${Object.entries(
      result.counts,
    )
      .map(([what, count]) => `${String(count)} ${what}`)
      .join(', ')}.`,
  );
  print('');
  print(sheet);
  return 0;
}
