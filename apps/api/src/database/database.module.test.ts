import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it, vi } from 'vitest';
import { DATABASE, DatabaseLifecycle, DatabaseModule } from './database.module.js';

describe('DatabaseModule', () => {
  it('shares the given connection under the DATABASE token', () => {
    const connection = { db: {}, close: vi.fn() } as unknown as DatabaseConnection;

    const module = DatabaseModule.forRoot(connection);

    expect(module.module).toBe(DatabaseModule);
    expect(module.providers).toContainEqual({ provide: DATABASE, useValue: connection });
    expect(module.providers).toContain(DatabaseLifecycle);
    expect(module.exports).toEqual([DATABASE]);
  });
});

describe('DatabaseLifecycle', () => {
  it('closes the connection pool when the app shuts down', async () => {
    const close = vi.fn(() => Promise.resolve());
    const lifecycle = new DatabaseLifecycle({ db: {}, close } as unknown as DatabaseConnection);

    await lifecycle.onApplicationShutdown();

    expect(close).toHaveBeenCalledOnce();
  });
});
