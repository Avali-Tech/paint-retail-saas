import { describe, expect, it, vi } from 'vitest';
import {
  FakeWorker,
  fakeServiceWorkers,
  fakeUpdateWindow,
} from '../test-support/fake-service-worker.js';
import {
  CHECK_INTERVAL_MS,
  FOCUS_CHECK_GAP_MS,
  SKIP_WAITING,
  createUpdateController,
} from './updates.js';

function setUp(options: Parameters<typeof fakeServiceWorkers>[0] = {}, now = () => 0) {
  const workers = fakeServiceWorkers(options);
  const page = fakeUpdateWindow(workers.navigator);
  const updates = createUpdateController(page.win, { now });
  const listener = vi.fn();
  updates.subscribe(listener);
  return { ...workers, ...page, updates, listener };
}

describe('createUpdateController', () => {
  it('registers /sw.js for the whole app and starts with nothing to offer', async () => {
    const { updates, container, listener } = setUp();
    await updates.register();
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(updates.isAvailable()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does nothing where service workers are unsupported', async () => {
    const page = fakeUpdateWindow({} as Navigator);
    const updates = createUpdateController(page.win);
    await updates.register();
    await updates.check();
    expect(updates.isAvailable()).toBe(false);
    expect(page.timers).toEqual([]);
  });

  it('warns, without failing, when registration fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { updates, container, timers } = setUp();
    const failure = new Error('insecure');
    container.register.mockRejectedValueOnce(failure);
    await updates.register();
    expect(warn).toHaveBeenCalledWith('Offline support is not available:', failure);
    expect(timers).toEqual([]);
    warn.mockRestore();
  });

  it('offers a version that is already waiting when the page opens', async () => {
    const { updates, listener } = setUp({ waiting: new FakeWorker('installed') });
    await updates.register();
    expect(updates.isAvailable()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not offer a waiting worker on a page no worker controls', async () => {
    const { updates } = setUp({ controlled: false, waiting: new FakeWorker('installed') });
    await updates.register();
    expect(updates.isAvailable()).toBe(false);
  });

  it('offers a new version once it has installed, telling listeners once', async () => {
    const { updates, listener, found, installed } = setUp();
    await updates.register();
    const worker = new FakeWorker();
    found(worker);
    expect(updates.isAvailable()).toBe(false);
    installed(worker);
    expect(updates.isAvailable()).toBe(true);
    // A second worker installing later changes nothing for the banner.
    const next = new FakeWorker();
    found(next);
    installed(next);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('treats the first install as offline support, not an update', async () => {
    const { updates, found, installed } = setUp({ controlled: false });
    await updates.register();
    const worker = new FakeWorker();
    found(worker);
    installed(worker);
    expect(updates.isAvailable()).toBe(false);
  });

  it('ignores an update event without an installing worker', async () => {
    const { updates, found } = setUp();
    await updates.register();
    found(null);
    expect(updates.isAvailable()).toBe(false);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const workers = fakeServiceWorkers({ waiting: new FakeWorker('installed') });
    const updates = createUpdateController(fakeUpdateWindow(workers.navigator).win);
    const listener = vi.fn();
    const unsubscribe = updates.subscribe(listener);
    unsubscribe();
    await updates.register();
    expect(listener).not.toHaveBeenCalled();
  });

  it('checks for a new version every hour', async () => {
    const { updates, timers, registration } = setUp();
    await updates.register();
    expect(timers.map((timer) => timer.timeout)).toEqual([CHECK_INTERVAL_MS]);
    timers[0]?.handler();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it('checks when the tab is looked at again, at most once a minute', async () => {
    let time = 1_000_000;
    const { updates, registration, focus, show } = setUp({}, () => time);
    await updates.register();
    focus();
    expect(registration.update).toHaveBeenCalledTimes(1);
    time += FOCUS_CHECK_GAP_MS - 1;
    show('visible');
    expect(registration.update).toHaveBeenCalledTimes(1);
    time += 1;
    show('hidden');
    expect(registration.update).toHaveBeenCalledTimes(1);
    show('visible');
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it('keeps working when a check fails (offline)', async () => {
    const { updates, registration } = setUp();
    await updates.register();
    registration.update.mockRejectedValueOnce(new Error('offline'));
    await expect(updates.check()).resolves.toBeUndefined();
  });

  it('activates the waiting version on request and reloads once it has taken over', async () => {
    const waiting = new FakeWorker('installed');
    const { updates, reload, takeOver } = setUp({ waiting });
    await updates.register();
    updates.apply();
    expect(waiting.messages).toEqual([SKIP_WAITING]);
    expect(reload).not.toHaveBeenCalled();
    takeOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads a tab whose person did not ask (another tab chose Reload)', async () => {
    const { updates, reload, takeOver } = setUp({ waiting: new FakeWorker('installed') });
    await updates.register();
    takeOver();
    expect(reload).not.toHaveBeenCalled();
    // Its banner still offers the new version; choosing it now just reloads.
    expect(updates.isAvailable()).toBe(true);
    updates.apply();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
