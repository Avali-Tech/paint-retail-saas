import { dockerPgTools, localPgTools, type PgTools } from './pg-tools.ts';
import type { RestoreDrillOptions } from './restore-drill.ts';

/** Thrown for missing or invalid drill settings; never includes connection strings. */
export class DrillConfigError extends Error {
  override readonly name = 'DrillConfigError';
}

export const DRILL_USAGE = `Restore drill: dump a database, restore it into a fresh database, compare.

Environment:
  DRILL_SOURCE_URL     postgres:// URL of the database to back up
                       (or DATABASE_URL, with DRILL_SOURCE_HOST to point it at another instance,
                       e.g. one restored to a point in time)
  DRILL_TARGET_URL     postgres:// URL of any database on the server to restore onto
                       (or DRILL_TARGET_HOST; default: the source's server)
  DRILL_TOOLS          "local" (pg_dump/pg_restore 17 on PATH, default) or "docker"
  DRILL_DOCKER_IMAGE   image for DRILL_TOOLS=docker (default postgres:17-alpine)
  DRILL_PG_BIN         folder holding pg_dump and pg_restore
  DRILL_KEEP=true      keep the restored database instead of dropping it
`;

type Env = Readonly<Record<string, string | undefined>>;

function withHost(url: string, host: string | undefined): string {
  if (host === undefined || host === '') return url;
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.toString();
}

function postgresUrl(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new DrillConfigError(`${name} is not set`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DrillConfigError(`${name} is not a valid URL`);
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new DrillConfigError(`${name} must be a postgres:// URL`);
  }
  return value;
}

const nonEmpty = (value: string | undefined) => (value === '' ? undefined : value);

function toolsFrom(env: Env): PgTools {
  const kind = env.DRILL_TOOLS ?? 'local';
  if (kind === 'docker') return dockerPgTools(nonEmpty(env.DRILL_DOCKER_IMAGE));
  if (kind === 'local') return localPgTools(nonEmpty(env.DRILL_PG_BIN));
  throw new DrillConfigError('DRILL_TOOLS must be "local" or "docker"');
}

/** Reads the drill's settings from the environment (see DRILL_USAGE). */
export function drillOptionsFromEnv(env: Env): RestoreDrillOptions {
  const sourceName = env.DRILL_SOURCE_URL ? 'DRILL_SOURCE_URL' : 'DATABASE_URL';
  const sourceUrl = withHost(postgresUrl(sourceName, env[sourceName]), env.DRILL_SOURCE_HOST);
  const targetServerUrl = env.DRILL_TARGET_URL
    ? postgresUrl('DRILL_TARGET_URL', env.DRILL_TARGET_URL)
    : withHost(sourceUrl, env.DRILL_TARGET_HOST);
  return {
    sourceUrl,
    targetServerUrl,
    tools: toolsFrom(env),
    keep: env.DRILL_KEEP === 'true',
    log: (message) => {
      console.log(`[restore-drill] ${message}`);
    },
  };
}
