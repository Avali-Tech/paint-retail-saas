import { describe, expect, it } from 'vitest';
import { optional, parseNumber, parseRupees, rupeesInput, splitList } from './inputs.js';
import { wholeNumber } from './numbers.js';

describe('form input helpers', () => {
  it('reads rupees as paise and writes paise back for an input', () => {
    expect(parseRupees('1,250.50')).toBe(125050);
    expect(parseRupees('a lot')).toBeNull();
    expect(rupeesInput(125050)).toBe('1250.50');
    expect(rupeesInput(null)).toBe('');
  });

  it('splits lists, trims optional text and reads decimal numbers', () => {
    expect(splitList('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(optional('  ')).toBeNull();
    expect(optional(' x ')).toBe('x');
    expect(parseNumber(' -2.5 ')).toBe(-2.5);
    expect(parseNumber('2,5')).toBeNull();
  });

  it('checks whole numbers within a range', () => {
    const percent = wholeNumber(0, 100, 'bad');
    expect(percent.parse(' 80 ')).toBe(80);
    expect(percent.safeParse('101').success).toBe(false);
    expect(percent.safeParse('8.5').success).toBe(false);
  });
});
