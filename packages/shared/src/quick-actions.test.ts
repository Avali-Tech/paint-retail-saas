import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type MemberAccess, type Permission } from './permissions.js';
import { QUICK_ACTIONS, quickActions } from './quick-actions.js';

const access = (permissions: Permission[]): MemberAccess => ({
  permissions: new Set(permissions),
  allStores: false,
  storeIds: new Set(),
});
const keys = (actions: { key: string }[]) => actions.map((action) => action.key);

describe('quickActions', () => {
  it('offers everything to someone who may do everything', () => {
    expect(quickActions(access([...PERMISSIONS]))).toHaveLength(QUICK_ACTIONS.length);
  });

  it('offers only what the member may do', () => {
    expect(keys(quickActions(access(['stores:read', 'parties:read', 'inventory:read'])))).toEqual([
      'low_stock',
      'my_follow_ups',
    ]);
    expect(keys(quickActions(access(['parties:manage'])))).toEqual([
      'new_customer',
      'import_data',
      'my_follow_ups',
    ]);
  });

  it('matches every typed word against the label and keywords, ignoring case', () => {
    const everyone = access([...PERMISSIONS]);

    expect(keys(quickActions(everyone, '  GRN '))).toEqual(['receive_goods']);
    expect(keys(quickActions(everyone, 'stock'))).toEqual([
      'new_transfer',
      'record_stock',
      'new_stock_count',
      'low_stock',
    ]);
    expect(keys(quickActions(everyone, 'add contractor'))).toEqual(['new_customer']);
    expect(keys(quickActions(everyone, 'agreement'))).toEqual(['new_contract']);
    expect(quickActions(access(['contracts:manage']), 'contract')).toEqual([
      expect.objectContaining({ path: '/contracts/new', shortcut: 'N A' }),
    ]);
    expect(quickActions(access(['contracts:read']), 'contract')).toEqual([]);
    expect(quickActions(everyone, 'invoice payment')).toEqual([]);
  });

  it('gives every action a unique key and shortcut', () => {
    expect(new Set(QUICK_ACTIONS.map((a) => a.key)).size).toBe(QUICK_ACTIONS.length);
    expect(new Set(QUICK_ACTIONS.map((a) => a.shortcut)).size).toBe(QUICK_ACTIONS.length);
  });
});
