import { buildCatalogue, BRAND_NAMES, type BrandName, type ProductPlan } from './catalogue.js';
import {
  ANDHRA_PRADESH,
  gstinFor,
  LOCALITIES,
  panFor,
  personName,
  PhoneBook,
  STREETS,
  type Locality,
  type PanHolder,
  TELANGANA,
} from './identity.js';
import { Random } from './random.js';

/** Fixed, so the demo business is identical every time it is created. */
export const DEMO_SEED = 20_261_004;

export const DEMO_BUSINESS = 'Sharma Paints & Hardware';
export const DEMO_APP_NAME = 'Sharma Paints';
/** The demo business's sign-in link name: its branded sign-in page is /sign-in?b=sharma-paints. */
export const DEMO_SLUG = 'sharma-paints';
/** Every demo account with a password uses this one. */
export const DEMO_PASSWORD = 'Demo@2026';

/**
 * A fixed authenticator secret (base32) for the demo admin who shows two-factor
 * sign-in, so it can be added to a phone once and keeps working after a reset.
 */
export const DEMO_TOTP_SECRET = 'SHARMAPAINTSDEMOTOTPHYDERABADXYZ';

/**
 * The demo's platform operator, who signs in to the console at /platform. Like
 * the demo admin, their authenticator uses a fixed secret (base32), so a phone
 * set up once keeps working after a reset. Real operators are created with the
 * API's one-time bootstrap token and add their own app at first sign-in.
 */
export const DEMO_OPERATOR = {
  fullName: 'Meera Iyer',
  email: 'operator@paintretail.demo',
} as const;
export const DEMO_OPERATOR_TOTP_SECRET = 'PAINTRETAILDEMOPLATFORMOPERATOR2';

/**
 * `full` for client demos, `small` for quick tests, and `large`: the full demo
 * plus a large shop's volume in bulk (large-plan.ts), for performance testing.
 */
export type DemoSize = 'full' | 'small' | 'large';
export const DEMO_SIZES: readonly DemoSize[] = ['full', 'small', 'large'];
/** The story the seed plays day by day: the large shop plays the full one. */
export type StorySize = Exclude<DemoSize, 'large'>;

export type StoreKey = 'AMP' | 'KPL' | 'SEC';
export const STORE_KEYS: readonly StoreKey[] = ['AMP', 'KPL', 'SEC'];

export interface StorePlan {
  readonly key: StoreKey;
  readonly name: string;
  readonly code: StoreKey;
  readonly city: 'Hyderabad';
  readonly state: 'Telangana';
  /** GST state code of the registration; all three branches are in Telangana. */
  readonly stateCode: typeof TELANGANA;
  readonly gstin: string;
  readonly locality: Locality;
}

export type RoleKey =
  | 'owner'
  | 'org_admin'
  | 'branch_manager'
  | 'inventory_manager'
  | 'sales_executive'
  | 'crm_executive'
  | 'store_employee';

export interface TeamMemberPlan {
  /** How the seed refers to this person. */
  readonly key: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly roleKey: RoleKey;
  /** Stores the person works at; owners and admins see every store. */
  readonly stores: readonly StoreKey[];
  readonly allStores: boolean;
  /** False for counter staff, who sign in with a code texted to their mobile. */
  readonly hasPassword: boolean;
  /** Signs in with an authenticator app (the fixed demo secret). */
  readonly twoFactor: boolean;
}

/** The owner, who signs the business up. Names and mobiles are fixed so the sign-in sheet never changes. */
export const OWNER: TeamMemberPlan = member('owner', 'Rajesh Sharma', '9000000001', 'owner', [], {
  email: 'rajesh@sharmapaints.example',
});

