import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { hi } from './hi.js';
import { te } from './te.js';

// The type system already refuses a Hindi or Telugu file with a missing or extra key;
// these checks repeat that at runtime and check what types cannot: placeholders,
// digits and that every message really is translated.

/** Every message as [key, text], in file order. */
function entries(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    entries(value, prefix === '' ? key : `${prefix}.${key}`),
  );
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/**
 * Messages that may read the same in every language: symbols, formats, abbreviations
 * (GSTIN, MRP), units (kg, KB) and brand names, e.g. "HSN {hsn} · GST {rate}%".
 */
const KEPT_WORDS = new Set(['ml', 'l', 'g', 'kg', 'm', 'B', 'KB', 'MB', 'WhatsApp', 'txt']);
function isLanguageNeutral(text: string): boolean {
  const words = text.replace(/\{\w+\}/g, ' ').match(/\p{L}+/gu) ?? [];
  return words.every((word) => /^[A-Z]+$/.test(word) || KEPT_WORDS.has(word));
}

const TRANSLATIONS = { hi, te } as const;
const english = entries(en);

describe.each(Object.entries(TRANSLATIONS))('%s messages', (_, messages) => {
  const translated = entries(messages);
  const byKey = new Map(translated);

  it('have exactly the English keys, in the same order', () => {
    expect(translated.map(([key]) => key)).toEqual(english.map(([key]) => key));
  });

  it('keep every placeholder of the English message, key by key', () => {
    const mismatches = english.filter(
      ([key, text]) => placeholders(String(byKey.get(key))).join() !== placeholders(text).join(),
    );
    expect(mismatches.map(([key]) => key)).toEqual([]);
  });

  it('are all written out, with Latin digits', () => {
    for (const [key, text] of translated) {
      expect(text.trim(), key).not.toBe('');
      expect(text, key).not.toMatch(/[०-९౦-౯]/);
    }
  });

  it('are translated, apart from symbols and abbreviations', () => {
    const untranslated = english.filter(
      ([key, text]) =>
        byKey.get(key) === text && !isLanguageNeutral(text) && key !== 'recovery.fileName',
    );
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });
});

describe('checks', () => {
  it('tell abbreviations, units and brands from words to translate', () => {
    expect(isLanguageNeutral('HSN {hsn} · GST {rate}%')).toBe(true);
    expect(isLanguageNeutral('{size} KB')).toBe(true);
    expect(isLanguageNeutral('—')).toBe(true);
    expect(isLanguageNeutral('Sign in')).toBe(false);
  });

  it('find the placeholders in a message', () => {
    expect(placeholders('{to} from {from}, {to}')).toEqual(['from', 'to', 'to']);
    expect(placeholders('none')).toEqual([]);
  });
});
