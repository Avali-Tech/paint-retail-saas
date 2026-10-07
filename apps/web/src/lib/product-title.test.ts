import { describe, expect, it } from 'vitest';
import { productTitle } from './product-title.js';

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
