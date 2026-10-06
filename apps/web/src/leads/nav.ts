import type { SectionLink } from '../lib/SectionNav.js';
import type { NavItem } from '../shell/nav.js';

/** Opportunities, next to leads in the navigation. */
export const CRM_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'opportunities',
    label: 'opportunities.title',
    path: '/opportunities',
    icon: 'leads',
    permission: 'leads:read',
  },
];

/** The screens of the sales section, linked from each of them. */
export const LEAD_SECTIONS: readonly SectionLink[] = [
  { to: '/leads', label: 'leads.sections.list', permission: 'leads:read' },
  { to: '/leads/board', label: 'leads.sections.board', permission: 'leads:read' },
  { to: '/opportunities', label: 'leads.sections.opportunities', permission: 'leads:read' },
];
