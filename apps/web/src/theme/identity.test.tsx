import { DEFAULT_BRANDING } from '@paint/shared';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../api/client.js';
import type { OrganizationIdentity, PublicBranding } from '../api/types.js';
import { fakeFetch, json, type FakeHandler } from '../test-support/fake-api.js';
import { BrandMark } from './BrandMark.js';
import {
  IDENTITY_KEY,
  apiIdentitySource,
  readIdentity,
  type IdentitySource,
} from './identity-source.js';
import { IdentityProvider, showBrandIcon, useIdentity } from './IdentityProvider.js';
import { found } from '../test-support/found.js';
import { SIGN_IN_BUSINESS_KEY, apiSignInBusinessSource, readPage } from './sign-in-business.js';

const LOGO = {
  url: '/public/branding/sharma-paints/logo/0123456789abcdef',
  contentType: 'image/png',
  width: 120,
  height: 40,
  sizeBytes: 812,
  updatedAt: '2026-10-07T06:00:00.000Z',
};
const WITH_LOGO: OrganizationIdentity = { slug: 'sharma-paints', logo: LOGO };
const PAGE: PublicBranding = {
  slug: 'sharma-paints',
  branding: { ...DEFAULT_BRANDING, appName: 'Sharma Paints', primary: '#8c1d40' },
  logoUrl: LOGO.url,
};

function client(routes: Record<string, FakeHandler>) {
  const api = fakeFetch(routes);
  return {
    api: createApiClient({
      baseUrl: '/api',
      fetch: api.fetch,
      getToken: () => 'tok',
      onUnauthorized: () => undefined,
    }),
    requests: api.requests,
  };
}

function sources(routes: Record<string, FakeHandler> = {}) {
  const { api, requests } = client(routes);
  const signInBusiness = apiSignInBusinessSource(api, localStorage);
  return {
    signInBusiness,
    identity: apiIdentitySource(api, localStorage, '/api', signInBusiness),
    requests,
  };
}

describe('reading answers', () => {
  it('accepts only identities and pages it can use', () => {
    expect(readIdentity(WITH_LOGO)).toEqual(WITH_LOGO);
    expect(readIdentity({ slug: 'a-b', logo: { url: 7 } })).toEqual({ slug: 'a-b', logo: null });
    expect(readIdentity({ slug: 'a-b', logo: 'x' })).toEqual({ slug: 'a-b', logo: null });
    expect(readIdentity({ logo: LOGO })).toBeNull();
    expect(readIdentity(null)).toBeNull();
    expect(readPage(PAGE)).toEqual(PAGE);
    expect(readPage({ ...PAGE, logoUrl: 5 })).toEqual({ ...PAGE, logoUrl: null });
    expect(readPage({ ...PAGE, branding: { primary: 'red' } })).toBeNull();
    expect(readPage({ branding: PAGE.branding })).toBeNull();
    expect(readPage('x')).toBeNull();
  });
});

