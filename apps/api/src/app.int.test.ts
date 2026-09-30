import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDatabase, migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
});

afterAll(async () => {
  await database.stop();
});

const configFor = (databaseUrl: string) =>
  loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });

describe('API with a reachable database', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp(
      configFor(database.connectionString),
      createDatabase(database.connectionString),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health answers 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready answers 200 with the database up', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'up' } });
  });

  it('answers 404 as JSON for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('API with an unreachable database', () => {
  it('stays alive but reports not ready, so traffic is not sent to it', async () => {
    const unreachable = 'postgres://app:wrong@127.0.0.1:1/none';
    const app = await createApp(configFor(unreachable), createDatabase(unreachable));
    try {
      const live = await app.inject({ method: 'GET', url: '/health' });
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(live.statusCode).toBe(200);
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({ status: 'error', checks: { database: 'down' } });
    } finally {
      await app.close();
    }
  });
});

describe('shutdown', () => {
  it('closes the database connection pool when the app closes', async () => {
    const connection = createDatabase(database.connectionString);
    const app = await createApp(configFor(database.connectionString), connection);
    await connection.db.select().from(schema.organizations);

    await app.close();

    await expect(connection.db.select().from(schema.organizations)).rejects.toThrow();
  });
});
