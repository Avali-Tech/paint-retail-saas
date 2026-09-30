import { describe, expect, it } from 'vitest';
import { isCheckViolation, isUniqueViolation, uniqueViolationConstraint } from './index.js';

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

describe('uniqueViolationConstraint', () => {
  it('names the violated constraint, raw or wrapped', () => {
    expect(uniqueViolationConstraint(pgError)).toBe('users_phone_unique');
    expect(uniqueViolationConstraint(new Error('Failed query', { cause: pgError }))).toBe(
      'users_phone_unique',
    );
  });

  it('is null for other errors', () => {
    expect(uniqueViolationConstraint(new Error('boom'))).toBeNull();
    expect(uniqueViolationConstraint({ code: '23514', constraint: 'x' })).toBeNull();
    expect(uniqueViolationConstraint(null)).toBeNull();
  });
});

describe('isCheckViolation', () => {
  const checkError = { code: '23514', constraint: 'product_variants_price_within_mrp' };

  it('recognises the listed check constraints only', () => {
    expect(isCheckViolation(checkError, ['product_variants_price_within_mrp'])).toBe(true);
    expect(isCheckViolation(checkError, ['other_check'])).toBe(false);
  });

  it('is false for other errors', () => {
    expect(isCheckViolation(pgError, ['users_phone_unique'])).toBe(false);
    expect(isCheckViolation(undefined, ['x'])).toBe(false);
  });
});