describe('apiIdentitySource', () => {
  it('loads, saves the slug, uploads and removes the logo, keeping each answer on the device', async () => {
    const { identity, signInBusiness, requests } = sources({
      'GET /organization/identity': () => json({ slug: 'sharma-paints', logo: null }),
      'PUT /organization/slug': (request) =>
        json({ slug: (request.body as { slug: string }).slug, logo: null }),
      'POST /organization/logo': () => json({ ...WITH_LOGO, slug: 'sharma-hyd' }, 201),
      'DELETE /organization/logo': () => json({ slug: 'sharma-hyd', logo: null }),
    });
    expect(identity.cached()).toBeNull();

    await expect(identity.load()).resolves.toEqual({ slug: 'sharma-paints', logo: null });
    expect(identity.cached()).toEqual({ slug: 'sharma-paints', logo: null });
    // The business signed in to is the one the plain sign-in page shows next time.
    expect(signInBusiness.remembered()).toEqual({ slug: 'sharma-paints', page: null });

    await expect(identity.saveSlug('sharma-hyd')).resolves.toEqual({
      slug: 'sharma-hyd',
      logo: null,
    });
    const file = new File(['png'], 'logo.png', { type: 'image/png' });
    await expect(identity.uploadLogo(file)).resolves.toEqual({ ...WITH_LOGO, slug: 'sharma-hyd' });
    expect(identity.cached()?.logo).toEqual(LOGO);
    await expect(identity.removeLogo()).resolves.toEqual({ slug: 'sharma-hyd', logo: null });

    const upload = requests.find((request) => request.method === 'POST');
    expect((upload?.body as FormData).get('file')).toBeInstanceOf(File);
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
      slug: 'sharma-hyd',
    });
    expect(identity.assetUrl(LOGO.url)).toBe(`/api${LOGO.url}`);
  });

  it('refuses answers it cannot read, and ignores a damaged copy on the device', async () => {
    const { identity } = sources({ 'GET /organization/identity': () => json({ nope: true }) });
    await expect(identity.load()).rejects.toThrow(
      'The server sent an identity the app cannot read',
    );
    localStorage.setItem(IDENTITY_KEY, '{broken');
    expect(identity.cached()).toBeNull();
  });
});

describe('apiSignInBusinessSource', () => {
  it('looks a business up by its link name, remembering it with its page', async () => {
    const { signInBusiness, requests } = sources({
      'GET /public/branding/:slug': () => json(PAGE),
    });

    await expect(signInBusiness.lookup(' Sharma-Paints ')).resolves.toEqual(PAGE);

    expect(requests.at(-1)?.path).toBe('/public/branding/sharma-paints');
    expect(signInBusiness.remembered()).toEqual({ slug: 'sharma-paints', page: PAGE });
    // Remembering the same business keeps its page; another starts without one.
    signInBusiness.remember('sharma-paints');
    expect(signInBusiness.remembered()?.page).toEqual(PAGE);
    signInBusiness.remember('xyz-paints');
    expect(signInBusiness.remembered()).toEqual({ slug: 'xyz-paints', page: null });
  });

  it('forgets a remembered business no longer found, and answers null for unknown links', async () => {
    const { signInBusiness } = sources({});
    signInBusiness.remember('closed-paints');

    await expect(signInBusiness.lookup('other-paints')).resolves.toBeNull();
    expect(signInBusiness.remembered()?.slug).toBe('closed-paints');
    await expect(signInBusiness.lookup('closed-paints')).resolves.toBeNull();
    expect(signInBusiness.remembered()).toBeNull();
  });

  it('passes on other failures, and remembers nothing from an unreadable answer', async () => {
    const { signInBusiness: down } = sources({
      'GET /public/branding/:slug': () => json({ message: 'Down' }, 503),
    });
    await expect(down.lookup('sharma-paints')).rejects.toThrow('Down');
    const { signInBusiness: odd } = sources({ 'GET /public/branding/:slug': () => json({}) });
    await expect(odd.lookup('sharma-paints')).resolves.toBeNull();
    expect(odd.remembered()).toBeNull();
    for (const damaged of ['{oops', JSON.stringify({ page: PAGE }), 'null']) {
      localStorage.setItem(SIGN_IN_BUSINESS_KEY, damaged);
      expect(odd.remembered(), damaged).toBeNull();
    }
  });
});

function Probe() {
  const { identity, logoSrc, setIdentity, previewLogo } = useIdentity();
  return (
    <>
      <p>
        {identity?.slug ?? 'none'} / {logoSrc ?? 'no logo'}
      </p>
      <button
        onClick={() => {
          setIdentity({ slug: 'renamed', logo: null });
        }}
      >
        rename
      </button>
      <button
        onClick={() => {
          previewLogo('/other/logo');
        }}
      >
        preview
      </button>
      <button
        onClick={() => {
          previewLogo(undefined);
        }}
      >
        end preview
      </button>
    </>
  );
}

const memorySource = (
  cached: OrganizationIdentity | null,
  load: () => Promise<OrganizationIdentity>,
): IdentitySource => ({
  cached: () => cached,
  load,
  saveSlug: load,
  uploadLogo: load,
  removeLogo: load,
  assetUrl: (path) => `/api${path}`,
});

