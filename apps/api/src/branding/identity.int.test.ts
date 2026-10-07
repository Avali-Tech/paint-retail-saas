import { createHash } from 'node:crypto';
import { migrateDatabase, schema } from '@paint/db';
import { DEFAULT_BRANDING, type OrganizationIdentity, type PublicBranding } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuditPage } from '../audit/audit.service.js';
import { EICAR, PDF, multipartBody, testBucket } from '../test-support/files.js';
import { SCRIPTED_SVG, pngImage } from '../test-support/images.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { MAX_LOGO_BYTES } from './logo-checks.js';

let database: TestDatabase;
let t: TestApp;
/** Sharma Paints: owner and a counter employee. */
let owner: string;
let cashier: string;
/** Another business, to check nothing crosses over. */
let other: string;
let otherOrganizationId: string;

const LOGO = pngImage(120, 40);

const json = (token: string | null, method: 'GET' | 'PUT' | 'DELETE', url: string, body?: object) =>
  t.app.inject({
    method,
    url,
    headers: {
      ...(token === null ? {} : bearer(token)),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

function uploadLogo(
  token: string,
  files: { fileName: string; data: Buffer; contentType?: string }[],
  app: TestApp = t,
) {
  const { payload, headers } = multipartBody({}, files);
  return app.app.inject({
    method: 'POST',
    url: '/organization/logo',
    headers: { ...bearer(token), ...headers },
    payload,
  });
}

async function signup(name: string): Promise<{ token: string; organizationId: string }> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  return response.json<{ token: string; organizationId: string }>();
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  const env = await testBucket(
    inject('objectStorageEndpoint'),
    inject('virusScannerAddress'),
    'logo-test',
  );
  t = await startTestApp(database.connectionString, env);
  owner = (await signup('Sharma Paints')).token;
  const signedUp = await signup('XYZ Paints');
  other = signedUp.token;
  otherOrganizationId = signedUp.organizationId;
  const roles = (await json(owner, 'GET', '/roles')).json<{ id: string; key: string }[]>();
  const store = (
    await t.app.inject({
      method: 'POST',
      url: '/stores',
      headers: bearer(owner),
      payload: { name: 'Hyderabad', code: 'HYD' },
    })
  ).json<{ id: string }>().id;
  const phone = uniquePhone();
  await t.app.inject({
    method: 'POST',
    url: '/members',
    headers: bearer(owner),
    payload: {
      fullName: 'Counter Staff',
      phone,
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === 'store_employee')?.id,
      storeIds: [store],
    },
  });
  cashier = (
    await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Staff@2026' },
    })
  ).json<{ token: string }>().token;
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('the sign-in link name (slug)', () => {
  it('is given at sign-up from the business name, and every member can read it', async () => {
    const identity = await json(cashier, 'GET', '/organization/identity');

    expect(identity.statusCode).toBe(200);
    expect(identity.json<OrganizationIdentity>()).toEqual({ slug: 'sharma-paints', logo: null });
    expect((await json(null, 'GET', '/organization/identity')).statusCode).toBe(401);
  });

  it('numbers a second business with the same name instead of colliding', async () => {
    const twin = await signup('Sharma Paints');

    expect((await json(twin.token, 'GET', '/organization/identity')).json()).toEqual({
      slug: 'sharma-paints-2',
      logo: null,
    });
  });

  it('is changed only by members who manage the business', async () => {
    expect((await json(cashier, 'PUT', '/organization/slug', { slug: 'mine' })).statusCode).toBe(
      403,
    );
  });

  it('refuses names that are malformed or reserved, with a code for the app', async () => {
    const malformed = await json(owner, 'PUT', '/organization/slug', { slug: 'Sharma Paints!' });
    const short = await json(owner, 'PUT', '/organization/slug', { slug: 'sp' });
    const reserved = await json(owner, 'PUT', '/organization/slug', { slug: 'Platform' });
    const missing = await json(owner, 'PUT', '/organization/slug', {});

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      statusCode: 400,
      message: 'Use lower-case letters, digits and single hyphens, not at the start or end',
      code: 'format',
      issues: [
        {
          path: 'slug',
          message: 'Use lower-case letters, digits and single hyphens, not at the start or end',
        },
      ],
    });
    expect(short.json()).toMatchObject({ code: 'length' });
    expect(reserved.json()).toMatchObject({
      code: 'reserved',
      message: 'This name is reserved. Choose another.',
    });
    expect(missing.statusCode).toBe(400);
    for (const name of ['api', 'www', 'admin', 'sign-in']) {
      expect(
        (await json(owner, 'PUT', '/organization/slug', { slug: name })).json(),
        name,
      ).toMatchObject({
        code: 'reserved',
      });
    }
  });

  it("refuses another business's name, ignoring case, and keeps the business's own", async () => {
    const taken = await json(owner, 'PUT', '/organization/slug', { slug: 'XYZ-Paints' });

    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({
      statusCode: 409,
      message: 'Another business uses this sign-in link. Choose another.',
      code: 'taken',
      issues: [
        { path: 'slug', message: 'Another business uses this sign-in link. Choose another.' },
      ],
    });
    expect((await json(owner, 'GET', '/organization/identity')).json()).toMatchObject({
      slug: 'sharma-paints',
    });
  });

  it('saves a new name (normalised), audited, and the old link stops working', async () => {
    const saved = await json(owner, 'PUT', '/organization/slug', { slug: '  Sharma-Hyd ' });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ slug: 'sharma-hyd', logo: null });
    expect((await json(null, 'GET', '/public/branding/sharma-hyd')).statusCode).toBe(200);
    expect((await json(null, 'GET', '/public/branding/sharma-paints')).statusCode).toBe(404);
    const log = (await json(owner, 'GET', '/audit-log?table=organizations')).json<AuditPage>();
    expect(log.items[0]?.changes).toEqual([
      expect.objectContaining({
        field: 'slug',
        label: 'Sign-in link',
        old: 'sharma-paints',
        new: 'sharma-hyd',
      }),
    ]);
    // Saving the same name again changes nothing.
    expect(
      (await json(owner, 'PUT', '/organization/slug', { slug: 'sharma-hyd' })).statusCode,
    ).toBe(200);
  });
});

