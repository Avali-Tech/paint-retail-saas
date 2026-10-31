import { SYSTEM_ROLES, effectivePermissions, type Permission } from '@paint/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { found } from '../test-support/found.js';
import { LAST_TABS_KEY, readLastTabs, rememberTab } from './last-tab.js';
import { NAV_ITEMS, SECTION_KEYS, type NavItem } from './nav.js';
import {
  SECTION_INFO,
  allows,
  pageAt,
  phoneBar,
  sectionAt,
  sectionTarget,
  visibleNav,
  visibleSections,
  type Can,
  type Section,
} from './sections.js';

const holding =
  (held: Iterable<Permission>): Can =>
  (permission) =>
    new Set(held).has(permission);

function role(key: string): Can {
  const found = SYSTEM_ROLES.find((candidate) => candidate.key === key);
  if (!found) throw new Error(key);
  return holding(found.permissions);
}

/** Each section a member sees, with its tabs' keys. */
const menu = (can: Can) =>
  visibleSections(can).map((section) => [section.key, section.tabs.map((tab) => tab.key)]);

const ITEM = (overrides: Partial<NavItem>): NavItem =>
  ({
    key: 'x',
    section: 'stock',
    order: 1,
    label: 'nav.stock',
    path: '/x',
    ...overrides,
  }) as NavItem;

