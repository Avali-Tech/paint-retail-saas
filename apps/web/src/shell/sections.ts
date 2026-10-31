import type { Permission } from '@paint/shared';
import type { IconName } from '@paint/ui';
import type { MessageKey } from '../i18n/i18n.js';
import { NAV_ITEMS, SECTION_KEYS, SETTINGS_GROUPS, type NavItem, type SectionKey } from './nav.js';

export type Can = (permission: Permission) => boolean;

/** The Settings page, which lists every settings page a member may open. */
export const SETTINGS_PATH = '/settings';

/** How each menu entry reads and looks. */
export const SECTION_INFO: Readonly<
  Record<SectionKey, { readonly label: MessageKey; readonly icon: IconName }>
> = {
  home: { label: 'nav.home', icon: 'dashboard' },
  newSale: { label: 'nav.newSale', icon: 'store' },
  sales: { label: 'nav.sales', icon: 'contracts' },
  customers: { label: 'nav.customers', icon: 'customers' },
  money: { label: 'nav.money', icon: 'money' },
  stock: { label: 'nav.stock', icon: 'stock' },
  buy: { label: 'nav.buy', icon: 'purchasing' },
  reports: { label: 'reports.title', icon: 'reports' },
  settings: { label: 'nav.settings', icon: 'settings' },
};

/** A menu entry the member sees, with the pages (tabs) in it they may open. */
export interface Section {
  readonly key: SectionKey;
  readonly label: MessageKey;
  readonly icon: IconName;
  readonly tabs: readonly [NavItem, ...NavItem[]];
}

/** True when the member may open this page: its permission (or any of them), and `alsoNeeds`. */
export function allows(item: NavItem, can: Can): boolean {
  const { permission, alsoNeeds } = item;
  const held =
    permission === undefined ||
    (typeof permission === 'string' ? can(permission) : permission.some(can));
  return held && (alsoNeeds === undefined || can(alsoNeeds));
}

const place = (item: NavItem) => SECTION_KEYS.indexOf(item.section);
const groupPlace = (item: NavItem) =>
  item.section === 'settings' ? SETTINGS_GROUPS.indexOf(item.group) : 0;

/** The pages a member may open, in menu order: by section (and settings group), then order. */
export function visibleNav(can: Can, items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  return items
    .filter((item) => allows(item, can))
    .sort((a, b) => place(a) - place(b) || groupPlace(a) - groupPlace(b) || a.order - b.order);
}

/** The menu a member sees: every section with at least one page they may open. */
export function visibleSections(can: Can, items: readonly NavItem[] = NAV_ITEMS): Section[] {
  const visible = visibleNav(can, items);
  return SECTION_KEYS.flatMap((key) => {
    const [first, ...rest] = visible.filter((item) => item.section === key);
    return first ? [{ key, ...SECTION_INFO[key], tabs: [first, ...rest] }] : [];
  });
}

const isWithin = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

/**
 * The page an address belongs to: the one whose path, or an address it owns,
 * is the longest start of it. /brand-schemes/price-hike is the planner's, and
 * /brand-schemes/b1 the schemes'.
 */
export function pageAt(pathname: string, items: readonly NavItem[]): NavItem | undefined {
  let best: NavItem | undefined;
  let longest = 0;
  for (const item of items) {
    for (const path of [item.path, ...(item.owns ?? [])]) {
      if (path.length > longest && isWithin(pathname, path)) {
        best = item;
        longest = path.length;
      }
    }
  }
  return best;
}

/** The section to highlight for an address: its page's, or Settings on the Settings page. */
export function sectionAt(pathname: string, items: readonly NavItem[]): SectionKey | undefined {
  return pageAt(pathname, items)?.section ?? (pathname === SETTINGS_PATH ? 'settings' : undefined);
}

/** Where a menu entry leads: the Settings page, the tab last used in it, or its first tab. */
export function sectionTarget(
  section: Section,
  lastTabs: Readonly<Partial<Record<string, string>>>,
): string {
  if (section.key === 'settings') return SETTINGS_PATH;
  const last = section.tabs.find((tab) => tab.path === lastTabs[section.key]);
  return (last ?? section.tabs[0]).path;
}

/** The sections a phone's bottom bar prefers, in order; gaps fill with the next visible ones. */
export const BOTTOM_BAR: readonly SectionKey[] = ['home', 'newSale', 'customers', 'stock'];

/** Splits the menu for a phone: up to four sections in the bottom bar, the rest under "More". */
export function phoneBar(sections: readonly Section[]): {
  readonly bar: Section[];
  readonly more: Section[];
} {
  const candidates = sections.filter((section) => section.key !== 'settings');
  const bar = [
    ...candidates.filter((section) => BOTTOM_BAR.includes(section.key)),
    ...candidates.filter((section) => !BOTTOM_BAR.includes(section.key)),
  ].slice(0, BOTTOM_BAR.length);
  return { bar, more: sections.filter((section) => !bar.includes(section)) };
}