const icons = () =>
  [...document.head.querySelectorAll<HTMLLinkElement>('link[data-brand-icon]')].map((link) => [
    link.rel,
    link.getAttribute('href'),
  ]);

describe('IdentityProvider', () => {
  it('shows the cached logo at once, as the browser icon too, and loads the business’s own on sign-in', async () => {
    let resolve: (identity: OrganizationIdentity) => void = () => undefined;
    const loaded = new Promise<OrganizationIdentity>((done) => {
      resolve = done;
    });
    const source = memorySource(WITH_LOGO, () => loaded);
    const { rerender } = render(
      <IdentityProvider source={source} sessionKey={null}>
        <Probe />
      </IdentityProvider>,
    );
    expect(screen.getByText(`sharma-paints / /api${LOGO.url}`)).toBeInTheDocument();
    // The browser icons are set in an effect after each render; wait for them.
    await waitFor(() => {
      expect(icons()).toEqual([
        ['icon', `/api${LOGO.url}`],
        ['apple-touch-icon', `/api${LOGO.url}`],
      ]);
    });

    rerender(
      <IdentityProvider source={source} sessionKey="token">
        <Probe />
      </IdentityProvider>,
    );
    resolve({ slug: 'xyz-paints', logo: null });
    expect(await screen.findByText('xyz-paints / no logo')).toBeInTheDocument();
    await waitFor(() => {
      expect(icons()).toEqual([]);
    });
  });

  it('keeps the cached identity when loading fails, and lets a page preview another logo', async () => {
    const user = userEvent.setup();
    render(
      <IdentityProvider
        source={memorySource(null, () => Promise.reject(new Error('down')))}
        sessionKey="t"
      >
        <Probe />
      </IdentityProvider>,
    );
    expect(screen.getByText('none / no logo')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'preview' }));
    expect(screen.getByText('none / /api/other/logo')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'end preview' }));
    await user.click(screen.getByRole('button', { name: 'rename' }));
    expect(screen.getByText('renamed / no logo')).toBeInTheDocument();
  });

  it('stops listening for a load once the session changes again', async () => {
    let resolve: (identity: OrganizationIdentity) => void = () => undefined;
    const source = memorySource(null, () => new Promise((done) => (resolve = done)));
    const { unmount } = render(
      <IdentityProvider source={source} sessionKey="t">
        <Probe />
      </IdentityProvider>,
    );
    unmount();
    resolve(WITH_LOGO);
    await waitFor(() => {
      expect(screen.queryByText(/sharma-paints/)).toBeNull();
    });
  });

  it('is required by useIdentity', () => {
    expect(() => renderHook(() => useIdentity())).toThrow(
      'useIdentity must be used inside <IdentityProvider>',
    );
  });

  it('replaces its own icons and leaves the page’s others alone', () => {
    showBrandIcon(document, '/a.png');
    showBrandIcon(document, '/b.png');
    expect(icons()).toEqual([
      ['icon', '/b.png'],
      ['apple-touch-icon', '/b.png'],
    ]);
    showBrandIcon(document, null);
    expect(icons()).toEqual([]);
  });
});

describe('BrandMark', () => {
  it('shows the logo, or the first letter of the app name without one or when it fails to load', () => {
    const { container, rerender } = render(
      <BrandMark appName="Sharma Paints" logoSrc="/logo.png" />,
    );
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', '/logo.png');
    expect(image).toHaveAttribute('alt', '');
    fireEvent.error(found(image));
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('S');
    // A new logo is tried again.
    rerender(<BrandMark appName="Sharma Paints" logoSrc="/new.png" size="lg" />);
    expect(container.querySelector('.brand-logo--lg img')).toHaveAttribute('src', '/new.png');
    rerender(<BrandMark appName="Ravi Colours" logoSrc={null} />);
    expect(container.querySelector('.brand-mark')).toHaveTextContent('R');
  });
});
