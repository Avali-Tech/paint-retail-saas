import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Files a tool reads its standard input from, or writes its standard output to. */
export interface ToolIo {
  readonly stdinFile?: string;
  readonly stdoutFile?: string;
  /** Extra environment, e.g. PGPASSWORD, so secrets never appear in the process list. */
  readonly env?: Readonly<Record<string, string>>;
}

export type CommandRunner = (command: string, args: readonly string[], io: ToolIo) => Promise<void>;

/** Runs pg_dump or pg_restore with the given arguments. */
export type PgTools = (
  tool: 'pg_dump' | 'pg_restore',
  args: readonly string[],
  io: ToolIo,
) => Promise<void>;

/** Hides passwords in URLs, in case a tool echoes its connection string. */
const hidePasswords = (text: string) => text.replace(/(:\/\/[^:/\s]+:)[^@\s]+@/g, '$1***@');

/** Runs a command, streaming files in and out; rejects with its stderr when it fails. */
export const runCommand: CommandRunner = async (command, args, io) => {
  const child = spawn(command, args, {
    env: { ...process.env, ...io.env },
    stdio: [io.stdinFile ? 'pipe' : 'ignore', io.stdoutFile ? 'pipe' : 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  // Rejects if the command cannot be started (not installed).
  const exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  const transfers: Promise<void>[] = [];
  if (io.stdinFile && child.stdin) {
    transfers.push(pipeline(createReadStream(io.stdinFile), child.stdin));
  }
  if (io.stdoutFile && child.stdout) {
    transfers.push(pipeline(child.stdout, createWriteStream(io.stdoutFile)));
  }
  // Wait for everything, so a failed command reports its own error rather than a broken pipe.
  const [exit, ...results] = await Promise.allSettled([exited, ...transfers]);
  if (exit.status === 'rejected') throw exit.reason;
  const [code, signal] = exit.value;
  if (code !== 0) {
    const reason = code === null ? `signal ${String(signal)}` : `code ${String(code)}`;
    throw new Error(`${command} exited with ${reason}: ${hidePasswords(stderr.trim())}`);
  }
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
};

/** pg_dump and pg_restore installed on this machine (or in `binDir`); they must be version 17+. */
export function localPgTools(binDir?: string, run: CommandRunner = runCommand): PgTools {
  return (tool, args, io) => run(binDir ? join(binDir, tool) : tool, args, io);
}

/**
 * pg_dump and pg_restore from a PostgreSQL image, for machines without matching
 * client tools. Uses the host network, so localhost addresses work as they do here.
 */
export function dockerPgTools(
  image = 'postgres:17-alpine',
  run: CommandRunner = runCommand,
): PgTools {
  return (tool, args, io) => {
    const passEnv = Object.keys(io.env ?? {}).flatMap((name) => ['--env', name]);
    const dockerArgs = ['run', '--rm', '-i', '--network', 'host', ...passEnv, image, tool, ...args];
    return run('docker', dockerArgs, io);
  };
}

/** libpq arguments and environment for a postgres:// URL; the password goes in PGPASSWORD. */
export function libpqConnection(url: string): { args: string[]; env: Record<string, string> } {
  const parsed = new URL(url);
  const env: Record<string, string> = {};
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslMode = parsed.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;
  return {
    args: [
      '--host',
      parsed.hostname,
      '--port',
      parsed.port || '5432',
      '--username',
      decodeURIComponent(parsed.username),
      '--dbname',
      decodeURIComponent(parsed.pathname.slice(1)),
    ],
    env,
  };
}