/** Everyone else on the team. */
export const TEAM: readonly TeamMemberPlan[] = [
  member('admin', 'Priya Sharma', '9000000002', 'org_admin', [], {
    email: 'priya@sharmapaints.example',
  }),
  member('secureAdmin', 'Vikram Rao', '9000000003', 'org_admin', [], { twoFactor: true }),
  member('inventory', 'Mohammed Imran', '9000000004', 'inventory_manager', ['AMP', 'KPL', 'SEC']),
  member('managerAmp', 'Srinivas Goud', '9000000011', 'branch_manager', ['AMP']),
  member('managerKpl', 'Lakshmi Naidu', '9000000012', 'branch_manager', ['KPL']),
  member('managerSec', 'Arjun Mehta', '9000000013', 'branch_manager', ['SEC']),
  member('salesAmp', 'Kiran Kumar', '9000000021', 'sales_executive', ['AMP', 'KPL']),
  member('salesSec', 'Anjali Verma', '9000000022', 'sales_executive', ['SEC']),
  member('crm', 'Neha Kapoor', '9000000031', 'crm_executive', ['AMP', 'KPL', 'SEC']),
  member('counterAmp', 'Ravi Teja', '9000000041', 'store_employee', ['AMP'], { password: false }),
  member('counterKpl', 'Suresh Yadav', '9000000042', 'store_employee', ['KPL'], {
    password: false,
  }),
  member('counterSec', 'Farhan Ali', '9000000043', 'store_employee', ['SEC'], { password: false }),
];

function member(
  key: string,
  fullName: string,
  mobile: string,
  roleKey: RoleKey,
  stores: StoreKey[],
  options: { email?: string; password?: boolean; twoFactor?: boolean } = {},
): TeamMemberPlan {
  const allStores = roleKey === 'owner' || roleKey === 'org_admin';
  return {
    key,
    fullName,
    phone: `+91${mobile}`,
    email: options.email ?? null,
    roleKey,
    stores,
    allStores,
    hasPassword: options.password ?? true,
    twoFactor: options.twoFactor ?? false,
  };
}

export type CustomerType = 'retail' | 'contractor' | 'painter' | 'dealer' | 'builder' | 'corporate';
export type PartyRole =
  'customer' | 'contractor' | 'painter' | 'architect' | 'dealer' | 'supplier' | 'sub_dealer';
export type Segment =
  'retail' | 'painter' | 'contractor' | 'architect' | 'builder' | 'dealer' | 'supplier';

export interface PartyPlan {
  readonly key: string;
  readonly segment: Segment;
  readonly kind: 'person' | 'organization';
  readonly displayName: string;
  readonly legalName: string | null;
  readonly contactPerson: string | null;
  readonly phone: string;
  readonly alternatePhone: string | null;
  readonly email: string | null;
  readonly gstin: string | null;
  readonly addressLine: string;
  readonly city: string;
  /** GST state code of the party's state (its place of supply). */
  readonly stateCode: string;
  readonly pincode: string;
  /** Null for business-wide parties (suppliers, architects). */
  readonly homeStore: StoreKey | null;
  readonly roles: readonly PartyRole[];
  readonly customerType: CustomerType | null;
  readonly tags: readonly string[];
  /** The brand a distributor supplies. */
  readonly brand: BrandName | null;
  /** Set on a near-duplicate: the key of the party it duplicates. */
  readonly duplicateOf: string | null;
}

/** How many parties of each kind the demo has. */
export const SEGMENT_COUNTS: Readonly<Record<StorySize, Readonly<Record<Segment, number>>>> = {
  full: {
    retail: 30,
    painter: 16,
    contractor: 12,
    architect: 6,
    builder: 6,
    dealer: 6,
    supplier: 6,
  },
  small: { retail: 6, painter: 4, contractor: 3, architect: 2, builder: 2, dealer: 2, supplier: 6 },
};

const BUILDERS = [
  'Lotus Ridge Developers',
  'Sunrise Infra Projects',
  'Pearl City Builders',
  'Deccan Heights Constructions',
  'Golconda Estates',
  'Banyan Tree Homes',
] as const;
const CONTRACTOR_STYLES = ['Constructions', 'Painting Works', 'Interiors', 'Builders & Painters'];
const DEALER_STYLES = ['Paint House', 'Hardware & Paints', 'Colour World', 'Paints & Sanitary'];
const DISTRIBUTORS: Readonly<Record<BrandName, string>> = {
  'Asian Paints': 'Sri Venkateswara Agencies',
  Berger: 'Deccan Colour Distributors',
  Nerolac: 'Bhagyanagar Paint Traders',
  Dulux: 'Hitech City Paint Distributors',
  Indigo: 'Golkonda Trading Company',
  'Birla Opus': 'Musi Valley Distributors',
};

