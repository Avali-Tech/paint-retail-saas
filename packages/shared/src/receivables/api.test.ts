import { describe, expect, it } from 'vitest';
import { isPermission } from '../permissions.js';
import {
  AGEING_GROUPS,
  RECEIVABLES_PERMISSION,
  STATEMENT_MAX_ENTRIES,
  STATEMENT_PERMISSION,
} from './api.js';

describe('receivables API constants', () => {
  it('gates on existing permissions, so no role needs a migration', () => {
    expect(isPermission(RECEIVABLES_PERMISSION)).toBe(true);
    expect(isPermission(STATEMENT_PERMISSION)).toBe(true);
    expect(AGEING_GROUPS).toEqual(['customer', 'salesperson', 'store']);
    expect(STATEMENT_MAX_ENTRIES).toBe(5_000);
  });
});
