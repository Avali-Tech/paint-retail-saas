import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from './index.js';

const { organizations, stores } = schema;

const allTables = Object.values(schema).filter((value) => is(value, PgTable));

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
    for (const table of allTables) {
      expect(getTableConfig(table).enableRLS, getTableConfig(table).name).toBe(true);
    }
  });

  it('resolves every foreign key to an existing table', () => {
    for (const table of allTables) {
      for (const foreignKey of getTableConfig(table).foreignKeys) {
        const reference = foreignKey.reference();
        expect(allTables).toContain(reference.foreignTable);
        expect(reference.columns).toHaveLength(reference.foreignColumns.length);
      }
    }
  });
});
