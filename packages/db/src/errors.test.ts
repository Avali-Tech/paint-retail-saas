import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './index.js';

const pgError = { code: '23505', constraint: 'users_phone_unique' };

describe('isUniqueViolation', () => {
  it('recognises a raw driver error', () => {
    expect(isUniqueViolation(pgError)).toBe(true);
  });

  it('recognises a driver error wrapped by Drizzle', () => {
    expect(isUniqueViolation(new Error('Failed query', { cause: pgError }))).toBe(true);
  });

  it('matches only the listed constraints when given', () => {
    expect(isUniqueViolation(pgError, ['users_phone_unique', 'users_email_unique'])).toBe(true);
    expect(isUniqueViolation(pgError, ['stores_organization_code_unique'])).toBe(false);
  });

  it.each([
    null,
    undefined,
    'boom',
    new Error('plain error'),
    { code: '23503', constraint: 'fk' },
    new Error('wrapped', { cause: 'not an object' }),
  ])('is false for %o', (error) => {
    expect(isUniqueViolation(error)).toBe(false);
  });
});
