import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service.js';

const connectionWith = (execute: () => Promise<unknown>) =>
  ({ db: { execute }, close: vi.fn() }) as unknown as DatabaseConnection;

describe('HealthService.isDatabaseUp', () => {
  it('is true when the database answers', async () => {
    const service = new HealthService(connectionWith(() => Promise.resolve({ rows: [] })));

    await expect(service.isDatabaseUp()).resolves.toBe(true);
  });

  it('is false, without throwing, when the database fails', async () => {
    const service = new HealthService(
      connectionWith(() => Promise.reject(new Error('connection refused'))),
    );

    await expect(service.isDatabaseUp()).resolves.toBe(false);
  });
});
