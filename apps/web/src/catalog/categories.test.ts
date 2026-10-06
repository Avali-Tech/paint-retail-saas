import { describe, expect, it } from 'vitest';
import type { Category } from '../api/catalog.js';
import { categoryOptions, inactiveThroughParent, usableCategories } from './categories.js';

const EMULSIONS: Category = { id: 'emulsions', name: 'Emulsions', parentId: null, isActive: true };
const INTERIOR: Category = { id: 'sub', name: 'Interior', parentId: 'emulsions', isActive: true };
const PRIMERS: Category = { id: 'primers', name: 'Primers', parentId: null, isActive: false };
const WALL: Category = { id: 'wall', name: 'Wall', parentId: 'primers', isActive: true };
const OLD: Category = { id: 'old', name: 'Old', parentId: 'emulsions', isActive: false };
const ALL = [INTERIOR, EMULSIONS, PRIMERS, WALL, OLD];
const ids = (categories: Category[]) => categories.map((category) => category.id);

describe('categoryOptions', () => {
  it('lists each top-level category followed by its subcategories', () => {
    expect(categoryOptions([INTERIOR, EMULSIONS, { ...PRIMERS, isActive: true }])).toEqual([
      { id: 'emulsions', label: 'Emulsions' },
      { id: 'sub', label: 'Emulsions › Interior' },
      { id: 'primers', label: 'Primers' },
    ]);
  });
});

describe('usableCategories', () => {
  it('leaves out inactive categories and subcategories of inactive ones', () => {
    expect(ids(usableCategories(ALL, null))).toEqual(['sub', 'emulsions']);
  });

  it('keeps the category a product is already in', () => {
    expect(ids(usableCategories(ALL, 'wall'))).toEqual(['sub', 'emulsions', 'wall']);
    expect(ids(usableCategories(ALL, 'old'))).toEqual(['sub', 'emulsions', 'old']);
  });
});

describe('inactiveThroughParent', () => {
  it('is true only for an active subcategory of an inactive category', () => {
    expect(inactiveThroughParent(WALL, ALL)).toBe(true);
    expect(inactiveThroughParent(INTERIOR, ALL)).toBe(false);
    expect(inactiveThroughParent(PRIMERS, ALL)).toBe(false);
    expect(inactiveThroughParent({ ...WALL, isActive: false }, ALL)).toBe(false);
  });
});
