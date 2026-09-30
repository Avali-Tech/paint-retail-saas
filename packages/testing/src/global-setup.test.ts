import { describe, expect, it, vi } from 'vitest';
import globalSetup from './global-setup.js';

describe('globalSetup', () => {
  it('provides the database URL to tests and returns a teardown that stops the database', async () => {
    const stop = vi.fn(() => Promise.resolve());
    const start = vi.fn(() =>
      Promise.resolve({ connectionString: 'postgres://test@localhost:5432/test', stop }),
    );
    const provide = vi.fn();

    const teardown = await globalSetup({ provide }, start);

    expect(start).toHaveBeenCalledOnce();
    expect(provide).toHaveBeenCalledWith('databaseUrl', 'postgres://test@localhost:5432/test');
    expect(stop).not.toHaveBeenCalled();

    await teardown();

    expect(stop).toHaveBeenCalledOnce();
  });

  it('fails without providing anything when the database cannot start', async () => {
    const start = vi.fn(() => Promise.reject(new Error('Docker is not running')));
    const provide = vi.fn();

    await expect(globalSetup({ provide }, start)).rejects.toThrow('Docker is not running');
    expect(provide).not.toHaveBeenCalled();
  });
});
