// Setup for component tests (the "web" Vitest project, jsdom).
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// findBy…/waitFor give slow machines (coverage, a busy CI runner) time before failing.
configure({ asyncUtilTimeout: 5000 });

// Component tests must never reach a real server: the API client gets a fake fetch.
beforeEach(() => {
  globalThis.fetch = () => Promise.reject(new Error('Component tests must not use the network'));
  localStorage.clear();
  // A light-mode device by default; theme tests swap in their own matchMedia.
  window.matchMedia = (media: string) =>
    ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
});

afterEach(() => {
  cleanup();
});

// Browser APIs jsdom does not implement, used by Radix popovers and our theme runtime.
class ResizeObserverStub {
  observe(): void {
    // Layout never changes in jsdom.
  }
  unobserve(): void {
    // Nothing observed.
  }
  disconnect(): void {
    // Nothing observed.
  }
}
globalThis.ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = function scrollIntoView() {
  // jsdom has no layout to scroll.
};
Element.prototype.hasPointerCapture = () => false;