describe('the menu items', () => {
  it('has a unique key and address for every page, and a label for every section', () => {
    expect(new Set(NAV_ITEMS.map((item) => item.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((item) => item.path)).size).toBe(NAV_ITEMS.length);
    expect(Object.keys(SECTION_INFO)).toEqual([...SECTION_KEYS]);
  });
});

describe('allows', () => {
  it('needs the permission, any one of a list, and alsoNeeds as well', () => {
    expect(allows(ITEM({ permission: 'inventory:read' }), holding(['inventory:read']))).toBe(true);
    expect(allows(ITEM({ permission: 'inventory:read' }), holding([]))).toBe(false);
    const anyOf = ITEM({ permission: ['catalog:manage', 'parties:manage'] });
    expect(allows(anyOf, holding(['parties:manage']))).toBe(true);
    expect(allows(anyOf, holding(['parties:read']))).toBe(false);
    const margins = ITEM({ permission: 'accounting:export', alsoNeeds: 'costs:read' });
    expect(allows(margins, holding(['accounting:export']))).toBe(false);
    expect(allows(margins, holding(['accounting:export', 'costs:read']))).toBe(true);
  });

  it('lets everyone open a page without a permission', () => {
    expect(allows(ITEM({}), holding([]))).toBe(true);
  });
});

describe('visibleSections', () => {
  it('gives an owner every section, each page as a tab in order', () => {
    expect(menu(role('owner'))).toEqual([
      ['home', ['dashboard', 'inbox']],
      ['newSale', ['pos']],
      ['sales', ['quotations', 'sales-orders', 'invoices', 'notes', 'estimates']],
      [
        'customers',
        [
          'customers',
          'leads',
          'opportunities',
          'projects',
          'followUps',
          'contracts',
          'creditApprovals',
          'creditRequests',
        ],
      ],
      [
        'money',
        ['receivables', 'collections', 'payments', 'registers', 'accounting', 'paymentLinks'],
      ],
      [
        'stock',
        [
          'products',
          'balances',
          'transfers',
          'stockCounts',
          'lowStock',
          'reorderRules',
          'slowMovers',
          'mistints',
        ],
      ],
      [
        'buy',
        [
          'purchaseOrders',
          'goodsReceipts',
          'suppliers',
          'brandSchemes',
          'schemeClaims',
          'brandStatements',
          'priceHike',
        ],
      ],
      ['reports', ['reports', 'brandProfitability']],
      [
        'settings',
        [
          'storeSettings',
          'tax',
          'invoicePrint',
          'tinting',
          'appearance',
          'stockAlerts',
          'goLive',
          'team',
          'support-access',
          'security',
          'creditRules',
          'loyalty',
          'painterPoints',
          'messageTemplates',
          'paymentLinkSettings',
          'billing',
          'imports',
          'documents',
        ],
      ],
    ]);
    expect(menu(role('org_admin'))).toEqual(menu(role('owner')));
  });

  it('keeps every role to nine entries or fewer, Settings included', () => {
    for (const { key } of SYSTEM_ROLES) {
      expect(visibleSections(role(key)).length, key).toBeLessThanOrEqual(9);
    }
  });

  it('shows a branch manager everything but the Tally export, margins and owner settings', () => {
    const sections = new Map(menu(role('branch_manager')) as [string, string[]][]);
    expect([...sections.keys()]).toEqual([...SECTION_KEYS]);
    expect(sections.get('money')).toEqual([
      'receivables',
      'collections',
      'payments',
      'registers',
      'paymentLinks',
    ]);
    expect(sections.get('reports')).toEqual(['reports']);
    expect(sections.get('settings')).toEqual([
      'team',
      'security',
      'loyalty',
      'painterPoints',
      'imports',
      'documents',
    ]);
  });

  it('shows a sales executive selling, customers and stock, but not buying', () => {
    expect(menu(role('sales_executive')).map(([key]) => key)).toEqual([
      'home',
      'newSale',
      'sales',
      'customers',
      'money',
      'stock',
      'reports',
      'settings',
    ]);
  });

  it('shows a CRM executive customers, products and reports only', () => {
    expect(menu(role('crm_executive'))).toEqual([
      ['home', ['dashboard', 'inbox']],
      [
        'customers',
        [
          'customers',
          'leads',
          'opportunities',
          'projects',
          'followUps',
          'contracts',
          'creditApprovals',
          'creditRequests',
        ],
      ],
      ['stock', ['products']],
      ['reports', ['reports']],
      ['settings', ['security', 'loyalty', 'painterPoints', 'imports', 'documents']],
    ]);
  });

  it('gives an inventory manager stock and buying, and no Sales or Money', () => {
    expect(menu(role('inventory_manager')).map(([key]) => key)).toEqual([
      'home',
      'customers',
      'stock',
      'buy',
      'reports',
      'settings',
    ]);
  });

  it('follows a member’s own exceptions to their role', () => {
    const manager = SYSTEM_ROLES.find((candidate) => candidate.key === 'inventory_manager');
    const can = holding(
      effectivePermissions(manager?.permissions ?? [], {
        granted: ['sales:read'],
        denied: ['purchasing:read', 'costs:read'],
      }),
    );
    const keys = menu(can).map(([key]) => key);
    expect(keys).toContain('sales');
    expect(keys).not.toContain('buy');
  });

  it('leaves out a section with no page the member may open', () => {
    // Everyone has an inbox (their follow-ups at least) and account security.
    expect(menu(holding([]))).toEqual([
      ['home', ['inbox']],
      ['settings', ['security']],
    ]);
    expect(visibleNav(holding(['leads:read'])).map((item) => item.key)).toEqual([
      'inbox',
      'leads',
      'opportunities',
      'followUps',
      'reports',
      'security',
      'documents',
    ]);
  });
});

describe('pageAt and sectionAt', () => {
  const pages = visibleNav(() => true);
  const at = (pathname: string) => pageAt(pathname, pages)?.key;

  it('finds the page for its own address and the records under it', () => {
    expect(at('/stock')).toBe('balances');
    expect(at('/stock/movements/new')).toBe('balances');
    expect(at('/stock/reorder-rules/suggestions')).toBe('reorderRules');
    expect(at('/invoices/i1')).toBe('invoices');
    expect(at('/parties/p1/statement')).toBe('customers');
  });

  it('prefers the longest match, and only on whole path segments', () => {
    expect(at('/brand-schemes/price-hike')).toBe('priceHike');
    expect(at('/brand-schemes/claims')).toBe('schemeClaims');
    expect(at('/brand-schemes/b1')).toBe('brandSchemes');
    expect(at('/reports/brand-profitability')).toBe('brandProfitability');
    expect(at('/reports/stock-value')).toBe('reports');
    expect(at('/stock-counts/c1')).toBe('stockCounts');
  });

  it('counts the addresses a page owns', () => {
    expect(at('/accounting/ledgers')).toBe('accounting');
    expect(at('/activities')).toBe('followUps');
    expect(at('/site-accounts/s1')).toBe('customers');
    expect(at('/billing/checkout/c1')).toBe('billing');
  });

  it('highlights Settings on the Settings page, and nothing elsewhere', () => {
    expect(sectionAt('/settings', pages)).toBe('settings');
    expect(sectionAt('/settings/tax', pages)).toBe('settings');
    expect(sectionAt('/print-preview', pages)).toBeUndefined();
    expect(sectionAt('/invoices/i1', pages)).toBe('sales');
  });
});

describe('sectionTarget', () => {
  const section = found(
    visibleSections(holding(['inventory:read'])).find((entry) => entry.key === 'stock'),
  );

  it('opens the last tab used, if the member may still see it, else the first', () => {
    expect(sectionTarget(section, {})).toBe('/stock');
    expect(sectionTarget(section, { stock: '/stock/low' })).toBe('/stock/low');
    expect(sectionTarget(section, { stock: '/products' })).toBe('/stock');
  });

  it('opens the Settings page for Settings', () => {
    const settings = found(visibleSections(holding([])).find((entry) => entry.key === 'settings'));
    expect(sectionTarget(settings, { settings: '/settings/security' })).toBe('/settings');
  });
});

describe('phoneBar', () => {
  const keys = (sections: readonly Section[]) => sections.map((section) => section.key);

  it('shows Home, New sale, Customers and Stock, the rest under "More"', () => {
    const { bar, more } = phoneBar(visibleSections(role('owner')));
    expect(keys(bar)).toEqual(['home', 'newSale', 'customers', 'stock']);
    expect(keys(more)).toEqual(['sales', 'money', 'buy', 'reports', 'settings']);
  });

  it('fills the gaps with the next sections, never with Settings', () => {
    const { bar, more } = phoneBar(visibleSections(role('inventory_manager')));
    expect(keys(bar)).toEqual(['home', 'customers', 'stock', 'buy']);
    expect(keys(more)).toEqual(['reports', 'settings']);
    expect(keys(phoneBar(visibleSections(holding([]))).bar)).toEqual(['home']);
  });
});

describe('the last tab per section', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('remembers one tab per section on this device', () => {
    expect(readLastTabs()).toEqual({});
    rememberTab('stock', '/stock/low');
    rememberTab('buy', '/suppliers');
    rememberTab('stock', '/transfers');
    expect(readLastTabs()).toEqual({ stock: '/transfers', buy: '/suppliers' });
  });

  it('reads damaged or blocked storage as nothing, and ignores a failed write', () => {
    localStorage.setItem(LAST_TABS_KEY, '{not json');
    expect(readLastTabs()).toEqual({});
    localStorage.setItem(LAST_TABS_KEY, 'null');
    expect(readLastTabs()).toEqual({});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => {
      rememberTab('stock', '/stock/low');
    }).not.toThrow();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readLastTabs()).toEqual({});
  });
});
