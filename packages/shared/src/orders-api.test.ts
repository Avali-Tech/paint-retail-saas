import { describe, expect, it } from 'vitest';
import {
  CREDIT_OVERRIDE_PERMISSION,
  DEFAULT_CREDIT_RULES,
  EWAY_BILL_NO_PATTERN,
  OPEN_ORDER_STATUSES,
  ORDERS_PERMISSION,
  PERMISSIONS,
  SYSTEM_ROLES,
  canOverrideCredit,
  checkCredit,
  creditApprovalFor,
  effectiveQuotationStatus,
  ewayBillRequired,
  hasAtMostThreeDecimals,
  minimumAdvancePaise,
  openQuantity,
  orderStatusFor,
  type Permission,
} from './index.js';

const line = (quantity: number, quantityInvoiced = 0, quantityCancelled = 0) => ({
  quantity,
  quantityInvoiced,
  quantityCancelled,
});

describe('order lines', () => {
  it('leaves open what is neither billed nor cancelled, exactly to the thousandth', () => {
    expect(openQuantity(line(5))).toBe(5);
    expect(openQuantity(line(0.3, 0.1, 0.1))).toBe(0.1);
    expect(openQuantity(line(2, 1.5, 0.5))).toBe(0);
  });

  it('knows a quantity of at most 3 decimals', () => {
    expect(hasAtMostThreeDecimals(1.25)).toBe(true);
    expect(hasAtMostThreeDecimals(0.001)).toBe(true);
    expect(hasAtMostThreeDecimals(0.0001)).toBe(false);
  });

  it('reads the order status from its lines', () => {
    expect(orderStatusFor([line(2), line(1)])).toBe('confirmed');
    expect(orderStatusFor([line(2, 1), line(1)])).toBe('partly_fulfilled');
    expect(orderStatusFor([line(2, 2), line(1, 0, 1)])).toBe('fulfilled');
    expect(orderStatusFor([line(2, 0, 2)])).toBe('cancelled');
    expect(OPEN_ORDER_STATUSES).toEqual(['confirmed', 'partly_fulfilled']);
  });
});

describe('minimumAdvancePaise', () => {
  it('takes the percentage of the total, rounded up to the paisa', () => {
    expect(minimumAdvancePaise(118_000, 25)).toBe(29_500);
    expect(minimumAdvancePaise(1_001, 10)).toBe(101);
    expect(minimumAdvancePaise(5_000, 0)).toBe(0);
  });
});

describe('effectiveQuotationStatus', () => {
  it('expires a sent or accepted quote after its validity, nothing else', () => {
    expect(effectiveQuotationStatus('sent', '2026-10-07', '2026-10-08')).toBe('expired');
    expect(effectiveQuotationStatus('accepted', '2026-10-07', '2026-10-08')).toBe('expired');
    expect(effectiveQuotationStatus('sent', '2026-10-08', '2026-10-08')).toBe('sent');
    expect(effectiveQuotationStatus('draft', '2026-10-01', '2026-10-08')).toBe('draft');
    expect(effectiveQuotationStatus('converted', '2026-10-01', '2026-10-08')).toBe('converted');
  });
});

describe('credit approval at confirm (spec §4.4, §6.3)', () => {
  it('needs the owner for ₹15,000 on a ₹30,000 limit with ₹18,000 owed (110%)', () => {
    const check = checkCredit(
      DEFAULT_CREDIT_RULES,
      { status: 'active', limitPaise: 3_000_000, exposurePaise: 1_800_000, overdueDays: 0 },
      1_500_000,
    );
    expect(check.utilizationPercent).toBe(110);
    expect(creditApprovalFor(check.decision)).toBe('owner');
  });

  it('maps every decision to who must approve', () => {
    expect(creditApprovalFor('allowed')).toBe('none');
    expect(creditApprovalFor('manager_approval')).toBe('manager');
    expect(creditApprovalFor('owner_approval')).toBe('owner');
    expect(creditApprovalFor('blocked')).toBe('blocked');
  });

  it('lets credit:approve override a manager approval, and only the owner an owner approval', () => {
    const approver = new Set<Permission>([CREDIT_OVERRIDE_PERMISSION]);
    const none = new Set<Permission>();
    expect(canOverrideCredit('none', { permissions: none, roleKey: 'sales_executive' })).toBe(true);
    expect(canOverrideCredit('manager', { permissions: approver, roleKey: 'org_admin' })).toBe(
      true,
    );
    expect(canOverrideCredit('manager', { permissions: none, roleKey: 'owner' })).toBe(false);
    expect(canOverrideCredit('owner', { permissions: approver, roleKey: 'org_admin' })).toBe(false);
    expect(canOverrideCredit('owner', { permissions: approver, roleKey: 'owner' })).toBe(true);
    expect(canOverrideCredit('blocked', { permissions: approver, roleKey: 'owner' })).toBe(false);
  });
});

describe('e-way bill (spec §2.10)', () => {
  it('is needed above the threshold, and is 12 digits', () => {
    expect(ewayBillRequired(5_000_001, 5_000_000)).toBe(true);
    expect(ewayBillRequired(5_000_000, 5_000_000)).toBe(false);
    expect(EWAY_BILL_NO_PATTERN.test('123456789012')).toBe(true);
    expect(EWAY_BILL_NO_PATTERN.test('12345678901')).toBe(false);
  });
});

describe('permissions', () => {
  it('adds sales:manage for owners, admins, branch managers and sales executives', () => {
    expect(PERMISSIONS).toContain(ORDERS_PERMISSION);
    expect(
      SYSTEM_ROLES.filter((role) => role.permissions.includes(ORDERS_PERMISSION)).map(
        (role) => role.key,
      ),
    ).toEqual(['owner', 'org_admin', 'branch_manager', 'sales_executive']);
  });
});
