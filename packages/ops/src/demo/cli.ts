// `pnpm demo [start|stop|reset|seed] [--fresh] [--clamav]`: the local demo on one
// machine. Only starts and stops processes; the decisions live in settings.ts,
// prerequisites.ts and services.ts (tested), the demo data in apps/api/src/demo.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPrerequisites } from './prerequisites.ts';
import { createBucket, lineSplitter, portInUse, waitForUrl } from './services.ts';
import {
  apiEnv,
  apiUrl,
  composeArgs,
  composeEnv,
  composeServices,
  daysSince,
  DEMO_BUCKET,
  demoSettings,
  isSmsLine,
  mailUrl,
  seedEnv,
  storageUrl,
  stripAnsi,
  webUrl,
  type DemoSettings,
} from './settings.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const say = (line = '') => {
  console.log(line);
};
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

function run(command: string, args: readonly string[], env: Record<string, string> = {}): void {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) fail(`${[command, ...args].join(' ')} failed`);
}

function capture(command: string, args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

function checks(): readonly string[] {
  say('Checking prerequisites…');
  const result = checkPrerequisites({
    run: (command, args) => capture(command, args),
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    exists: existsSync,
    env: process.env,
    nodeVersion: process.versions.node,
    root,
  });
  if (result.problems.length > 0 || result.compose === null) {
    fail(`Fix these first:\n\n${result.problems.map((problem) => `  • ${problem}`).join('\n\n')}`);
  }
  return result.compose ?? [];
}

function compose(settings: DemoSettings, composeCommand: readonly string[], ...args: string[]) {
  const [command = 'docker', ...prefix] = composeCommand;
  run(command, [...prefix, ...composeArgs(settings, ...args)], composeEnv(settings));
}

function seedCommand(settings: DemoSettings, command: 'seed' | 'reset' | 'status') {
  const seed = join(root, 'apps', 'api', 'dist', 'demo', 'seed.js');
  if (command === 'status') return capture(process.execPath, [seed, 'status'], seedEnv(settings));
  run(process.execPath, [seed, command], seedEnv(settings));
  return null;
}

/** Starts a long-running process with its output in .demo/<name>.log. */
function background(
  settings: DemoSettings,
  name: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; echo?: (line: string) => boolean },
): ChildProcess {
  const log = createWriteStream(join(settings.stateDir, `${name}.log`));
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: Ctrl-C reaches only this script, which then stops it in order.
    detached: true,
  });
  process.on('exit', () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const echo = lineSplitter((line) => {
    if (options.echo?.(line)) say(`[${name}] ${stripAnsi(line).trim()}`);
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      log.write(chunk);
      echo(chunk);
    });
  }
  child.on('exit', () => log.end());
  return child;
}

async function start(settings: DemoSettings) {
  const composeCommand = checks();
  for (const [name, port] of [
    ['API', settings.ports.api],
    ['web app', settings.ports.web],
  ] as const) {
    if (await portInUse(port)) {
      fail(
        `Port ${String(port)} (the ${name}) is already in use. Stop whatever uses it, or pick ` +
          `another: DEMO_${name === 'API' ? 'API' : 'WEB'}_PORT=${String(port + 1)} pnpm demo`,
      );
    }
  }
  mkdirSync(settings.stateDir, { recursive: true });

  say(
    '\nStarting PostgreSQL, S3 storage and Mailpit' + (settings.clamav ? ' and ClamAV' : '') + '…',
  );
  compose(settings, composeCommand, 'up', '-d', '--wait', ...composeServices(settings));
  await createBucket(storageUrl(settings), DEMO_BUCKET);

  say('\nBuilding the API, the web app and the demo seed (fast after the first time)…');
  run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@paint/api', '--filter=@paint/web']);
  run('pnpm', ['--filter', '@paint/api', 'build:demo']);

  say('\nPreparing the demo data…');
  seedCommand(settings, settings.fresh ? 'reset' : 'seed');
  const status = seedCommand(settings, 'status');
  const seeded = /seeded (\S+)/.exec(status?.output ?? '')?.[1];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (seeded !== undefined && daysSince(seeded, today) > 0) {
    say(
      `\n! The demo data was created on ${seeded}, so "due today" follow-ups and recent history ` +
        'are from that day. `pnpm demo --fresh` re-creates it with today’s dates (about 10 s).',
    );
  }

  say('\nStarting the API and the web app…');
  const api = background(
    settings,
    'api',
    ['--enable-source-maps', join(root, 'apps/api/dist/server/main.js')],
    {
      cwd: join(root, 'apps', 'api'),
      env: apiEnv(settings),
      echo: isSmsLine,
    },
  );
  const web = background(
    settings,
    'web',
    [
      join(root, 'apps/web/node_modules/vite/bin/vite.js'),
      'preview',
      '--port',
      String(settings.ports.web),
      '--strictPort',
    ],
    { cwd: join(root, 'apps', 'web'), env: { API_URL: apiUrl(settings) } },
  );
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    say('\nStopping the API and the web app…');
    await Promise.all(
      [api, web].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) resolve();
            else {
              child.once('exit', () => {
                resolve();
              });
              child.kill('SIGTERM');
            }
          }),
      ),
    );
    say(
      'Stopped. The Docker services keep running (and keep the data): `pnpm demo:stop` stops them.',
    );
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));
  for (const [name, child] of [
    ['api', api],
    ['web', web],
  ] as const) {
    child.on('exit', (code) => {
      if (!stopping) {
        console.error(
          `\n✗ The ${name} process stopped (exit ${String(code)}); see .demo/${name}.log`,
        );
        void stop(1);
      }
    });
  }
  try {
    await waitForUrl(`${apiUrl(settings)}/health/ready`, {
      stillRunning: () => api.exitCode === null,
    });
    await waitForUrl(`${webUrl(settings)}/api/health`, {
      stillRunning: () => web.exitCode === null,
    });
  } catch (error) {
    console.error(`\n✗ ${String(error)}; see .demo/api.log and .demo/web.log`);
    await stop(1);
  }

  say('');
  const sheet = join(settings.stateDir, 'credentials.txt');
  say(
    existsSync(sheet)
      ? readFileSync(sheet, 'utf8')
      : 'The sign-in sheet (.demo/credentials.txt) is missing: `pnpm demo --fresh` writes a new one.\n' +
          'Everyone signs in with their mobile number and the password Demo@2026.',
  );
  say(`Ready: ${webUrl(settings)}  (emails: ${mailUrl(settings)}; logs: .demo/)`);
  if (!settings.clamav) {
    say('Document uploads need ClamAV: restart with `pnpm demo --clamav` to try them.');
  }
  say('Press Ctrl-C to stop.');
}

async function main() {
  let settings: DemoSettings;
  try {
    settings = demoSettings(process.argv.slice(2), process.env, root);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (settings.command === 'start') return start(settings);
  const composeCommand = checks();
  if (settings.command === 'stop') {
    compose(settings, composeCommand, 'stop');
    say('Demo services stopped; the data is kept. `pnpm demo` starts everything again.');
    return;
  }
  mkdirSync(settings.stateDir, { recursive: true });
  compose(
    settings,
    composeCommand,
    'up',
    '-d',
    '--wait',
    ...composeServices(settings, { all: false }),
  );
  run('pnpm', ['--filter', '@paint/api', 'build:demo']);
  seedCommand(settings, settings.command);
}

await main();
