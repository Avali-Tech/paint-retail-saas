import { describe, expect, it } from 'vitest';
import { categoryOptions } from './categories.js';

describe('categoryOptions', () => {
  it('lists each top-level category followed by its subcategories', () => {
    expect(
      categoryOptions([
        { id: 'sub', name: 'Interior', parentId: 'emulsions', isActive: true },
        { id: 'emulsions', name: 'Emulsions', parentId: null, isActive: true },
        { id: 'primers', name: 'Primers', parentId: null, isActive: true },
      ]),
    ).toEqual([
      { id: 'emulsions', label: 'Emulsions' },
      { id: 'sub', label: 'Emulsions › Interior' },
      { id: 'primers', label: 'Primers' },
    ]);
  });
});
