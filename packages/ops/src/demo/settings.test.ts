import { describe, expect, it } from 'vitest';
import { checkPrerequisites, credsStoreProblem, type Probe } from './prerequisites.ts';
import {
  apiEnv,
  apiUrl,
  composeArgs,
  composeEnv,
  composeServices,
  databaseUrl,
  daysSince,
  DEMO_AUTH_SECRET,
  demoSettings,
  isSmsLine,
  mailUrl,
  seedEnv,
  storageUrl,
  stripAnsi,
  webUrl,
} from './settings.ts';

const root = '/repo';

describe('demoSettings', () => {
  it('starts with sensible defaults', () => {
    const settings = demoSettings([], {}, root);
    expect(settings).toMatchObject({
      command: 'start',
      fresh: false,
      clamav: false,
      size: 'full',
      project: 'paint-demo',
      stateDir: '/repo/.demo',
      ports: {
        api: 3000,
        web: 5173,
        postgres: 55_432,
        storage: 58_333,
        smtp: 51_025,
        mail: 58_025,
        clamav: 53_310,
      },
    });
    expect(webUrl(settings)).toBe('http://localhost:5173');
    expect(mailUrl(settings)).toBe('http://localhost:58025');
    expect(apiUrl(settings)).toBe('http://127.0.0.1:3000');
    expect(storageUrl(settings)).toBe('http://localhost:58333');
    expect(databaseUrl(settings)).toBe('postgres://paint:paint@localhost:55432/paint_demo');
  });

  it('reads commands, options and environment overrides', () => {
    const settings = demoSettings(
      ['start', '--fresh', '--clamav'],
      { DEMO_API_PORT: '3981', DEMO_WEB_PORT: '', DEMO_COMPOSE_PROJECT: 'x', DEMO_SIZE: 'small' },
      root,
    );
    expect(settings).toMatchObject({ fresh: true, clamav: true, size: 'small', project: 'x' });
    expect(settings.ports.api).toBe(3981);
    expect(settings.ports.web).toBe(5173);
    expect(demoSettings(['stop'], {}, root).command).toBe('stop');
    expect(demoSettings([], { DEMO_SIZE: 'large' }, root).size).toBe('large');
  });

  it('explains mistakes', () => {
    expect(() => demoSettings(['launch'], {}, root)).toThrow('Unknown command "launch"');
    expect(() => demoSettings(['start', 'now'], {}, root)).toThrow('Unknown command');
    expect(() => demoSettings(['--fast'], {}, root)).toThrow('Unknown option --fast');
    expect(() => demoSettings([], { DEMO_API_PORT: 'abc' }, root)).toThrow(
      'DEMO_API_PORT must be a port',
    );
    expect(() => demoSettings([], { PAINT_MAIL_PORT: '70000' }, root)).toThrow('PAINT_MAIL_PORT');
    expect(() => demoSettings([], { DEMO_SIZE: 'huge' }, root)).toThrow('DEMO_SIZE');
  });
});

