import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';

const controllerWithDatabase = (up: boolean) =>
  new HealthController({ isDatabaseUp: () => Promise.resolve(up) } as HealthService);

describe('HealthController', () => {
  it('reports the process as alive without touching the database', () => {
    expect(controllerWithDatabase(false).live()).toEqual({ status: 'ok' });
  });

  it('is ready when the database is up', async () => {
    await expect(controllerWithDatabase(true).ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
  });

  it('answers 503 with the failing check when the database is down', async () => {
    const error = await controllerWithDatabase(false)
      .ready()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { database: 'down' },
    });
  });
});
