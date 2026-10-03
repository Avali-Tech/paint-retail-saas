import { describe, expect, it, vi } from 'vitest';
import { DRILL_USAGE, DrillConfigError, drillOptionsFromEnv } from './cli-options.ts';

const SOURCE = 'postgres://paint:secret@prod-db.internal:5432/paint';

describe('drillOptionsFromEnv', () => {
  it('restores onto the source server by default, with local tools, dropping the copy', () => {
    const options = drillOptionsFromEnv({ DRILL_SOURCE_URL: SOURCE });

    expect(options).toMatchObject({ sourceUrl: SOURCE, targetServerUrl: SOURCE, keep: false });
    expect(typeof options.tools).toBe('function');
  });

  it('takes DATABASE_URL and points source and target at other hosts', () => {
    const options = drillOptionsFromEnv({
      DATABASE_URL: SOURCE,
      DRILL_SOURCE_HOST: 'drill-pitr.internal',
      DRILL_TARGET_HOST: 'scratch.internal',
      DRILL_KEEP: 'true',
    });

    expect(options.sourceUrl).toBe('postgres://paint:secret@drill-pitr.internal:5432/paint');
    expect(options.targetServerUrl).toBe('postgres://paint:secret@scratch.internal:5432/paint');
    expect(options.keep).toBe(true);
  });

  it('takes an explicit target URL, and ignores blank host overrides', () => {
    const options = drillOptionsFromEnv({
      DRILL_SOURCE_URL: SOURCE,
      DRILL_SOURCE_HOST: '',
      DRILL_TARGET_URL: 'postgresql://admin:x@other:5432/postgres',
    });

    expect(options.sourceUrl).toBe(SOURCE);
    expect(options.targetServerUrl).toBe('postgresql://admin:x@other:5432/postgres');
  });

  it.each([
    [{ DRILL_TOOLS: 'docker' }],
    [{ DRILL_TOOLS: 'docker', DRILL_DOCKER_IMAGE: 'postgres:17.6' }],
    [{ DRILL_TOOLS: 'docker', DRILL_DOCKER_IMAGE: '' }],
    [{ DRILL_TOOLS: 'local', DRILL_PG_BIN: '/opt/pg/bin' }],
  ])('chooses the tools from %o', (env) => {
    expect(typeof drillOptionsFromEnv({ DRILL_SOURCE_URL: SOURCE, ...env }).tools).toBe('function');
  });

  it.each([
    [{}, 'DATABASE_URL is not set'],
    [{ DRILL_SOURCE_URL: '', DATABASE_URL: '' }, 'DATABASE_URL is not set'],
    [{ DRILL_SOURCE_URL: 'not a url' }, 'DRILL_SOURCE_URL is not a valid URL'],
    [{ DRILL_SOURCE_URL: 'mysql://x@y/z' }, 'DRILL_SOURCE_URL must be a postgres:// URL'],
    [
      { DRILL_SOURCE_URL: SOURCE, DRILL_TARGET_URL: 'http://x' },
      'DRILL_TARGET_URL must be a postgres:// URL',
    ],
    [{ DRILL_SOURCE_URL: SOURCE, DRILL_TOOLS: 'ssh' }, 'DRILL_TOOLS must be "local" or "docker"'],
  ])('rejects %o', (env, message) => {
    const read = () => drillOptionsFromEnv(env);
    expect(read).toThrow(DrillConfigError);
    expect(read).toThrow(message);
  });

  it('logs with a prefix, and documents its settings', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    drillOptionsFromEnv({ DRILL_SOURCE_URL: SOURCE }).log?.('hello');

    expect(log).toHaveBeenCalledWith('[restore-drill] hello');
    log.mockRestore();
    expect(DRILL_USAGE).toContain('DRILL_SOURCE_URL');
  });
});