describe('the logo', () => {
  it('is uploaded only by members who manage the business', async () => {
    expect((await uploadLogo(cashier, [{ fileName: 'logo.png', data: LOGO }])).statusCode).toBe(
      403,
    );
    expect((await json(cashier, 'DELETE', '/organization/logo')).statusCode).toBe(403);
  });

  it('refuses requests without a readable file', async () => {
    const plain = await t.app.inject({
      method: 'POST',
      url: '/organization/logo',
      headers: { ...bearer(owner), 'content-type': 'application/json' },
      payload: '{}',
    });
    const noFile = await t.app.inject({
      method: 'POST',
      url: '/organization/logo',
      headers: { ...bearer(owner), ...multipartBody({ note: 'x' }, []).headers },
      payload: multipartBody({ note: 'x' }, []).payload,
    });
    const broken = await t.app.inject({
      method: 'POST',
      url: '/organization/logo',
      headers: { ...bearer(owner), 'content-type': 'multipart/form-data; boundary=xyz' },
      payload:
        '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\nunterminated',
    });

    expect(plain.json()).toMatchObject({
      statusCode: 400,
      message: 'Send the logo as multipart/form-data',
    });
    expect(noFile.json()).toMatchObject({ statusCode: 400, message: 'Attach the logo to upload' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json<{ message: string }>().message).toMatch(/^The upload could not be read: /);
  });

  it('refuses SVG (scripts), other kinds of file, empty files and wrong sizes, saying why', async () => {
    const svg = await uploadLogo(owner, [
      { fileName: 'logo.png', data: SCRIPTED_SVG, contentType: 'image/png' },
    ]);
    const pdf = await uploadLogo(owner, [{ fileName: 'logo.png', data: PDF }]);
    const script = await uploadLogo(owner, [
      { fileName: 'logo.png', data: Buffer.from('<html><script>alert(1)</script></html>') },
    ]);
    const empty = await uploadLogo(owner, [{ fileName: 'logo.png', data: Buffer.alloc(0) }]);
    const tiny = await uploadLogo(owner, [{ fileName: 'logo.png', data: pngImage(8, 8) }]);
    const huge = await uploadLogo(owner, [
      { fileName: 'logo.png', data: Buffer.concat([LOGO, Buffer.alloc(MAX_LOGO_BYTES)]) },
    ]);
    const virus = await uploadLogo(owner, [{ fileName: 'logo.png', data: EICAR }]);

    expect(svg.statusCode).toBe(415);
    expect(svg.json()).toEqual({
      statusCode: 415,
      code: 'svg_not_allowed',
      message:
        'SVG logos are not accepted because they can carry scripts. Save the logo as a PNG (with a transparent background), JPEG or WebP.',
    });
    expect(pdf.json()).toEqual({
      statusCode: 415,
      code: 'file_type',
      message: 'Upload the logo as a PNG, JPEG or WebP picture',
    });
    expect(script.json()).toMatchObject({ code: 'file_type' });
    expect(empty.json()).toEqual({
      statusCode: 400,
      code: 'empty_file',
      message: 'The file is empty',
    });
    expect(tiny.json()).toEqual({
      statusCode: 422,
      code: 'dimensions',
      message: 'Logos must be 16 to 2048 pixels wide and high',
    });
    expect(huge.json()).toEqual({
      statusCode: 413,
      code: 'too_large',
      message: 'Logos can be at most 1 MB',
    });
    // The EICAR test file is not a picture, so it never reaches storage either.
    expect(virus.json()).toMatchObject({ code: 'file_type' });
    expect((await json(owner, 'GET', '/organization/identity')).json()).toMatchObject({
      logo: null,
    });
  });

  it('is scanned like documents: nothing is saved while the virus scanner is down', async () => {
    const env = await testBucket(
      inject('objectStorageEndpoint'),
      inject('virusScannerAddress'),
      'logo-no-scanner',
    );
    const withoutScanner = await startTestApp(database.connectionString, {
      ...env,
      CLAMAV_PORT: '1',
    });
    const withoutStorage = await startTestApp(database.connectionString);
    try {
      const unscanned = await uploadLogo(
        owner,
        [{ fileName: 'logo.png', data: LOGO }],
        withoutScanner,
      );
      const unstored = await uploadLogo(
        owner,
        [{ fileName: 'logo.png', data: LOGO }],
        withoutStorage,
      );

      expect(unscanned.statusCode).toBe(503);
      expect(unscanned.json()).toMatchObject({ code: 'scanner_unavailable' });
      expect(unstored.json()).toMatchObject({ statusCode: 503, code: 'storage_unavailable' });
      expect((await json(owner, 'GET', '/organization/identity')).json()).toMatchObject({
        logo: null,
      });
    } finally {
      await withoutScanner.close();
      await withoutStorage.close();
    }
  });

  it('is saved, shown to every member and on the public sign-in page, and served with caching', async () => {
    const uploaded = await uploadLogo(owner, [{ fileName: 'Sharma logo.png', data: LOGO }]);

    expect(uploaded.statusCode).toBe(201);
    const sha256 = createHash('sha256').update(LOGO).digest('hex');
    const url = `/public/branding/sharma-hyd/logo/${sha256.slice(0, 16)}`;
    expect(uploaded.json<OrganizationIdentity>()).toEqual({
      slug: 'sharma-hyd',
      logo: {
        url,
        contentType: 'image/png',
        width: 120,
        height: 40,
        sizeBytes: LOGO.length,
        updatedAt: expect.any(String) as unknown,
      },
    });
    expect((await json(cashier, 'GET', '/organization/identity')).json()).toEqual(uploaded.json());
    const publicBranding = await json(null, 'GET', '/public/branding/sharma-hyd');
    expect(publicBranding.json<PublicBranding>().logoUrl).toBe(url);

    const logo = await t.app.inject({ method: 'GET', url });
    expect(logo.statusCode).toBe(200);
    expect(logo.rawPayload).toEqual(LOGO);
    expect(logo.headers).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': 'inline; filename="logo.png"',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${sha256}"`,
    });
    // Never an S3 address.
    expect(JSON.stringify([uploaded.json(), publicBranding.json()])).not.toMatch(
      /https?:|logo-test|branding\/logo-/,
    );

    const unchanged = await t.app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': `"${sha256}"` },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload.length).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: `${url.slice(0, -1)}0` })).statusCode).toBe(
      404,
    );
  });

  it('is replaced (new address, the old one gone) and removed, every step audited', async () => {
    const before = (
      await json(owner, 'GET', '/organization/identity')
    ).json<OrganizationIdentity>();
    const replacement = pngImage(64, 64, [20, 120, 60]);

    const replaced = await uploadLogo(owner, [{ fileName: 'new.png', data: replacement }]);
    const newUrl = String(replaced.json<OrganizationIdentity>().logo?.url);
    expect(newUrl).not.toBe(before.logo?.url);
    expect((await t.app.inject({ method: 'GET', url: String(before.logo?.url) })).statusCode).toBe(
      404,
    );
    expect((await t.app.inject({ method: 'GET', url: newUrl })).rawPayload).toEqual(replacement);

    const removed = await json(owner, 'DELETE', '/organization/logo');
    expect(removed.json()).toEqual({ slug: 'sharma-hyd', logo: null });
    expect((await t.app.inject({ method: 'GET', url: newUrl })).statusCode).toBe(404);
    expect(
      (await json(null, 'GET', '/public/branding/sharma-hyd')).json<PublicBranding>().logoUrl,
    ).toBeNull();

    const log = (await json(owner, 'GET', '/audit-log?table=organization_logos')).json<AuditPage>();
    expect(log.items.map((entry) => [entry.action, entry.area, entry.recordLabel])).toEqual([
      ['delete', 'Logo', 'Logo'],
      ['update', 'Logo', 'Logo'],
      ['insert', 'Logo', 'Logo'],
    ]);
    expect(log.items[1]?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'width', label: 'Width (px)', old: 120, new: 64 }),
        expect.objectContaining({ field: 'sha256', label: 'Logo file (SHA-256)' }),
      ]),
    );
  });
});

