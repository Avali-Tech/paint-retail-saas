import { describe, expect, it } from 'vitest';
import { amountInWords } from '../index.js';

describe('amountInWords', () => {
  it('writes the invoice example in Indian numbering', () => {
    expect(amountInWords(1_23_456_78)).toBe(
      'Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only',
    );
  });

  it('handles zero, paise alone and whole rupees', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(50)).toBe('Fifty Paise Only');
    expect(amountInWords(1)).toBe('One Paise Only');
    expect(amountInWords(100)).toBe('Rupees One Only');
    expect(amountInWords(1_01)).toBe('Rupees One and One Paise Only');
  });

  it('spells teens, round tens and hundreds without a remainder', () => {
    expect(amountInWords(13_00)).toBe('Rupees Thirteen Only');
    expect(amountInWords(40_00)).toBe('Rupees Forty Only');
    expect(amountInWords(99_99)).toBe('Rupees Ninety-Nine and Ninety-Nine Paise Only');
    expect(amountInWords(500_00)).toBe('Rupees Five Hundred Only');
    expect(amountInWords(1_000_00)).toBe('Rupees One Thousand Only');
    expect(amountInWords(1_005_00)).toBe('Rupees One Thousand Five Only');
  });

  it('uses lakh and crore, skipping empty places', () => {
    expect(amountInWords(1_00_000_00)).toBe('Rupees One Lakh Only');
    expect(amountInWords(10_00_00_000_00)).toBe('Rupees Ten Crore Only');
    expect(amountInWords(1_00_00_001_00)).toBe('Rupees One Crore One Only');
    expect(amountInWords(99_99_99_999_99)).toBe(
      'Rupees Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine and Ninety-Nine Paise Only',
    );
  });

  it('repeats the scale above a hundred crore', () => {
    expect(amountInWords(1_23_45_67_89_012_00)).toBe(
      'Rupees Twelve Thousand Three Hundred Forty-Five Crore Sixty-Seven Lakh Eighty-Nine Thousand Twelve Only',
    );
    expect(amountInWords(100_00_00_000_00)).toBe('Rupees One Hundred Crore Only');
  });

  it('refuses negative or fractional paise', () => {
    expect(() => amountInWords(-1)).toThrow(expect.objectContaining({ code: 'invalid_amount' }));
    expect(() => amountInWords(0.5)).toThrow('Amount must be whole non-negative paise');
  });
});
