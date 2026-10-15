import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CREDIT_RULES,
  approvalCovers,
  approvalLevelOf,
  canApproveSale,
  checkCredit,
  creditApprovalFor,
  stricterCheck,
  type Permission,
  type SaleCreditView,
  type SiteCreditPosition,
} from './index.js';

const AMP = 'store-ameerpet';
const KKP = 'store-kukatpally';

/** §6.3: a ₹30,000 limit with `owed` already owed, checked for `amount`. */
function sale(
  owed: number,
  amount: number,
  site: SiteCreditPosition | null = null,
): SaleCreditView {
  const position = {
    status: 'active' as const,
    limitPaise: 30_000_00,
    exposurePaise: owed,
    overdueDays: 0,
  };
  const check = checkCredit(DEFAULT_CREDIT_RULES, position, amount);
  return {
    required: true,
    exposureSource: 'ledger',
    position,
    check,
    site,
    approval: creditApprovalFor(stricterCheck(check, site?.check ?? check).decision),
  };
}

function site(owed: number, amount: number, id = 'site-1'): SiteCreditPosition {
  return {
    siteAccountId: id,
    projectId: 'project-1',
    projectName: 'Jubilee Hills villa',
    status: 'active',
    limitPaise: 10_000_00,
    exposurePaise: owed,
    check: checkCredit(
      DEFAULT_CREDIT_RULES,
      { status: 'active', limitPaise: 10_000_00, exposurePaise: owed, overdueDays: 0 },
      amount,
    ),
  };
}

describe('approvalLevelOf', () => {
  it('gives a level only for a manager or owner approval', () => {
    expect(approvalLevelOf('manager')).toBe('manager');
    expect(approvalLevelOf('owner')).toBe('owner');
    expect(approvalLevelOf('none')).toBeNull();
    expect(approvalLevelOf('blocked')).toBeNull();
  });
});

describe('canApproveSale (spec §4.3)', () => {
  const member = (
    roleKey: string,
    permissions: Permission[],
    { allStores = false, storeIds = [AMP] } = {},
  ) => ({ roleKey, permissions: new Set(permissions), allStores, storeIds: new Set(storeIds) });

  it('lets the owner approve anything, anywhere', () => {
    const owner = member('owner', [], { storeIds: [] });
    expect(canApproveSale('owner', owner, KKP)).toBe(true);
    expect(canApproveSale('manager', owner, KKP)).toBe(true);
  });

  it('lets a manager approve manager-level sales at their own stores only', () => {
    const manager = member('branch_manager', ['credit:approve_sale']);
    expect(canApproveSale('manager', manager, AMP)).toBe(true);
    expect(canApproveSale('manager', manager, KKP)).toBe(false);
    expect(canApproveSale('owner', manager, AMP)).toBe(false);
    const admin = member('org_admin', ['credit:approve_sale'], { allStores: true, storeIds: [] });
    expect(canApproveSale('manager', admin, KKP)).toBe(true);
    expect(canApproveSale('owner', admin, KKP)).toBe(false);
  });

  it('needs credit:approve_sale for a manager-level sale', () => {
    expect(canApproveSale('manager', member('sales_executive', ['credit:manage']), AMP)).toBe(
      false,
    );
  });
});

describe('approvalCovers (spec §4.3)', () => {
  it('covers the same sale, or one that now needs less', () => {
    const approved = sale(18_000_00, 15_000_00);
    expect(approvalCovers('owner', approved, approved)).toBe(true);
    // A payment came in: the same order now only needs a manager.
    expect(approvalCovers('owner', approved, sale(10_000_00, 15_000_00))).toBe(true);
    // ... or nothing at all.
    expect(approvalCovers('owner', approved, sale(0, 15_000_00))).toBe(true);
  });

  it('does not cover more exposure, a higher level, or a block', () => {
    const managerApproved = sale(18_000_00, 6_000_00);
    expect(approvalCovers('manager', managerApproved, sale(18_000_00, 6_000_01))).toBe(false);
    expect(approvalCovers('manager', managerApproved, sale(18_000_00, 15_000_00))).toBe(false);
    expect(approvalCovers('owner', sale(18_000_00, 15_000_00), sale(18_000_01, 15_000_00))).toBe(
      false,
    );
    const blocked = { ...sale(0, 0), approval: 'blocked' as const };
    expect(approvalCovers('owner', managerApproved, blocked)).toBe(false);
  });

  it('checks the site too: the same site, no more site exposure', () => {
    const approved = sale(0, 9_000_00, site(1_000_00, 9_000_00));
    expect(approvalCovers('manager', approved, approved)).toBe(true);
    expect(approvalCovers('manager', approved, sale(0, 9_000_00, site(1_000_01, 9_000_00)))).toBe(
      false,
    );
    expect(
      approvalCovers('manager', approved, sale(0, 9_000_00, site(1_000_00, 9_000_00, 'site-2'))),
    ).toBe(false);
    // Approved without a site, now on one.
    const plain = { ...sale(0, 9_000_00), approval: 'manager' as const };
    expect(approvalCovers('manager', plain, sale(0, 9_000_00, site(1_000_00, 9_000_00)))).toBe(
      false,
    );
  });

  it('never lets an approval with no check cover a sale that needs one', () => {
    const unchecked: SaleCreditView = { ...sale(0, 0), required: false, check: null };
    expect(approvalCovers('owner', unchecked, sale(18_000_00, 15_000_00))).toBe(false);
  });
});
