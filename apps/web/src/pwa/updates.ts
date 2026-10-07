/**
 * The service worker that vite-plugin-pwa generates at build time (dist/sw.js) caches the
 * app shell so the app opens instantly and offline, and makes it installable. API calls
 * always go to the network.
 *
 * After a deploy the new worker installs in the background and then waits: it takes over
 * only when the person chooses "Reload" (never in the middle of a form). This module finds
 * that waiting worker, checks for a new one every hour and when the tab is looked at again,
 * and activates it on request.
 */

/** How often an open tab asks for a new version. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Focus and tab switches ask at most this often. */
export const FOCUS_CHECK_GAP_MS = 60 * 1000;
/** The message the generated worker answers by activating itself (Workbox's "prompt" mode). */
export const SKIP_WAITING = { type: 'SKIP_WAITING' } as const;

export interface UpdateController {
  /** True once a new version has installed and waits to take over. */
  readonly isAvailable: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  /** Registers the worker and starts watching for new versions (production builds only). */
  readonly register: () => Promise<void>;
  /** Asks the server for a new worker now. */
  readonly check: () => Promise<void>;
  /** Activates the waiting version and reloads this tab once it controls the page. */
  readonly apply: () => void;
}

type UpdateWindow = Pick<Window, 'navigator' | 'location' | 'document' | 'addEventListener'> & {
  readonly setInterval: (handler: () => void, timeout: number) => unknown;
};

export interface UpdateOptions {
  readonly url?: string;
  readonly now?: () => number;
}

export function createUpdateController(
  win: UpdateWindow,
  { url = '/sw.js', now = Date.now }: UpdateOptions = {},
): UpdateController {
  const listeners = new Set<() => void>();
  let available = false;
  let registration: ServiceWorkerRegistration | undefined;
  let reloadRequested = false;
  let lastFocusCheck = Number.NEGATIVE_INFINITY;

  const announce = () => {
    if (available) return;
    available = true;
    for (const listener of listeners) listener();
  };

  const check = async () => {
    try {
      await registration?.update();
    } catch {
      // Offline or the server is busy: the next check tries again.
    }
  };

  const register = async () => {
    if (!('serviceWorker' in win.navigator)) return;
    const container = win.navigator.serviceWorker;
    try {
      registration = await container.register(url, { scope: '/' });
    } catch (error: unknown) {
      console.warn('Offline support is not available:', error);
      return;
    }
    const current = registration;
    // With no controller this is the first install, not an update.
    const isUpdate = (worker: ServiceWorker) =>
      worker.state === 'installed' && container.controller !== null;

    if (current.waiting && container.controller !== null) announce();
    current.addEventListener('updatefound', () => {
      const worker = current.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (isUpdate(worker)) announce();
      });
    });
    // Every open tab sees the new worker take over; only the one that asked reloads, so
    // nobody else loses what they were typing (their banner stays until they choose).
    container.addEventListener('controllerchange', () => {
      if (reloadRequested) win.location.reload();
    });

    win.setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onLookedAt = () => {
      if (win.document.visibilityState !== 'visible') return;
      const time = now();
      if (time - lastFocusCheck < FOCUS_CHECK_GAP_MS) return;
      lastFocusCheck = time;
      void check();
    };
    win.addEventListener('focus', onLookedAt);
    win.document.addEventListener('visibilitychange', onLookedAt);
  };

  const apply = () => {
    reloadRequested = true;
    const waiting = registration?.waiting;
    // Another tab may have activated it already: then a plain reload loads the new version.
    if (waiting) waiting.postMessage(SKIP_WAITING);
    else win.location.reload();
  };

  return {
    isAvailable: () => available,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register,
    check,
    apply,
  };
}
