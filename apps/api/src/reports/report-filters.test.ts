import { describe, expect, it } from 'vitest';
import {
  booleanFilter,
  brandFilter,
  categoryFilter,
  dateFilter,
  enumFilter,
  memberFilter,
  reportFilters,
  storeFilter,
  supplierFilter,
  textFilter,
} from './report-filters.js';

describe('reportFilters', () => {
  const { filters, filterInfo } = reportFilters({
    storeId: storeFilter,
    from: dateFilter,
    status: enumFilter(['open', 'closed']),
    supplierId: supplierFilter,
    archived: booleanFilter(false),
    inStockOnly: booleanFilter(true),
  });

  it('describes each filter for the app, in order', () => {
    expect(filterInfo).toEqual([
      { name: 'storeId', type: 'store' },
      { name: 'from', type: 'date' },
      { name: 'status', type: 'enum', values: ['open', 'closed'] },
      { name: 'supplierId', type: 'supplier' },
      { name: 'archived', type: 'boolean', default: 'false' },
      { name: 'inStockOnly', type: 'boolean', default: 'true' },
    ]);
  });

  it('parses the same filters, with yes/no defaults', () => {
    expect(filters.parse({})).toEqual({ archived: false, inStockOnly: true });
    expect(filters.parse({ status: 'open', archived: 'true', inStockOnly: 'false' })).toEqual({
      status: 'open',
      archived: true,
      inStockOnly: false,
    });
    expect(filters.safeParse({ status: 'lost' }).success).toBe(false);
    expect(filters.safeParse({ from: '2026-13-01' }).success).toBe(false);
  });
});

describe('catalogue, team and text filters', () => {
  const { filters, filterInfo } = reportFilters({
    brandId: brandFilter,
    categoryId: categoryFilter,
    salespersonId: memberFilter,
    product: textFilter,
  });

  it('say what they pick', () => {
    expect(filterInfo.map((filter) => filter.type)).toEqual([
      'brand',
      'category',
      'member',
      'text',
    ]);
  });

  it('take ids and trimmed text, leaving blank text out', () => {
    const id = '7d3c1f9e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
    expect(filters.parse({ brandId: id, product: '  apex ' })).toEqual({
      brandId: id,
      product: 'apex',
    });
    expect(filters.parse({ product: '   ' })).toEqual({ product: undefined });
    expect(filters.safeParse({ salespersonId: 'me' }).success).toBe(false);
    expect(filters.safeParse({ product: 'x'.repeat(101) }).success).toBe(false);
  });
});
