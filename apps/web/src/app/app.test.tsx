import { renderHook, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { SESSION_KEY } from '../auth/session-store.js';
import { registerServiceWorker } from '../pwa/register-sw.js';
import { GRANT, fakeFetch, json } from '../test-support/fake-api.js';
import { createServices, shouldRetry, useApi, useServices } from './services.js';
import { apiBaseUrl, start } from './start.js';

describe('shouldRetry', () => {
  it('retries network and server problems twice, never client errors', () => {
    expect(shouldRetry(0, new ApiError(0, 'offline'))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, 'down'))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, 'down'))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, 'missing'))).toBe(false);
    expect(shouldRetry(0, new Error('bug'))).toBe(true);
  });
});

describe('createServices', () => {
  it('ends the session when the API says it is no longer valid', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(GRANT));
    const api = fakeFetch({ 'GET /auth/me': () => json({ message: 'Unauthorized' }, 401) });
    const services = createServices({
      fetch: api.fetch,
      storage: localStorage,
      apiBaseUrl: '/api',
    });
    await expect(services.api.auth.me()).rejects.toMatchObject({ status: 401 });
    expect(api.requests[0]?.headers.authorization).toBe('Bearer session-token');
    expect(services.sessions.getState()).toEqual({ session: null, ended: 'expired' });
    expect(services.branding.cached().appName).toBe('Paint Retail');
    expect(services.queryClient.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('refuses useServices outside the provider', () => {
    expect(() => renderHook(() => useApi())).toThrow(
      'useServices must be used inside <ServicesProvider>',
    );
    expect(() => renderHook(() => useServices())).toThrow(Error);
  });
});

describe('start', () => {
  it('reaches the API at /api unless configured', () => {
    expect(apiBaseUrl({ PROD: true })).toBe('/api');
    expect(apiBaseUrl({ PROD: true, VITE_API_BASE_URL: 'https://api.example.in' })).toBe(
      'https://api.example.in',
    );
  });

  it('applies the theme before rendering, then shows sign-in', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = start({ container, env: { PROD: false } });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to Paint Retail' }),
    ).toBeInTheDocument();
    act(() => {
      root.unmount();
    });
  });

  it('registers the service worker in production builds', async () => {
    const register = vi.fn(() => Promise.resolve({}));
    const win = {
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      localStorage,
      sessionStorage,
      location: window.location,
      history: window.history,
      matchMedia: (query: string) => window.matchMedia(query),
      document,
      navigator: { serviceWorker: { register } },
    } as unknown as Window;
    const container = document.createElement('div');
    const root = start({ container, env: { PROD: true }, win });
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    await waitFor(() => {
      expect(container.textContent).not.toBe('');
    });
    act(() => {
      root.unmount();
    });
  });
});

describe('registerServiceWorker', () => {
  it('does nothing where service workers are unsupported', () => {
    expect(() => {
      registerServiceWorker({} as Navigator);
    }).not.toThrow();
  });

  it('warns, without failing, when registration fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new Error('insecure');
    registerServiceWorker({
      serviceWorker: { register: () => Promise.reject(failure) },
    } as unknown as Navigator);
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith('Offline support is not available:', failure);
    });
    warn.mockRestore();
  });
});
