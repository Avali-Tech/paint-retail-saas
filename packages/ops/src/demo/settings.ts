import { join } from 'node:path';

/** What `pnpm demo …` can be asked to do. */
export const DEMO_COMMANDS = ['start', 'stop', 'reset', 'seed'] as const;
export type DemoCommand = (typeof DEMO_COMMANDS)[number];

export const DEMO_USAGE = `Local demo of Paint Retail with the Sharma Paints & Hardware demo business.

  pnpm demo              start everything (services, API, web app); Ctrl-C stops the app
  pnpm demo --fresh      the same, but re-create the demo data first (dates move to today)
  pnpm demo --clamav     also start ClamAV, so document uploads work (needs ~1.5 GB more memory)
  pnpm demo:seed         create the demo data if it is not there yet
  pnpm demo:reset        drop the demo database and create the demo data again
  pnpm demo:stop         stop the Docker services (the data is kept)

Environment (all optional): DEMO_API_PORT (3000), DEMO_WEB_PORT (5173),
PAINT_POSTGRES_PORT (55432), PAINT_STORAGE_PORT (58333), PAINT_SMTP_PORT (51025),
PAINT_MAIL_PORT (58025), PAINT_CLAMAV_PORT (53310), DEMO_COMPOSE_PROJECT (paint-demo),
DEMO_SIZE (full or small; large adds a large shop's volume for performance testing,
not for client demos).`;

/**
 * Only for this local demo: the API seals authenticator secrets with it, and the
 * seed must use the same one. Never used anywhere real.
 */
export const DEMO_AUTH_SECRET = 'sharma-paints-local-demo-only-secret-0000';
export const DEMO_DATABASE = 'paint_demo';
export const DEMO_BUCKET = 'paint-documents';

export interface DemoPorts {
  readonly api: number;
  readonly web: number;
  readonly postgres: number;
  readonly storage: number;
  readonly smtp: number;
  readonly mail: number;
  readonly clamav: number;
}

export interface DemoSettings {
  readonly command: DemoCommand;
  /** Re-create the demo data before starting. */
  readonly fresh: boolean;
  readonly clamav: boolean;
  readonly size: 'full' | 'small' | 'large';
  /** Docker Compose project name: keeps the demo's containers and volumes apart. */
  readonly project: string;
  readonly ports: DemoPorts;
  /** The repository root. */
  readonly root: string;
  /** Logs and the printed sign-in sheet. */
  readonly stateDir: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Thrown for a mistyped command, option or setting; the message says what to fix. */
export class DemoUsageError extends Error {
  override readonly name = 'DemoUsageError';
}

function port(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new DemoUsageError(`${name} must be a port number (1-65535), not "${value}"`);
  }
  return parsed;
}

/** Reads the command line (`start --fresh`, `stop`, …) and the environment. */
export function demoSettings(args: readonly string[], env: Env, root: string): DemoSettings {
  const options = args.filter((arg) => arg.startsWith('-'));
  const [command = 'start', ...extra] = args.filter((arg) => !arg.startsWith('-'));
  if (!DEMO_COMMANDS.includes(command as DemoCommand) || extra.length > 0) {
    throw new DemoUsageError(`Unknown command "${args.join(' ')}".\n\n${DEMO_USAGE}`);
  }
  const unknown = options.filter((option) => !['--fresh', '--clamav'].includes(option));
  if (unknown.length > 0) {
    throw new DemoUsageError(`Unknown option ${unknown.join(', ')}.\n\n${DEMO_USAGE}`);
  }
  const size = env.DEMO_SIZE ?? 'full';
  if (size !== 'full' && size !== 'small' && size !== 'large') {
    throw new DemoUsageError(`DEMO_SIZE must be full, small or large, not "${size}"`);
  }
  return {
    command: command as DemoCommand,
    fresh: options.includes('--fresh'),
    clamav: options.includes('--clamav'),
    size,
    project: env.DEMO_COMPOSE_PROJECT ?? 'paint-demo',
    ports: {
      api: port(env, 'DEMO_API_PORT', 3000),
      web: port(env, 'DEMO_WEB_PORT', 5173),
      postgres: port(env, 'PAINT_POSTGRES_PORT', 55_432),
      storage: port(env, 'PAINT_STORAGE_PORT', 58_333),
      smtp: port(env, 'PAINT_SMTP_PORT', 51_025),
      mail: port(env, 'PAINT_MAIL_PORT', 58_025),
      clamav: port(env, 'PAINT_CLAMAV_PORT', 53_310),
    },
    root,
    stateDir: join(root, '.demo'),
  };
}

