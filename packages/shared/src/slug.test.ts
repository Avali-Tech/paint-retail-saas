import { describe, expect, it } from 'vitest';
import {
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  normalizeSlug,
  signInPath,
  validateSlug,
} from './slug.js';

describe('validateSlug', () => {
  it('accepts lower-case words joined by hyphens, normalizing case and spaces around', () => {
    expect(validateSlug('sharma-paints')).toEqual({ ok: true, slug: 'sharma-paints' });
    expect(validateSlug('  Sharma-Paints-2 ')).toEqual({ ok: true, slug: 'sharma-paints-2' });
    expect(validateSlug('abc')).toEqual({ ok: true, slug: 'abc' });
    expect(validateSlug('a'.repeat(SLUG_MAX_LENGTH))).toMatchObject({ ok: true });
  });

  it('refuses names that are too short or too long', () => {
    for (const input of ['', 'ab', '  a ', 'a'.repeat(SLUG_MAX_LENGTH + 1), 42, null]) {
      expect(validateSlug(input)).toEqual({
        ok: false,
        problem: 'length',
        message: 'Use 3 to 40 characters',
      });
    }
  });

  it('refuses anything but letters, digits and single inner hyphens', () => {
    for (const input of [
      '-sharma',
      'sharma-',
      'sharma--paints',
      'sharma paints',
      'sharma_paints',
      'sharma.paints',
      'शर्मा-पेंट्स',
      '../admin',
      'sharma%2fpaints',
    ]) {
      expect(validateSlug(input), input).toMatchObject({ ok: false, problem: 'format' });
    }
  });

  it('refuses every reserved name, in any case', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(validateSlug(reserved.toUpperCase()), reserved).toEqual({
        ok: false,
        problem: 'reserved',
        message: 'This name is reserved. Choose another.',
      });
    }
    expect(RESERVED_SLUGS).toEqual(
      expect.arrayContaining(['platform', 'api', 'www', 'admin', 'sign-in']),
    );
  });

  it('keeps reserved names themselves valid slugs, so the database can refuse them too', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(reserved).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe('slug helpers', () => {
  it('normalizes as typed', () => {
    expect(normalizeSlug('  Sharma-Paints ')).toBe('sharma-paints');
  });

  it('builds the branded sign-in path', () => {
    expect(signInPath('sharma-paints')).toBe('/sign-in?b=sharma-paints');
  });
});