export interface DemoPlan {
  readonly size: StorySize;
  readonly stores: readonly StorePlan[];
  readonly owner: TeamMemberPlan;
  /** The team besides the owner. */
  readonly team: readonly TeamMemberPlan[];
  readonly catalogue: readonly ProductPlan[];
  readonly parties: readonly PartyPlan[];
  /** How many days back the history goes. */
  readonly historyDays: number;
}

/** Everything about the demo business that does not depend on the database. */
export function buildPlan(size: StorySize, seed = DEMO_SEED): DemoPlan {
  const random = new Random(seed);
  const phones = new PhoneBook(random);
  const businessPan = panFor(random, 'Sharma', 'F');
  const stores: StorePlan[] = (
    [
      ['AMP', 'Ameerpet', LOCALITIES[0]],
      ['KPL', 'Kukatpally', LOCALITIES[7]],
      ['SEC', 'Secunderabad', LOCALITIES[11]],
    ] as const
  ).map(([key, name, locality]) => ({
    key,
    name,
    code: key,
    city: 'Hyderabad',
    state: 'Telangana',
    stateCode: TELANGANA,
    // Branches in one state share the business's GSTIN (one registration per state).
    gstin: gstinFor(businessPan),
    locality,
  }));
  const catalogue = buildCatalogue(random, size === 'full' ? 1 : 4);
  const parties = buildParties(random, phones, SEGMENT_COUNTS[size]).map(acrossTheBorder);
  return {
    size,
    stores,
    owner: OWNER,
    team: TEAM,
    catalogue,
    parties,
    historyDays: size === 'full' ? 60 : 20,
  };
}

/**
 * Two customers in Andhra Pradesh, so the demo has inter-state sales: a builder
 * registered there (its GSTIN moves to state 37) and a retail customer without one.
 */
const ANDHRA_CUSTOMERS: Readonly<
  Record<string, Pick<PartyPlan, 'city' | 'pincode' | 'addressLine'>>
> = {
  'builder-1': {
    city: 'Vijayawada',
    pincode: '520010',
    addressLine: '40-1-52, MG Road, Benz Circle',
  },
  'retail-1': { city: 'Guntur', pincode: '522002', addressLine: '7-12-3, Brodipet' },
};

function acrossTheBorder(party: PartyPlan): PartyPlan {
  const address = ANDHRA_CUSTOMERS[party.key];
  if (!address) return party;
  return {
    ...party,
    ...address,
    stateCode: ANDHRA_PRADESH,
    gstin: party.gstin === null ? null : gstinFor(party.gstin.slice(2, 12), 1, ANDHRA_PRADESH),
  };
}

/** "Venkat Reddy" -> "Reddy". */
export function surname(name: string): string {
  return name.slice(name.lastIndexOf(' ') + 1);
}

/** The store whose area is nearest a locality (by where it sits in the list). */
export function nearestStore(locality: Locality): StoreKey {
  const index = LOCALITIES.indexOf(locality);
  if (index < 7) return 'AMP';
  return index < 11 ? 'KPL' : 'SEC';
}

