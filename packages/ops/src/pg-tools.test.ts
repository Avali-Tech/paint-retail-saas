import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  dockerPgTools,
  libpqConnection,
  localPgTools,
  runCommand,
  type CommandRunner,
} from './pg-tools.ts';

let dir: string;
const node = process.execPath;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pg-tools-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runCommand', () => {
  it('streams a file into the command and its output into another, with extra env', async () => {
    const input = join(dir, 'in.txt');
    const output = join(dir, 'out.txt');
    await writeFile(input, 'hello');

    await runCommand(
      node,
      [
        '-e',
        'process.stdin.on("data", (d) => process.stdout.write(d.toString().toUpperCase() + process.env.EXTRA))',
      ],
      { stdinFile: input, stdoutFile: output, env: { EXTRA: '!' } },
    );

    expect(await readFile(output, 'utf8')).toBe('HELLO!');
  });

  it('runs without files', async () => {
    await expect(runCommand(node, ['-e', ''], {})).resolves.toBeUndefined();
  });

  it('fails with the exit code and stderr, hiding passwords', async () => {
    await expect(
      runCommand(
        node,
        ['-e', 'console.error("cannot reach postgres://drill:s3cret@db:5432/x"); process.exit(3)'],
        {},
      ),
    ).rejects.toThrow(/exited with code 3: cannot reach postgres:\/\/drill:\*\*\*@db:5432\/x$/);
  });

  it('fails when the command is killed by a signal', async () => {
    await expect(
      runCommand(node, ['-e', 'process.kill(process.pid, "SIGKILL")'], {}),
    ).rejects.toThrow('exited with signal SIGKILL');
  });

  it('fails when the command is not installed', async () => {
    await expect(runCommand('pg_dump_that_does_not_exist', [], {})).rejects.toThrow(/ENOENT/);
  });

  it('fails when the output cannot be written, even if the command succeeded', async () => {
    await expect(
      runCommand(node, ['-e', 'process.stdout.on("error", () => {}); process.stdout.write("x")'], {
        stdoutFile: join(dir, 'missing-folder', 'out.txt'),
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('localPgTools', () => {
  it('runs the tool from PATH or from the given folder', async () => {
    const run = vi.fn<CommandRunner>(() => Promise.resolve());

    await localPgTools(undefined, run)('pg_dump', ['--help'], {});
    await localPgTools('/usr/lib/postgresql/17/bin', run)('pg_restore', ['-l'], {});

    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['pg_dump', ['--help']],
      ['/usr/lib/postgresql/17/bin/pg_restore', ['-l']],
    ]);
  });

  it('defaults to running real commands', () => {
    expect(typeof localPgTools()).toBe('function');
  });
});

describe('dockerPgTools', () => {
  it('runs the tool in a container on the host network, passing env by name only', async () => {
    const run = vi.fn<CommandRunner>(() => Promise.resolve());
    const io = { stdinFile: 'in.dump', env: { PGPASSWORD: 'secret' } };

    await dockerPgTools('postgres:17.6-alpine', run)('pg_restore', ['--list'], io);
    await dockerPgTools(undefined, run)('pg_dump', [], {});

    expect(run).toHaveBeenNthCalledWith(
      1,
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        '--env',
        'PGPASSWORD',
        'postgres:17.6-alpine',
        'pg_restore',
        '--list',
      ],
      io,
    );
    expect(run.mock.calls[1]?.[1]).toContain('postgres:17-alpine');
    expect(run.mock.calls[0]?.[1]).not.toContain('secret');
  });

  it('defaults to running real commands', () => {
    expect(typeof dockerPgTools()).toBe('function');
  });
});

describe('libpqConnection', () => {
  it('splits a URL into arguments and keeps the password and TLS mode in the environment', () => {
    expect(
      libpqConnection('postgres://app%40x:p%40ss@db.internal:6543/paint?sslmode=verify-full'),
    ).toEqual({
      args: ['--host', 'db.internal', '--port', '6543', '--username', 'app@x', '--dbname', 'paint'],
      env: { PGPASSWORD: 'p@ss', PGSSLMODE: 'verify-full' },
    });
  });

  it('defaults the port and leaves out what is not given', () => {
    expect(libpqConnection('postgresql://paint@localhost/paint')).toEqual({
      args: ['--host', 'localhost', '--port', '5432', '--username', 'paint', '--dbname', 'paint'],
      env: {},
    });
  });
});
