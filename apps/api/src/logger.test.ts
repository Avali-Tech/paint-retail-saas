import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, enabledLogLevels } from './logger.js';

function captureStdout() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enabledLogLevels', () => {
  it.each([
    ['fatal', ['fatal']],
    ['warn', ['fatal', 'error', 'warn']],
    ['verbose', ['fatal', 'error', 'warn', 'log', 'debug', 'verbose']],
  ] as const)('%s enables %o', (level, expected) => {
    expect(enabledLogLevels(level)).toEqual(expected);
  });
});

describe('createLogger', () => {
  it('writes one JSON object per line in production', () => {
    const lines = captureStdout();

    createLogger({ nodeEnv: 'production', logLevel: 'log' }).log('Order created', 'Sales');

    const entry = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: 'log', message: 'Order created', context: 'Sales' });
  });

  it('writes readable text outside production', () => {
    const lines = captureStdout();

    createLogger({ nodeEnv: 'development', logLevel: 'log' }).log('Order created', 'Sales');

    const output = lines.join('');
    expect(output).toContain('Order created');
    expect(() => JSON.parse(output) as unknown).toThrow();
  });

  it('drops messages below the configured level', () => {
    const lines = captureStdout();

    createLogger({ nodeEnv: 'production', logLevel: 'warn' }).log('Too chatty');

    expect(lines).toEqual([]);
  });
});
