import { renderHook, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { SESSION_KEY } from '../auth/session-store.js';
import { GRANT, fakeFetch, json } from '../test-support/fake-api.js';
import { FakeWorker, fakeServiceWorkers } from '../test-support/fake-service-worker.js';
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

  it('marks the page with its build', () => {
    const container = document.createElement('div');
    const root = start({ container, env: { PROD: false, VITE_BUILD_ID: 'abc123' } });
    expect(document.documentElement.dataset.build).toBe('abc123');
    act(() => {
      root.unmount();
    });
  });

  it('registers the service worker in production builds and offers a waiting version', async () => {
    const workers = fakeServiceWorkers({ waiting: new FakeWorker('installed') });
    const win = {
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      localStorage,
      sessionStorage,
      location: window.location,
      history: window.history,
      matchMedia: (query: string) => window.matchMedia(query),
      document,
      navigator: workers.navigator,
      addEventListener: () => undefined,
      setInterval: () => 0,
    } as unknown as Window;
    const container = document.createElement('div');
    document.body.append(container);
    const root = start({ container, env: { PROD: true }, win });
    expect(document.documentElement.dataset.build).toBe('dev');
    expect(workers.container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(await screen.findByText('A new version of the app is available.')).toBeInTheDocument();
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
