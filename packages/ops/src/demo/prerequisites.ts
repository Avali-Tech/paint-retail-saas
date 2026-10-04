import { join } from 'node:path';

/** What the checks may look at: commands, files and the environment, so tests can fake them. */
export interface Probe {
  /** Runs a command and answers whether it succeeded, with its output. */
  run(command: string, args: readonly string[]): { ok: boolean; output: string };
  /** A file's text, or null when it does not exist. */
  readFile(path: string): string | null;
  exists(path: string): boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** process.versions.node */
  readonly nodeVersion: string;
  /** The repository root. */
  readonly root: string;
}

export interface CheckResult {
  /** Things that must be fixed first, each with how. */
  readonly problems: string[];
  /** How to run Docker Compose here: the plugin or the standalone binary. */
  readonly compose: readonly string[] | null;
}

const DOCKER_HELP =
  'Start Docker: `colima start --cpu 4 --memory 6` (Colima), or open Docker Desktop.';

/**
 * Checks everything `pnpm demo` needs, with a clear message and the command
 * to fix each problem (see README "Run the demo").
 */
export function checkPrerequisites(probe: Probe): CheckResult {
  const problems: string[] = [];

  const major = Number(probe.nodeVersion.split('.')[0]);
  if (major < 24) {
    problems.push(
      `Node.js 24 is needed (this is ${probe.nodeVersion}): \`mise use -g node@24\` or \`nvm install 24 && nvm use 24\`.`,
    );
  }
  if (!probe.run('pnpm', ['--version']).ok) {
    problems.push('pnpm is missing: `corepack enable` (or `npm install -g pnpm`).');
  }
  if (!probe.exists(join(probe.root, 'node_modules'))) {
    problems.push('Dependencies are not installed: run `pnpm install` in the repository first.');
  }

  let compose: string[] | null = null;
  if (!probe.run('docker', ['--version']).ok) {
    problems.push(
      'Docker is missing: `brew install colima docker docker-compose`, then `colima start --cpu 4 --memory 6` (or install Docker Desktop).',
    );
  } else {
    const info = probe.run('docker', ['info', '--format', '{{.ServerVersion}}']);
    if (!info.ok) problems.push(`Docker is installed but not running. ${DOCKER_HELP}`);
    if (probe.run('docker', ['compose', 'version']).ok) compose = ['docker', 'compose'];
    else if (probe.run('docker-compose', ['version']).ok) compose = ['docker-compose'];
    else {
      problems.push(
        'Docker Compose is missing: `brew install docker-compose`, then add\n' +
          '  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]\n' +
          '  to ~/.docker/config.json (Docker Desktop includes it).',
      );
    }
    const credentialsHelper = credsStoreProblem(probe);
    if (credentialsHelper !== null) problems.push(credentialsHelper);
  }
  return { problems, compose };
}

/**
 * Docker Desktop leaves `"credsStore": "desktop"` in ~/.docker/config.json;
 * without Docker Desktop's helper on PATH (e.g. under Colima) every image pull
 * fails with "docker-credential-desktop: executable file not found".
 */
export function credsStoreProblem(probe: Probe): string | null {
  const configDir = probe.env.DOCKER_CONFIG ?? join(probe.env.HOME ?? '', '.docker');
  const configFile = join(configDir, 'config.json');
  const text = probe.readFile(configFile);
  if (text === null) return null;
  let store: unknown;
  try {
    store = (JSON.parse(text) as { credsStore?: unknown }).credsStore;
  } catch {
    return `${configFile} is not valid JSON; fix or remove it.`;
  }
  if (typeof store !== 'string' || store === '') return null;
  if (probe.run(`docker-credential-${store}`, ['list']).ok) return null;
  return (
    `${configFile} has "credsStore": "${store}", but docker-credential-${store} is not installed, ` +
    'so image pulls will fail (common after removing Docker Desktop or switching to Colima).\n' +
    `  Fix: remove the "credsStore" line from ${configFile}.`
  );
}
