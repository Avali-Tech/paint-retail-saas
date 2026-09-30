import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from './index.js';

const { organizations, stores } = schema;

describe('schema', () => {
  it('links every store to its organisation and blocks deleting an organisation that has stores', () => {
    const [foreignKey] = getTableConfig(stores).foreignKeys;
    const reference = foreignKey?.reference();

    expect(reference?.columns.map((column) => column.name)).toEqual(['organization_id']);
    expect(reference?.foreignTable).toBe(organizations);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(['id']);
    expect(foreignKey?.onDelete).toBe('restrict');
  });

  it('enables row-level security on every table', () => {
    expect(getTableConfig(organizations).enableRLS).toBe(true);
    expect(getTableConfig(stores).enableRLS).toBe(true);
  });
});