function buildParties(
  random: Random,
  phones: PhoneBook,
  counts: Readonly<Record<Segment, number>>,
): PartyPlan[] {
  const usedNames = new Set<string>();
  const uniqueName = (make: () => string) => {
    for (;;) {
      const name = make();
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
  };
  const parties: PartyPlan[] = [];
  const add = (
    segment: Segment,
    index: number,
    fields: Partial<PartyPlan> & Pick<PartyPlan, 'displayName' | 'kind' | 'roles'>,
    holder: PanHolder | null,
  ) => {
    const locality = random.pick(LOCALITIES);
    const gstin = holder === null ? null : gstinFor(panFor(random, fields.displayName, holder));
    parties.push({
      key: `${segment}-${String(index + 1)}`,
      segment,
      legalName: null,
      contactPerson: null,
      phone: phones.next(),
      alternatePhone: null,
      email: null,
      gstin,
      addressLine: `${String(random.int(1, 999))}-${String(random.int(1, 99))}, ${random.pick(STREETS)}, ${locality.area}`,
      city: 'Hyderabad',
      stateCode: TELANGANA,
      pincode: locality.pincode,
      homeStore: nearestStore(locality),
      customerType: null,
      tags: [],
      brand: null,
      duplicateOf: null,
      ...fields,
    });
  };

  for (let index = 0; index < counts.retail; index++) {
    const displayName = uniqueName(() => personName(random));
    add(
      'retail',
      index,
      {
        kind: 'person',
        displayName,
        roles: ['customer'],
        customerType: 'retail',
        tags: random.chance(0.3) ? ['repeat'] : [],
      },
      null,
    );
  }
  for (let index = 0; index < counts.painter; index++) {
    const displayName = uniqueName(() => personName(random));
    add(
      'painter',
      index,
      {
        kind: 'person',
        displayName,
        roles: ['painter', 'customer'],
        customerType: 'painter',
        tags: ['loyalty'],
      },
      null,
    );
  }
  for (let index = 0; index < counts.contractor; index++) {
    const owner = personName(random);
    const displayName = uniqueName(
      () =>
        `${random.pick(['Sri Sai', 'Sri Lakshmi', 'Balaji', surname(owner)])} ${random.pick(CONTRACTOR_STYLES)}`,
    );
    const registered = index % 3 !== 2;
    add(
      'contractor',
      index,
      {
        kind: 'organization',
        displayName,
        legalName: registered ? `${displayName} Private Limited` : null,
        contactPerson: owner,
        roles: ['contractor', 'customer'],
        customerType: 'contractor',
        tags: ['credit'],
      },
      registered ? 'C' : null,
    );
  }
  for (let index = 0; index < counts.architect; index++) {
    const architect = uniqueName(() => personName(random));
    const studio = index % 2 === 0;
    add(
      'architect',
      index,
      {
        kind: studio ? 'organization' : 'person',
        displayName: studio ? `Studio ${surname(architect)} Architects` : `Ar. ${architect}`,
        contactPerson: studio ? `Ar. ${architect}` : null,
        roles: ['architect'],
        homeStore: null,
        tags: ['influencer'],
      },
      studio ? 'F' : null,
    );
  }
  BUILDERS.slice(0, counts.builder).forEach((displayName, index) => {
    add(
      'builder',
      index,
      {
        kind: 'organization',
        displayName,
        legalName: `${displayName} LLP`,
        contactPerson: personName(random),
        roles: ['customer'],
        customerType: 'builder',
        tags: ['project'],
      },
      'C',
    );
  });
  for (let index = 0; index < counts.dealer; index++) {
    const locality = random.pick(LOCALITIES);
    const displayName = uniqueName(() => `${locality.area} ${random.pick(DEALER_STYLES)}`);
    add(
      'dealer',
      index,
      {
        kind: 'organization',
        displayName,
        contactPerson: personName(random),
        roles: index % 2 === 0 ? ['dealer', 'customer'] : ['sub_dealer', 'customer'],
        customerType: 'dealer',
      },
      'F',
    );
  }
  BRAND_NAMES.slice(0, counts.supplier).forEach((brand, index) => {
    const displayName = DISTRIBUTORS[brand];
    add(
      'supplier',
      index,
      {
        kind: 'organization',
        displayName,
        legalName: `${displayName} Private Limited`,
        contactPerson: personName(random),
        roles: ['supplier'],
        homeStore: null,
        brand,
        tags: ['distributor'],
      },
      'C',
    );
  });

  // Two near-duplicates, the way they creep in at a busy counter: the same
  // painter entered again under another number, and a contractor without its GSTIN.
  const originals = parties.filter(
    (party) => party.key === 'painter-1' || party.key === 'contractor-1',
  );
  for (const original of originals) {
    parties.push({
      ...original,
      key: `${original.key}-duplicate`,
      displayName:
        original.kind === 'person'
          ? `${original.displayName} (Painter)`
          : original.displayName.replace(/s$/, ''),
      phone: phones.next(),
      alternatePhone: original.phone,
      gstin: null,
      legalName: null,
      tags: [],
      duplicateOf: original.key,
    });
  }
  return parties;
}
