import { deriveTheme } from '@paint/shared';
import { applyTheme, resolveScheme } from '@paint/ui';
import { createRoot, type Root } from 'react-dom/client';
import { createUpdateController } from '../pwa/updates.js';
import { sessionStorageFor } from '../support-access/support-tab.js';
import { App } from './App.js';
import { createServices } from './services.js';

export interface StartOptions {
  readonly container: HTMLElement;
  readonly env: {
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_BUILD_ID?: string;
    readonly PROD: boolean;
  };
  readonly win?: Window;
}

/** "/api" unless the deployment says otherwise (the API answers there through a proxy). */
export function apiBaseUrl(env: StartOptions['env']): string {
  return env.VITE_API_BASE_URL ?? '/api';
}

/** Boots the app: theme first (no unbranded flash), then React, then offline support. */
export function start({ container, env, win = window }: StartOptions): Root {
  // Which build this tab runs (the deploy sets it), for support and the update tests.
  win.document.documentElement.dataset.build = env.VITE_BUILD_ID ?? 'dev';
  const services = createServices({
    fetch: win.fetch.bind(win),
    // A support view (opened from the platform console) keeps its session to its own tab.
    storage: sessionStorageFor(win),
    apiBaseUrl: apiBaseUrl(env),
  });
  const branding = services.branding.cached();
  const prefersDark = win.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(deriveTheme(branding), resolveScheme(branding.mode, prefersDark), win.document);

  // Production builds only: the dev server has no service worker.
  const updates = env.PROD ? createUpdateController(win) : undefined;
  const root = createRoot(container);
  root.render(<App services={services} updates={updates} />);
  void updates?.register();
  return root;
}
