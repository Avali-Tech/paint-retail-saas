import { migrateDatabase } from '@paint/db';
import { deriveTheme, type BrandingSaved, type BrandingView } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuditPage } from '../audit/audit.service.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

let database: TestDatabase;
let t: TestApp;
let owner: string;
/** Store employee: sees the branding, cannot change it. */
let cashier: string;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  put: (url: string, payload: unknown) =>
    t.app.inject({
      method: 'PUT',
      url,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    }),
});

const sunshine = {
  appName: '  Sharma Paints  ',
  primary: '#FF0',
  accent: '#0b6e4f',
  mode: 'light',
  radius: 'large',
  density: 'compact',
  font: 'poppins',
};

async function signup(name: string): Promise<string> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Anil Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  return response.json<{ token: string }>().token;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('Sharma Paints');
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
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

describe('branding', () => {
  it('is not set until the business chooses it', async () => {
    const response = await api(cashier).get('/organization/branding');

    expect(response.statusCode).toBe(404);
  });

  it('is changed only by members who manage the business', async () => {
    expect((await api(cashier).put('/organization/branding', sunshine)).statusCode).toBe(403);
  });

  it('refuses invalid branding, listing every problem like other validation errors', async () => {
    const response = await api(owner).put('/organization/branding', {
      ...sunshine,
      appName: ' ',
      primary: 'blue',
      font: 'comic-sans',
    });
    const notObject = await api(owner).put('/organization/branding', ['#fff']);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      message: 'Invalid branding',
      issues: [
        { path: 'appName', message: 'Enter the app name' },
        { path: 'primary', message: 'Enter a colour like #1d4ed8' },
        { path: 'font', message: 'Choose one of: system, inter, noto-sans, poppins, mukta' },
      ],
    });
    expect(notObject.json<{ issues: unknown[] }>().issues).toEqual([
      { path: '', message: 'Branding must be an object' },
    ]);
  });

  it('saves the normalised branding and reports how the theme kept colours readable', async () => {
    const response = await api(owner).put('/organization/branding', sunshine);

    expect(response.statusCode).toBe(200);
    const saved = response.json<BrandingSaved>();
    const normalised = {
      ...sunshine,
      appName: 'Sharma Paints',
      primary: '#ffff00',
      mode: 'light' as const,
      radius: 'large' as const,
      density: 'compact' as const,
      font: 'poppins' as const,
    };
    expect(saved.branding).toEqual(normalised);
    // Yellow is unreadable as a button colour on white, so the theme darkens it.
    expect(saved.adjustments.length).toBeGreaterThan(0);
    expect(saved.adjustments).toEqual(deriveTheme(normalised).adjustments);

    const view = (await api(cashier).get('/organization/branding')).json<BrandingView>();
    expect(view.branding).toEqual(normalised);
    expect(Date.parse(view.updatedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('replaces the branding, audited, and keeps each business to its own', async () => {
    const blue = { ...sunshine, primary: '#1d4ed8', mode: 'system' };
    const replaced = await api(owner).put('/organization/branding', blue);
    const other = await signup('XYZ Paints');

    expect(replaced.json<BrandingSaved>()).toMatchObject({
      branding: { primary: '#1d4ed8', mode: 'system' },
    });
    expect((await api(other).get('/organization/branding')).statusCode).toBe(404);
    const log = (await api(owner).get('/audit-log?table=organization_branding')).json<AuditPage>();
    expect(log.items.map((entry) => [entry.action, entry.area, entry.recordLabel])).toEqual([
      ['update', 'Branding', 'Branding'],
      ['insert', 'Branding', 'Branding'],
    ]);
    expect(log.items[0]?.changes[0]).toMatchObject({
      label: 'Branding',
      old: expect.objectContaining({ primary: '#ffff00', mode: 'light' }) as unknown,
      new: expect.objectContaining({ primary: '#1d4ed8', mode: 'system' }) as unknown,
    });
  });
});
