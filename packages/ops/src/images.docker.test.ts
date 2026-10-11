import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Builds the production images (apps/api/Dockerfile, packages/ops/Dockerfile) and
// runs them the way ECS does: the API against a real PostgreSQL, migrating on start,
// as a non-root user; then the restore drill against the migrated database. Slow
// (full image builds), so it runs in its own CI job: `pnpm test:docker`.
// API_IMAGE=<tag> / OPS_IMAGE=<tag> skip a build and test an image that already exists.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const image = process.env.API_IMAGE ?? 'paint-api:docker-test';
const opsImage = process.env.OPS_IMAGE ?? 'paint-ops:docker-test';

const build = (dockerfile: string, tag: string) =>
  run('docker', ['build', '-f', dockerfile, '-t', tag, '.'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });

let network: StartedNetwork;
let database: StartedPostgreSqlContainer;
let api: StartedTestContainer;
let migrationLog = '';

const databaseUrl = () =>
  `postgres://${database.getUsername()}:${database.getPassword()}@postgres:5432/${database.getDatabase()}`;

/** Runs a one-off container to completion, as ECS runs a task, and returns its output. */
async function runOnce(tag: string, env: Record<string, string>, command?: string[]) {
  let container = new GenericContainer(tag)
    .withNetwork(network)
    .withEnvironment(env)
    .withWaitStrategy(Wait.forOneShotStartup())
    .withStartupTimeout(120_000);
  if (command) container = container.withCommand(command);
  const started = await container.start();
  let output = '';
  for await (const chunk of await started.logs()) output += String(chunk);
  await started.stop();
  return output;
}

beforeAll(async () => {
  if (process.env.API_IMAGE === undefined) await build('apps/api/Dockerfile', image);
  if (process.env.OPS_IMAGE === undefined) await build('packages/ops/Dockerfile', opsImage);
  network = await new Network().start();
  database = await new PostgreSqlContainer('postgres:17-alpine')
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .start();
  // As a deploy does: migrate with a one-off ops task, then start the API without migrating.
  migrationLog = await runOnce(opsImage, { DATABASE_URL: databaseUrl() }, [
    'node',
    'src/migrate-cli.ts',
  ]);
  api = await new GenericContainer(image)
    .withNetwork(network)
    .withEnvironment({
      DATABASE_URL: databaseUrl(),
      RUN_MIGRATIONS: 'false',
      AUTH_SECRET: 'docker-image-test-secret-of-32-characters-or-more',
      // Production settings: documents on (not contacted until an upload), worker off.
      STORAGE_BUCKET: 'docker-test-documents',
      CLAMAV_HOST: 'clamav',
      WORKER_INTERVAL_SECONDS: '0',
      LOG_LEVEL: 'warn',
    })
    .withExposedPorts(3000)
    // The image's own HEALTHCHECK must turn healthy: it is what `docker run` users rely on.
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(120_000)
    .start();
}, 1_800_000);

afterAll(async () => {
  // Some may not exist if setup failed; stop what does, in order.
  for (const resource of [api, database, network] as { stop(): Promise<unknown> }[]) {
    await Promise.resolve()
      .then(() => resource.stop())
      .catch(() => undefined);
  }
});

describe('API container image', () => {
  it('starts after the one-off migration task and reports ready', async () => {
    const response = await fetch(
      `http://${api.getHost()}:${String(api.getMappedPort(3000))}/health/ready`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'up' } });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const migrations = await database.exec([
      'psql',
      '-U',
      database.getUsername(),
      '-d',
      database.getDatabase(),
      '-tAc',
      'SELECT count(*) FROM drizzle.__drizzle_migrations',
    ]);
    const applied = Number(migrations.output.trim());
    expect(applied).toBeGreaterThan(0);
    expect(migrationLog).toContain(
      `Migrations: ${String(applied)} applied, ${String(applied)} in this release`,
    );
    expect(migrationLog).not.toContain('PROBLEM');
  });

  it('runs as the unprivileged node user with read-only app files', async () => {
    const user = await api.exec(['id', '-u']);
    const write = await api.exec(['touch', '/app/dist/server/main.js']);

    expect(user.output.trim()).toBe('1000');
    expect(write.exitCode).not.toBe(0);
  });

  it('ships without package managers, dev dependencies or sources', async () => {
    const listing = await api.exec(['ls', '/app', '/app/node_modules', '/usr/local/bin']);

    expect(listing.output).toContain('dist');
    expect(listing.output).not.toMatch(/\b(npm|npx|corepack|vitest|typescript|src)\b/);
  });

  it('draws an invoice PDF with the bundled Noto fonts, writing nothing to disk', async () => {
    // The invoice PDF (apps/api/src/print) is pdfkit with fonts in dist/server/fonts: check
    // both are in the image and work as the read-only node user, in all three scripts.
    const script = `
      import PDFDocument from 'pdfkit';
      const fonts = '/app/dist/server/fonts/';
      const doc = new PDFDocument({ font: fonts + 'NotoSans-Regular.ttf' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const pdf = Buffer.concat(chunks);
        console.log(pdf.subarray(0, 5).toString(), pdf.length > 1000);
      });
      doc.text('Tax Invoice ₹18,073.00');
      doc.font(fonts + 'NotoSansDevanagari-Regular.ttf').text('टैक्स इनवॉइस');
      doc.font(fonts + 'NotoSansTelugu-Regular.ttf').text('ట్యాక్స్ ఇన్‌వాయిస్');
      doc.end();`;
    const result = await api.exec(['node', '--input-type=module', '-e', script]);

    expect(result.output.trim()).toBe('%PDF- true');
    expect(result.exitCode).toBe(0);
  });

  it('runs the restore drill from the ops image against the migrated database', async () => {
    const output = await runOnce(opsImage, { DRILL_SOURCE_URL: databaseUrl() });

    expect(output).toContain('RESTORE DRILL PASSED');
  });

  it('stops gracefully on SIGTERM', async () => {
    const id = api.getId();
    await run('docker', ['stop', '--timeout', '20', id]);
    const { stdout } = await run('docker', ['inspect', '--format', '{{.State.ExitCode}}', id]);

    // 0, or 143 when Node re-raises SIGTERM after closing the app (as Nest does).
    expect(['0', '143']).toContain(stdout.trim());
  });
});
