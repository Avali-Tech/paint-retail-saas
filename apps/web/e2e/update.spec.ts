import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { API_URL, UPDATE_WEB_PORT } from './env.js';

// A deploy while the app is open: version A is the build under test (dist), version B the
// same app rebuilt with another build id. Both are served by `vite preview` on one origin of
// their own, so the service worker sees B as an update of A.
const webDir = join(import.meta.dirname, '..');
const vite = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
const versionA = join(webDir, 'dist');
const versionB = join(webDir, 'test-results', 'update-version-b');
const BUILD_B = 'e2e-version-b';
const url = `http://localhost:${String(UPDATE_WEB_PORT)}/`;

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', resolve);
  });
}

async function buildVersionB(): Promise<void> {
  const build = spawn(process.execPath, [vite, 'build', '--outDir', versionB, '--emptyOutDir'], {
    cwd: webDir,
    env: { ...process.env, VITE_BUILD_ID: BUILD_B },
    stdio: 'ignore',
  });
  expect(await exited(build)).toBe(0);
}

/** `vite preview` of one build; resolves once it answers. */
async function serve(outDir: string): Promise<() => Promise<void>> {
  const server = spawn(
    process.execPath,
    [vite, 'preview', '--outDir', outDir, '--port', String(UPDATE_WEB_PORT), '--strictPort'],
    { cwd: webDir, env: { ...process.env, API_URL }, stdio: 'ignore' },
  );
  await expect
    .poll(
      () =>
        fetch(url).then(
          (response) => response.ok,
          () => false,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  return async () => {
    server.kill('SIGTERM');
    await exited(server);
  };
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await buildVersionB();
});

test('offers a new version after a deploy and reloads into it when asked', async ({ page }) => {
  await page.clock.install();
  let stop = await serve(versionA);
  try {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
    // The first visit installs offline support; the next load runs under it.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    const html = page.locator('html');
    const buildA = await html.getAttribute('data-build');
    expect(buildA).not.toBe(BUILD_B);

    // Deploy B while the tab stays open. Nothing changes until the hourly check finds it.
    await stop();
    stop = await serve(versionB);
    const banner = page.getByRole('region', { name: 'App updates' });
    await page.clock.fastForward('01:00:00');
    await expect(banner.getByText('A new version of the app is available.')).toBeVisible();
    await expect(html).toHaveAttribute('data-build', String(buildA));

    await banner.getByRole('button', { name: 'Reload' }).click();
    await expect(html).toHaveAttribute('data-build', BUILD_B);
    await expect(page.getByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
    await expect(banner).toBeEmpty();
  } finally {
    await stop();
  }
});
