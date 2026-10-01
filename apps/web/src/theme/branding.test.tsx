import { DEFAULT_BRANDING, type Branding } from '@paint/shared';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../api/client.js';
import { fakeFetch, json } from '../test-support/fake-api.js';
import {
  BRANDING_KEY,
  apiBrandingSource,
  localBrandingSource,
  type BrandingSource,
} from './branding-source.js';
import { BrandingProvider, useBranding } from './BrandingProvider.js';

const GREEN: Branding = { ...DEFAULT_BRANDING, appName: 'Sri Balaji Paints', primary: '#15803d' };

describe('localBrandingSource', () => {
  it('uses the default until a business saves its own', async () => {
    const source = localBrandingSource(localStorage);
    expect(source.cached()).toEqual(DEFAULT_BRANDING);
    await expect(source.save(GREEN)).resolves.toEqual(GREEN);
    expect(source.cached()).toEqual(GREEN);
    await expect(source.load()).resolves.toEqual(GREEN);
    await expect(source.reset()).resolves.toEqual(DEFAULT_BRANDING);
    expect(localStorage.getItem(BRANDING_KEY)).toBeNull();
  });

  it('ignores damaged or invalid saved branding', () => {
    localStorage.setItem(BRANDING_KEY, '{oops');
    expect(localBrandingSource(localStorage).cached()).toEqual(DEFAULT_BRANDING);
    localStorage.setItem(BRANDING_KEY, JSON.stringify({ ...GREEN, primary: 'green' }));
    expect(localBrandingSource(localStorage).cached()).toEqual(DEFAULT_BRANDING);
  });
});

describe('apiBrandingSource', () => {
  const source = (routes: Parameters<typeof fakeFetch>[0]) => {
    const api = fakeFetch(routes);
    const client = createApiClient({
      baseUrl: '/api',
      fetch: api.fetch,
      getToken: () => 'tok',
      onUnauthorized: () => undefined,
    });
    return { source: apiBrandingSource(client, localStorage), requests: api.requests };
  };

  it('loads the business branding from the server and caches it', async () => {
    const { source: remote } = source({
      'GET /organization/branding': () => json({ branding: GREEN }),
    });
    await expect(remote.load()).resolves.toEqual(GREEN);
    expect(remote.cached()).toEqual(GREEN);
  });

  it('uses the default when none is set, or the server sends something invalid', async () => {
    const { source: unset } = source({});
    await expect(unset.load()).resolves.toEqual(DEFAULT_BRANDING);
    const { source: broken } = source({
      'GET /organization/branding': () => json({ branding: { primary: 'nope' } }),
    });
    await expect(broken.load()).resolves.toEqual(DEFAULT_BRANDING);
  });

  it('passes on other failures', async () => {
    const { source: failing } = source({
      'GET /organization/branding': () => json({ message: 'Database down' }, 503),
    });
    await expect(failing.load()).rejects.toThrow('Database down');
  });

  it('saves and resets with PUT', async () => {
    const { source: remote, requests } = source({
      'PUT /organization/branding': (request) => json({ branding: request.body, adjustments: [] }),
    });
    await expect(remote.save(GREEN)).resolves.toEqual(GREEN);
    await expect(remote.reset()).resolves.toEqual(DEFAULT_BRANDING);
    expect(requests.map((request) => request.body)).toEqual([GREEN, DEFAULT_BRANDING]);
  });
});

function Probe() {
  const { branding, saved, preview, save, reset } = useBranding();
  return (
    <>
      <p>
        {branding.appName} / {saved.appName}
      </p>
      <button
        onClick={() => {
          preview({ ...saved, appName: 'Preview' });
        }}
      >
        preview
      </button>
      <button
        onClick={() => {
          void save(GREEN);
        }}
      >
        save
      </button>
      <button
        onClick={() => {
          void reset();
        }}
      >
        reset
      </button>
    </>
  );
}

const memorySource = (initial: Branding, loaded: Promise<Branding>): BrandingSource => {
  let current = initial;
  return {
    cached: () => initial,
    load: () => loaded,
    save: (branding) => {
      current = branding;
      return Promise.resolve(current);
    },
    reset: () => Promise.resolve(DEFAULT_BRANDING),
  };
};

describe('BrandingProvider', () => {
  it('paints the cached branding first, then what loads', async () => {
    render(
      <BrandingProvider source={memorySource(DEFAULT_BRANDING, Promise.resolve(GREEN))}>
        <Probe />
      </BrandingProvider>,
    );
    expect(await screen.findByText('Sri Balaji Paints / Sri Balaji Paints')).toBeInTheDocument();
    expect(document.title).toBe('Sri Balaji Paints');
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#15803d');
  });

  it('keeps the cached branding when loading fails', async () => {
    render(
      <BrandingProvider source={memorySource(GREEN, Promise.reject(new Error('offline')))}>
        <Probe />
      </BrandingProvider>,
    );
    await act(() => Promise.resolve());
    expect(screen.getByText('Sri Balaji Paints / Sri Balaji Paints')).toBeInTheDocument();
  });

  it('ignores a load that finishes after it is gone', async () => {
    let finish: (branding: Branding) => void = () => undefined;
    const late = new Promise<Branding>((resolve) => {
      finish = resolve;
    });
    const { unmount } = render(
      <BrandingProvider source={memorySource(DEFAULT_BRANDING, late)}>
        <Probe />
      </BrandingProvider>,
    );
    unmount();
    finish(GREEN);
    await act(() => late);
    expect(document.title).toBe('Paint Retail');
  });

  it('previews without saving, then saves or resets', async () => {
    const user = userEvent.setup();
    render(
      <BrandingProvider source={memorySource(DEFAULT_BRANDING, new Promise(() => undefined))}>
        <Probe />
      </BrandingProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'preview' }));
    expect(screen.getByText('Preview / Paint Retail')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => {
      expect(screen.getByText('Sri Balaji Paints / Sri Balaji Paints')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'reset' }));
    await waitFor(() => {
      expect(screen.getByText('Paint Retail / Paint Retail')).toBeInTheDocument();
    });
  });

  it('refuses useBranding outside the provider', () => {
    expect(() => renderHook(() => useBranding())).toThrow(
      'useBranding must be used inside <BrandingProvider>',
    );
  });
});
