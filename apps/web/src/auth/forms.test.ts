import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { showApiError } from './forms.js';

describe('showApiError', () => {
  it('puts field issues on their fields and returns nothing else to show', () => {
    const setError = vi.fn();
    const error = new ApiError(400, 'Invalid request', [{ path: 'phone', message: 'Too short' }]);
    expect(showApiError<{ phone: string }>(error, ['phone'], setError)).toBeNull();
    expect(setError).toHaveBeenCalledWith('phone', { type: 'server', message: 'Too short' });
  });

  it('returns the message for anything that is not about a field on the form', () => {
    const setError = vi.fn();
    expect(showApiError(new ApiError(401, 'Invalid sign-in details'), ['phone'], setError)).toBe(
      'Invalid sign-in details',
    );
    expect(showApiError(new TypeError('bug'), ['phone'], setError)).toBe(
      'Something went wrong. Please try again.',
    );
    expect(setError).not.toHaveBeenCalled();
  });
});
