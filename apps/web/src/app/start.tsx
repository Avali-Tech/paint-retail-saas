import { deriveTheme } from '@paint/shared';
import { applyTheme, resolveScheme } from '@paint/ui';
import { createRoot, type Root } from 'react-dom/client';
import { registerServiceWorker } from '../pwa/register-sw.js';
import { App } from './App.js';
import { createServices } from './services.js';

export interface StartOptions {
  readonly container: HTMLElement;
  readonly env: { readonly VITE_API_BASE_URL?: string; readonly PROD: boolean };
  readonly win?: Window;
}

/** "/api" unless the deployment says otherwise (the API answers there through a proxy). */
export function apiBaseUrl(env: StartOptions['env']): string {
  return env.VITE_API_BASE_URL ?? '/api';
}

/** Boots the app: theme first (no unbranded flash), then React, then offline support. */
export function start({ container, env, win = window }: StartOptions): Root {
  const services = createServices({
    fetch: win.fetch.bind(win),
    storage: win.localStorage,
    apiBaseUrl: apiBaseUrl(env),
  });
  const branding = services.branding.cached();
  const prefersDark = win.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(deriveTheme(branding), resolveScheme(branding.mode, prefersDark), win.document);

  const root = createRoot(container);
  root.render(<App services={services} />);
  if (env.PROD) registerServiceWorker(win.navigator);
  return root;
}