describe('what the demo runs', () => {
  const settings = demoSettings(
    ['--clamav'],
    { PAINT_POSTGRES_PORT: '55981', DEMO_WEB_PORT: '4981' },
    root,
  );

  it('starts only the compose services it needs', () => {
    expect(composeServices(settings)).toEqual(['postgres', 'storage', 'mail', 'clamav']);
    expect(composeServices(demoSettings([], {}, root))).toEqual(['postgres', 'storage', 'mail']);
    expect(composeServices(settings, { all: false })).toEqual(['postgres']);
    expect(composeArgs(settings, 'stop')).toEqual([
      '-p',
      'paint-demo',
      '-f',
      '/repo/compose.yaml',
      'stop',
    ]);
    expect(composeEnv(settings)).toMatchObject({
      PAINT_POSTGRES_PORT: '55981',
      PAINT_CLAMAV_PORT: '53310',
    });
  });

  it('gives the API and the seed the same database and secret', () => {
    const api = apiEnv(settings);
    const seed = seedEnv(settings);
    expect(api.DATABASE_URL).toBe('postgres://paint:paint@localhost:55981/paint_demo');
    expect(seed.DATABASE_URL).toBe(api.DATABASE_URL);
    expect(api.AUTH_SECRET).toBe(DEMO_AUTH_SECRET);
    expect(seed.AUTH_SECRET).toBe(DEMO_AUTH_SECRET);
    expect(DEMO_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(api).toMatchObject({
      SMS_PROVIDER: 'log',
      RUN_MIGRATIONS: 'true',
      APP_URL: 'http://localhost:4981',
    });
    expect(seed).toMatchObject({
      DEMO_CREDENTIALS_FILE: '/repo/.demo/credentials.txt',
      DEMO_WEB_URL: 'http://localhost:4981',
    });
  });

  it('picks sign-in code lines out of the API log', () => {
    const line =
      '\u001b[33m[Nest] 1  - \u001b[39m WARN \u001b[38;5;3m[SMS] \u001b[39mTo +91900: 123456 is your code';
    expect(isSmsLine(line)).toBe(true);
    expect(isSmsLine('[Nest] LOG [RoutesResolver]')).toBe(false);
    expect(stripAnsi(line)).toBe('[Nest] 1  -  WARN [SMS] To +91900: 123456 is your code');
  });

  it('counts the days since seeding', () => {
    expect(daysSince('2026-10-04', '2026-10-04')).toBe(0);
    expect(daysSince('2026-10-01', '2026-10-04')).toBe(3);
  });
});

/** A machine with everything installed, unless told otherwise. */
function probe(
  overrides: Partial<Probe> & { failing?: string[]; files?: Record<string, string> } = {},
): Probe {
  const failing = new Set(overrides.failing ?? []);
  const files = overrides.files ?? {};
  return {
    run: (command, args) => ({
      ok: !failing.has([command, ...args].join(' ')) && !failing.has(command),
      output: '',
    }),
    readFile: (path) => files[path] ?? null,
    exists: (path) => !failing.has(`exists ${path}`),
    env: { HOME: '/home/me' },
    nodeVersion: '24.21.0',
    root,
    ...overrides,
  };
}

describe('checkPrerequisites', () => {
  it('passes on a ready machine and prefers the compose plugin', () => {
    expect(checkPrerequisites(probe())).toEqual({ problems: [], compose: ['docker', 'compose'] });
    expect(checkPrerequisites(probe({ failing: ['docker compose version'] })).compose).toEqual([
      'docker-compose',
    ]);
  });

  it('says how to fix each missing piece', () => {
    const result = checkPrerequisites(
      probe({
        nodeVersion: '22.9.0',
        failing: ['pnpm', 'exists /repo/node_modules', 'docker --version'],
      }),
    );
    expect(result.compose).toBeNull();
    expect(result.problems.join('\n')).toContain('Node.js 24 is needed (this is 22.9.0)');
    expect(result.problems.join('\n')).toContain('corepack enable');
    expect(result.problems.join('\n')).toContain('pnpm install');
    expect(result.problems.join('\n')).toContain('brew install colima docker docker-compose');
  });

  it('notices Docker not running and Compose missing', () => {
    const result = checkPrerequisites(
      probe({
        failing: [
          'docker info --format {{.ServerVersion}}',
          'docker compose version',
          'docker-compose',
        ],
      }),
    );
    expect(result.compose).toBeNull();
    expect(result.problems[0]).toContain('colima start');
    expect(result.problems[1]).toContain('cliPluginsExtraDirs');
  });

  it('catches Docker Desktop’s credential helper left behind', () => {
    const files = { '/home/me/.docker/config.json': '{"credsStore": "desktop"}' };
    const result = checkPrerequisites(probe({ files, failing: ['docker-credential-desktop'] }));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('remove the "credsStore" line');
    expect(credsStoreProblem(probe({ files }))).toBeNull();
  });

  it('reads DOCKER_CONFIG and copes with odd config files', () => {
    const at = (text: string) =>
      credsStoreProblem(
        probe({
          env: { DOCKER_CONFIG: '/cfg' },
          files: { '/cfg/config.json': text },
          failing: ['docker-credential-x'],
        }),
      );
    expect(at('{}')).toBeNull();
    expect(at('{"credsStore": ""}')).toBeNull();
    expect(at('not json')).toContain('not valid JSON');
    expect(at('{"credsStore": "x"}')).toContain('docker-credential-x');
    expect(credsStoreProblem(probe({ env: {} }))).toBeNull();
  });
});
