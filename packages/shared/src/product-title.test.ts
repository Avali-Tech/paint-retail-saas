import { describe, expect, it } from 'vitest';
import {
  VARIANT_LABEL_MAX_LENGTH,
  normalizeVariantLabel,
  productTitle,
  variantName,
  variantTitle,
} from './index.js';

describe('productTitle', () => {
  it('puts the brand before the product name', () => {
    expect(productTitle('Asian Paints', 'Apex Ultima')).toBe('Asian Paints Apex Ultima');
  });

  it('says the brand once when the name already starts with it, in any case', () => {
    expect(productTitle('Berger', 'Berger Wall Putty')).toBe('Berger Wall Putty');
    expect(productTitle('Birla Opus', 'birla opus One')).toBe('birla opus One');
    expect(productTitle('Indigo', 'Indigo')).toBe('Indigo');
  });

  it('keeps a name that only begins with the same letters', () => {
    expect(productTitle('Opus', 'Opustone Matt')).toBe('Opus Opustone Matt');
  });
});

describe('normalizeVariantLabel', () => {
  it('trims a label and treats a blank one as none', () => {
    expect(normalizeVariantLabel('  2 inch ')).toBe('2 inch');
    expect(normalizeVariantLabel('   ')).toBeNull();
    expect(normalizeVariantLabel('')).toBeNull();
    expect(normalizeVariantLabel(null)).toBeNull();
    expect(normalizeVariantLabel(undefined)).toBeNull();
    expect(VARIANT_LABEL_MAX_LENGTH).toBe(40);
  });
});

describe('variantName', () => {
  it('names an unlabelled variant by its size and unit', () => {
    expect(variantName({ packSize: 10, unit: 'l' })).toBe('10 l');
    expect(variantName({ packSize: 3.6, unit: 'l', label: null })).toBe('3.6 l');
    expect(variantName({ packSize: 1, unit: 'piece', label: ' ' })).toBe('1 piece');
  });

  it('names a single piece by its label alone', () => {
    expect(variantName({ packSize: 1, unit: 'piece', label: '2 inch' })).toBe('2 inch');
    expect(variantName({ packSize: 1, unit: 'piece', label: 'Grit 120' })).toBe('Grit 120');
  });

  it('puts the label before the size for every other pack', () => {
    expect(variantName({ packSize: 1, unit: 'l', label: 'Red' })).toBe('Red · 1 l');
    expect(variantName({ packSize: 6, unit: 'piece', label: '48 mm' })).toBe('48 mm · 6 piece');
    expect(variantName({ packSize: 1, unit: 'set', label: 'Starter' })).toBe('Starter · 1 set');
  });

  it('translates the unit when asked', () => {
    const unitName = (unit: string) => (unit === 'l' ? 'लीटर' : unit);
    expect(variantName({ packSize: 4, unit: 'l' }, unitName)).toBe('4 लीटर');
    expect(variantName({ packSize: 4, unit: 'l', label: 'Red' }, unitName)).toBe('Red · 4 लीटर');
  });
});

describe('variantTitle', () => {
  it('follows the product title with the variant name', () => {
    expect(variantTitle('Asian Paints', 'Apex Ultima', { packSize: 10, unit: 'l' })).toBe(
      'Asian Paints Apex Ultima 10 l',
    );
    expect(
      variantTitle('Asian Paints', 'Paint Brush', { packSize: 1, unit: 'piece', label: '2 inch' }),
    ).toBe('Asian Paints Paint Brush 2 inch');
    expect(
      variantTitle('Berger', 'Berger Putty', { packSize: 1, unit: 'kg' }, (unit) =>
        unit.toUpperCase(),
      ),
    ).toBe('Berger Putty 1 KG');
  });
});
