import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { IS_PUBLIC } from '../auth/decorators.js';
import { api, ok } from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { ALLOW_WHEN_READ_ONLY } from './read-only.guard.js';

// Read-only mode (a trial or subscription that ended, or a payment past its grace
// days) must hold back every change a member can make, including everything MVP 3
// added: credit approvals and site accounts, collections and promises, messaging
// consents and templates, statement links and painter points rules. This walks every
// route the API has, so a new write route is covered the day it is added.

let database: TestDatabase;
let t: TestApp;
let owner: string;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString, { SIGNUP_PLAN: 'trial' });
  const signup = ok(
    await t.app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organizationName: 'Lapsed Paints',
        fullName: 'Lapsed Owner',
        phone: uniquePhone(),
        password: 'Owner@2026',
      },
    }),
  ).json<{ token: string; organizationId: string }>();
  owner = signup.token;
  // The trial ended yesterday: the business is read-only.
  await t.connection.db.execute(
    sql`update subscriptions set trial_ends_at = now() - interval '1 day' where organization_id = ${signup.organizationId}`,
  );
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

interface Route {
  readonly method: string;
  readonly path: string;
  readonly isPublic: boolean;
  readonly allowed: boolean;
}

const READS = new Set([RequestMethod.GET, RequestMethod.HEAD, RequestMethod.OPTIONS]);

/** Every route of every controller the app registered, as Nest's metadata has it. */
function routes(): Route[] {
  const found: Route[] = [];
  for (const module of t.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as unknown as { prototype: object } & object;
      const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined || READS.has(method)) continue;
        const mark = (key: string) =>
          Reflect.getMetadata(key, handler) === true ||
          Reflect.getMetadata(key, controller) === true;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler));
        found.push({
          method: RequestMethod[method],
          path: `/${[base, sub].filter((part) => part !== '' && part !== '/').join('/')}`.replace(
            /\/+/g,
            '/',
          ),
          isPublic: mark(IS_PUBLIC),
          allowed: mark(ALLOW_WHEN_READ_ONLY),
        });
      }
    }
  }
  return found;
}

/** A path with every parameter filled in (the guard answers before anything is looked up). */
const concrete = (path: string) =>
  path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000001');

describe('read-only mode', () => {
  it('lets a read-only business still sign in and out, keep its security, read notices, pay and let support in', () => {
    const allowed = routes()
      .filter((route) => route.allowed && !route.isPublic)
      .map((route) => route.path.split('/')[1]);
    expect([...new Set(allowed)].sort()).toEqual([
      'auth',
      'members',
      'notifications',
      'organization',
      'subscription',
      'support-requests',
    ]);
  });

  it('refuses every other change a member can make, MVP 3’s included', async () => {
    const writes = routes().filter((route) => !route.allowed && !route.isPublic);
    // Well over a hundred: the walk found the app's routes, not a handful.
    expect(writes.length).toBeGreaterThan(150);
    // MVP 3's write paths are among them (credit, collections, messaging, statements, painter points).
    expect(writes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining([
        'POST /credit-approvals',
        'POST /credit-approvals/:id/approve',
        'POST /credit-approvals/:id/reject',
        'POST /credit-approvals/:id/cancel',
        'POST /parties/:id/sites',
        'PATCH /site-accounts/:id',
        'PUT /credit-rules',
        'POST /parties/:id/promises',
        'POST /promises/:id/cancel',
        'POST /collections/escalations/:id/acknowledge',
        'PUT /collections/reminder-schedules',
        'POST /parties/:id/consents',
        'PUT /message-templates',
        'DELETE /message-templates/:key/:channel/:language',
        'POST /parties/:id/statement/links',
        'POST /statement-links/:id/revoke',
        'POST /loyalty-earn-rules',
        'PUT /loyalty-earn-rules/:id',
      ]),
    );
    const answers = [];
    for (const route of writes) {
      const reply = await t.app.inject({
        method: route.method as 'POST',
        url: concrete(route.path),
        headers: { authorization: `Bearer ${owner}` },
        payload: {},
      });
      answers.push({
        route: `${route.method} ${route.path}`,
        status: reply.statusCode,
        code: reply.json<{ code?: string }>().code,
      });
    }
    expect(answers.filter((answer) => answer.code !== 'subscription_read_only')).toEqual([]);
    expect(new Set(answers.map((answer) => answer.status))).toEqual(new Set([403]));
  });

  it('still lets the owner read everything and see what to pay', async () => {
    const o = api(t, owner);
    for (const path of ['/receivables/summary', '/credit-approvals', '/subscription']) {
      expect((await o.get(path)).statusCode).toBe(200);
    }
  });
});