describe('the public branding of a sign-in page', () => {
  it('answers only the app name, theme and logo address, for any spelling of the slug', async () => {
    await json(owner, 'PUT', '/organization/branding', {
      ...DEFAULT_BRANDING,
      appName: 'Sharma Colours',
      primary: '#0b6e4f',
    });
    await uploadLogo(owner, [{ fileName: 'logo.png', data: LOGO }]);

    const response = await json(null, 'GET', '/public/branding/SHARMA-HYD');

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    const body = response.json<PublicBranding>();
    expect(Object.keys(body).sort()).toEqual(['branding', 'logoUrl', 'slug']);
    expect(body).toEqual({
      slug: 'sharma-hyd',
      branding: { ...DEFAULT_BRANDING, appName: 'Sharma Colours', primary: '#0b6e4f' },
      logoUrl: expect.stringMatching(
        /^\/public\/branding\/sharma-hyd\/logo\/[0-9a-f]{16}$/,
      ) as unknown,
    });
    // No ids, people or contact details.
    expect(response.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@|\+91|Owner/);
  });

  it("keeps each business to its own: another business's page and identity never show this one", async () => {
    const otherPage = (
      await json(null, 'GET', '/public/branding/xyz-paints')
    ).json<PublicBranding>();
    const otherIdentity = (
      await json(other, 'GET', '/organization/identity')
    ).json<OrganizationIdentity>();

    expect(otherPage).toEqual({ slug: 'xyz-paints', branding: DEFAULT_BRANDING, logoUrl: null });
    expect(otherIdentity).toEqual({ slug: 'xyz-paints', logo: null });
    // A logo address only works under its own business's slug.
    const sharmaLogo = String(
      (await json(owner, 'GET', '/organization/identity')).json<OrganizationIdentity>().logo?.url,
    );
    const crossed = sharmaLogo.replace('/sharma-hyd/', '/xyz-paints/');
    expect((await t.app.inject({ method: 'GET', url: crossed })).statusCode).toBe(404);
    // The other business's owner cannot change or remove this business's logo or slug.
    await json(other, 'DELETE', '/organization/logo');
    expect(
      (await json(owner, 'GET', '/organization/identity')).json<OrganizationIdentity>().logo,
    ).not.toBeNull();
  });

  it('answers unknown and suspended businesses with the same 404, saying nothing more', async () => {
    const unknown = await json(null, 'GET', '/public/branding/no-such-business');
    const malformed = await json(
      null,
      'GET',
      `/public/branding/${encodeURIComponent("x' or '1'='1")}`,
    );
    await t.connection.db
      .update(schema.organizations)
      .set({ suspendedAt: new Date(), suspendReason: 'Unpaid' })
      .where(eq(schema.organizations.id, otherOrganizationId));
    const suspended = await json(null, 'GET', '/public/branding/xyz-paints');
    const sharmaLogo = String(
      (await json(owner, 'GET', '/organization/identity')).json<OrganizationIdentity>().logo?.url,
    );
    await t.connection.db
      .update(schema.organizations)
      .set({ suspendedAt: new Date(), suspendReason: 'Unpaid' })
      .where(eq(schema.organizations.slug, 'sharma-hyd'));
    const suspendedPage = await json(null, 'GET', '/public/branding/sharma-hyd');
    const suspendedLogo = await t.app.inject({ method: 'GET', url: sharmaLogo });

    const notFound = { statusCode: 404, message: 'Not found', error: 'Not Found' };
    for (const response of [unknown, malformed, suspended, suspendedPage, suspendedLogo]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(notFound);
    }
  });
});
