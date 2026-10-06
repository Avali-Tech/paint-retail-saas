import type { Lead, Opportunity } from '../../api/leads.js';
import type { Party } from '../../api/parties.js';
import type { Project } from '../../api/projects.js';
import type { Activity } from '../../api/record-activities.js';
import type { Member } from '../../api/team.js';
import type { Profile } from '../../api/types.js';
import { OWNER, json, type FakeHandler } from '../../test-support/fake-api.js';
import { STORES, page } from '../../test-support/inventory-fixtures.js';

// Leads, opportunities, projects and activities for component tests.

const hyd = { id: 'store-hyd', code: 'HYD', name: 'Hyderabad' };
const anil = { memberId: 'member-1', name: 'Anil Kumar' };

export const lead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'lead-1',
  number: 'LD-000001',
  store: hyd,
  party: { id: 'party-1', name: 'Apex Builders', phone: '+919876543210' },
  title: 'Repaint 4-floor office',
  requirement: 'Exterior emulsion, about 2,000 litres',
  source: 'walk_in',
  referredBy: null,
  estimatedValuePaise: 85_000_000,
  expectedOrderDate: '2026-11-15',
  assignedTo: anil,
  stage: 'new',
  lostReason: null,
  opportunityId: null,
  createdAt: '2026-10-01T05:00:00.000Z',
  updatedAt: '2026-10-02T05:00:00.000Z',
  closedAt: null,
  ...overrides,
});

export const opportunity = (overrides: Partial<Opportunity> = {}): Opportunity => ({
  id: 'opp-1',
  number: 'OP-000001',
  store: hyd,
  party: { id: 'party-1', name: 'Apex Builders', phone: '+919876543210' },
  lead: { id: 'lead-1', number: 'LD-000001' },
  project: null,
  title: 'Repaint 4-floor office',
  expectedValuePaise: 85_000_000,
  weightedValuePaise: 17_000_000,
  expectedQuantity: null,
  expectedOrderDate: '2026-11-15',
  category: { id: 'cat-1', name: 'Exterior emulsions' },
  salesperson: anil,
  probability: 20,
  stage: 'discovery',
  lostReason: null,
  createdAt: '2026-10-01T05:00:00.000Z',
  updatedAt: '2026-10-02T05:00:00.000Z',
  closedAt: null,
  ...overrides,
});

export const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  number: 'PJ-000001',
  store: hyd,
  name: 'Jubilee Hills villa',
  customer: { id: 'party-1', name: 'Apex Builders', phone: '+919876543210' },
  opportunity: { id: 'opp-1', number: 'OP-000001' },
  site: {
    addressLine: 'Plot 12, Road 36',
    city: 'Hyderabad',
    state: 'Telangana',
    pincode: '500033',
    latitude: 17.43,
    longitude: 78.41,
  },
  startDate: '2026-10-10',
  expectedCompletionDate: '2026-12-10',
  estimatedAreaSqFt: 12_500,
  estimatedPaintLitres: 900,
  expectedOrderValuePaise: 45_000_000,
  stage: 'survey',
  cancelReason: null,
  notes: 'Gate code 4411',
  assignedTo: anil,
  parties: [
    { partyId: 'party-2', role: 'architect', name: 'Ritu Architects', phone: '+919811111111' },
    { partyId: 'party-3', role: 'painter', name: 'Raju Painter', phone: null },
  ],
  createdAt: '2026-10-01T05:00:00.000Z',
  updatedAt: '2026-10-02T05:00:00.000Z',
  closedAt: null,
  ...overrides,
});

export const activity = (overrides: Partial<Activity> = {}): Activity => ({
  id: 'activity-1',
  record: { type: 'lead', id: 'lead-1', label: 'LD-000001' },
  type: 'call',
  subject: 'Discussed shades',
  notes: null,
  outcome: null,
  status: 'done',
  dueAt: null,
  overdue: false,
  completedAt: '2026-10-02T06:00:00.000Z',
  cancelledAt: null,
  assignedTo: anil,
  createdBy: anil,
  createdAt: '2026-10-02T06:00:00.000Z',
  ...overrides,
});

const member = (id: string, fullName: string, role: string, isActive = true): Member => ({
  id,
  user: { id: `user-${id}`, fullName, phone: null, email: null },
  role: { id: `role-${role}`, key: role, name: role === 'owner' ? 'Owner' : 'Sales Executive' },
  allStores: role === 'owner',
  storeIds: role === 'owner' ? [] : ['store-hyd'],
  isActive,
  twoFactorEnabled: false,
});

export const MEMBERS: Member[] = [
  member('member-1', 'Anil Kumar', 'owner'),
  member('member-2', 'Sita Sales', 'sales_executive'),
  member('member-3', 'Old Hand', 'sales_executive', false),
];

export const party = (overrides: Partial<Party> = {}): Party => ({
  id: 'party-9',
  kind: 'person',
  displayName: 'Meera Reddy',
  legalName: null,
  contactPerson: null,
  phone: '+919822222222',
  alternatePhone: null,
  email: null,
  gstin: null,
  pan: null,
  addressLine: null,
  city: 'Hyderabad',
  state: null,
  pincode: null,
  homeStoreId: null,
  notes: null,
  tags: [],
  isActive: true,
  mergedIntoId: null,
  roles: ['customer'],
  customer: null,
  ...overrides,
});

/** Who looks at a record page, its timeline and extra API routes. */
export interface RecordOptions {
  readonly member?: Profile;
  readonly activities?: Activity[];
  readonly routes?: Record<string, FakeHandler>;
}

/** What every CRM screen loads besides its records: the member, stores, team and timelines. */
export function crmRoutes(
  member = OWNER,
  activities: Activity[] = [],
): Record<string, FakeHandler> {
  return {
    'GET /auth/me': () => json(member),
    'GET /stores': () => json(STORES),
    'GET /members': () => json(MEMBERS),
    'GET /activities': () => json(page(activities)),
    'GET /documents': () => json([]),
  };
}

/** The body of the first request matching the method and path. */
export const sent = (
  requests: readonly { method: string; path: string; body: unknown }[],
  method: string,
  path: string,
) => requests.find((request) => request.method === method && request.path === path)?.body;