export const webUrl = (settings: DemoSettings) => `http://localhost:${String(settings.ports.web)}`;
export const apiUrl = (settings: DemoSettings) => `http://127.0.0.1:${String(settings.ports.api)}`;
export const mailUrl = (settings: DemoSettings) =>
  `http://localhost:${String(settings.ports.mail)}`;
export const storageUrl = (settings: DemoSettings) =>
  `http://localhost:${String(settings.ports.storage)}`;
export const databaseUrl = (settings: DemoSettings) =>
  `postgres://paint:paint@localhost:${String(settings.ports.postgres)}/${DEMO_DATABASE}`;

/** compose.yaml services the demo needs; ClamAV only on request (it is heavy). */
export function composeServices(settings: DemoSettings, { all = true } = {}): string[] {
  if (!all) return ['postgres'];
  return ['postgres', 'storage', 'mail', ...(settings.clamav ? ['clamav'] : [])];
}

/** `docker compose` arguments for the demo's project. */
export function composeArgs(settings: DemoSettings, ...args: string[]): string[] {
  return ['-p', settings.project, '-f', join(settings.root, 'compose.yaml'), ...args];
}

/** Host ports for compose.yaml. */
export function composeEnv(settings: DemoSettings): Record<string, string> {
  const { ports } = settings;
  return {
    PAINT_POSTGRES_PORT: String(ports.postgres),
    PAINT_STORAGE_PORT: String(ports.storage),
    PAINT_SMTP_PORT: String(ports.smtp),
    PAINT_MAIL_PORT: String(ports.mail),
    PAINT_CLAMAV_PORT: String(ports.clamav),
  };
}

/** The API's settings for the demo (see apps/api/src/config.ts). */
export function apiEnv(settings: DemoSettings): Record<string, string> {
  return {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(settings.ports.api),
    DATABASE_URL: databaseUrl(settings),
    RUN_MIGRATIONS: 'true',
    LOG_LEVEL: 'log',
    AUTH_SECRET: DEMO_AUTH_SECRET,
    // Mobile sign-in codes are printed by the API instead of texted.
    SMS_PROVIDER: 'log',
    // WhatsApp messages to parties (reminders, statements, points) are printed too.
    MESSAGING_PROVIDER: 'log',
    STORAGE_BUCKET: DEMO_BUCKET,
    STORAGE_ENDPOINT: storageUrl(settings),
    STORAGE_ACCESS_KEY_ID: 'local',
    STORAGE_SECRET_ACCESS_KEY: 'local',
    // Uploads are scanned here; without --clamav nothing listens and uploads are refused.
    CLAMAV_HOST: 'localhost',
    CLAMAV_PORT: String(settings.ports.clamav),
    APP_URL: webUrl(settings),
    EMAIL_PROVIDER: 'smtp',
    SMTP_URL: `smtp://localhost:${String(settings.ports.smtp)}`,
    EMAIL_FROM: 'Sharma Paints <alerts@sharmapaints.example>',
    WORKER_INTERVAL_SECONDS: '10',
  };
}

/** The demo seed's settings (see apps/api/src/demo/seed-command.ts). */
export function seedEnv(settings: DemoSettings): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(settings),
    AUTH_SECRET: DEMO_AUTH_SECRET,
    DEMO_SIZE: settings.size,
    DEMO_CREDENTIALS_FILE: join(settings.stateDir, 'credentials.txt'),
    DEMO_WEB_URL: webUrl(settings),
  };
}

/**
 * True when a line of the API's output carries a mobile sign-in code
 * (the "log" SMS provider writes them with the SMS context).
 */
export function isSmsLine(line: string): boolean {
  return stripAnsi(line).includes('[SMS]');
}

/** A log line without terminal colours. */
export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex -- matching the escape character is the point
  return line.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Days between the seed date and today, both YYYY-MM-DD; 0 when seeded today. */
export function daysSince(seeded: string, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(seeded)) / 86_400_000);
}
