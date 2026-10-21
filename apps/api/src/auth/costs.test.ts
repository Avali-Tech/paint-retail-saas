import { describe, expect, it } from 'vitest';
import { costFor } from './costs.js';

const access = (permissions: ('costs:read' | 'inventory:read')[]) => ({
  permissions: new Set(permissions),
  allStores: true,
  storeIds: new Set<string>(),
});

describe('costFor', () => {
  it('shows a cost only with costs:read', () => {
    expect(costFor(access(['inventory:read', 'costs:read']), 4_200)).toBe(4_200);
    expect(costFor(access(['inventory:read', 'costs:read']), null)).toBeNull();
    expect(costFor(access(['inventory:read']), 4_200)).toBeNull();
  });
});
