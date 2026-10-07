import { vi } from 'vitest';

/** A service worker going through its states, recording what the page posts to it. */
export class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];

  constructor(public state: ServiceWorkerState = 'installing') {
    super();
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  moveTo(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

export interface FakeServiceWorkersOptions {
  /** The page is already controlled by a worker (false on the very first visit). */
  readonly controlled?: boolean;
  /** A new version that already waits when the page opens. */
  readonly waiting?: FakeWorker;
}

/** navigator.serviceWorker and its registration, driven by the test. */
export function fakeServiceWorkers({ controlled = true, waiting }: FakeServiceWorkersOptions = {}) {
  const registration = Object.assign(new EventTarget(), {
    waiting: waiting ?? null,
    installing: null as FakeWorker | null,
    update: vi.fn(() => Promise.resolve()),
  });
  const container = Object.assign(new EventTarget(), {
    controller: controlled ? new FakeWorker('activated') : null,
    register: vi.fn(() => Promise.resolve(registration)),
  });
  return {
    registration,
    container,
    navigator: { serviceWorker: container } as unknown as Navigator,
    /** The browser found a new sw.js and starts installing it. */
    found: (worker: FakeWorker | null): void => {
      registration.installing = worker;
      registration.dispatchEvent(new Event('updatefound'));
    },
    /** The installing worker finished: like a browser, it becomes the waiting one first. */
    installed: (worker: FakeWorker): void => {
      registration.installing = null;
      registration.waiting = worker;
      worker.moveTo('installed');
    },
    /** The waiting worker took over (after SKIP_WAITING, in this or another tab). */
    takeOver: (): void => {
      registration.waiting = null;
      container.dispatchEvent(new Event('controllerchange'));
    },
  };
}

/** A window for the update controller: events, a reload spy and a captured hourly timer. */
export function fakeUpdateWindow(navigator: Navigator) {
  const events = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  const timers: { handler: () => void; timeout: number }[] = [];
  const reload = vi.fn();
  const win = {
    navigator,
    location: { reload } as unknown as Location,
    document: document as unknown as Document,
    addEventListener: events.addEventListener.bind(events),
    setInterval: (handler: () => void, timeout: number) => {
      timers.push({ handler, timeout });
      return timers.length;
    },
  };
  return {
    win,
    reload,
    timers,
    focus: () => events.dispatchEvent(new Event('focus')),
    show: (state: DocumentVisibilityState) => {
      document.visibilityState = state;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}
