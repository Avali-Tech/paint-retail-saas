import type { SectionLink } from '../lib/SectionNav.js';
import type { NavItem } from '../shell/nav.js';

/** Leads and opportunities, in Customers after the customers themselves. */
export const CRM_NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'leads',
    section: 'customers',
    order: 20,
    label: 'nav.leads',
    path: '/leads',
    permission: 'leads:read',
  },
  {
    key: 'opportunities',
    section: 'customers',
    order: 30,
    label: 'opportunities.title',
    path: '/opportunities',
    permission: 'leads:read',
  },
];

/** Two views of the leads, linked from each of them: the list and the pipeline board. */
export const LEAD_SECTIONS: readonly SectionLink[] = [
  { to: '/leads', label: 'leads.sections.list', permission: 'leads:read' },
  { to: '/leads/board', label: 'leads.sections.board', permission: 'leads:read' },
];
