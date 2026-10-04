import type { Segment } from './plan.js';

/** Where a lead ends up in the demo. */
export type LeadOutcome =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'lost'
  | 'won'
  | 'discovery'
  | 'proposal'
  | 'negotiation'
  | 'opportunity_won'
  | 'opportunity_lost';

export interface LeadStory {
  readonly title: string;
  readonly requirement: string;
  readonly source:
    | 'walk_in'
    | 'phone_call'
    | 'referral'
    | 'architect'
    | 'contractor'
    | 'painter'
    | 'website'
    | 'social_media'
    | 'exhibition';
  readonly rupees: number;
  /** The customer: a segment and its position (wraps around in the small demo). */
  readonly party: readonly [Segment, number];
  readonly outcome: LeadOutcome;
  /** How far back it started, as a share of the history. */
  readonly started: number;
  /** A won opportunity that becomes this project. */
  readonly project?: string;
}

/**
 * Leads through every stage, in the order the small demo takes them (the
 * first ten cover every outcome).
 */
export const LEADS: readonly LeadStory[] = [
  {
    title: 'Villa repaint, Jubilee Hills',
    requirement: 'Full interior and exterior repaint of a 4,500 sq ft villa; premium emulsions.',
    source: 'architect',
    rupees: 450_000,
    party: ['retail', 0],
    outcome: 'opportunity_won',
    started: 0.95,
    project: 'Villa repaint, Jubilee Hills',
  },
  {
    title: 'Apartment exterior, Kondapur (Block C)',
    requirement: '14-floor block, weatherproof exterior with 7-year warranty.',
    source: 'contractor',
    rupees: 1_200_000,
    party: ['builder', 0],
    outcome: 'negotiation',
    started: 0.8,
  },
  {
    title: 'Office interiors, Madhapur',
    requirement: '22,000 sq ft office floor, low-VOC washable emulsion.',
    source: 'website',
    rupees: 320_000,
    party: ['builder', 1],
    outcome: 'proposal',
    started: 0.6,
  },
  {
    title: 'School repaint, Malkajgiri',
    requirement: 'Classrooms and corridors during the summer break.',
    source: 'phone_call',
    rupees: 280_000,
    party: ['contractor', 1],
    outcome: 'discovery',
    started: 0.35,
  },
  {
    title: 'Hospital waterproofing, Secunderabad',
    requirement: 'Terrace and basement waterproofing, 9,000 sq ft.',
    source: 'referral',
    rupees: 650_000,
    party: ['contractor', 2],
    outcome: 'opportunity_lost',
    started: 0.9,
  },
  {
    title: 'Duplex repaint, Sainikpuri',
    requirement: 'Interior repaint, 3BHK duplex, light pastel shades.',
    source: 'walk_in',
    rupees: 140_000,
    party: ['retail', 1],
    outcome: 'won',
    started: 0.7,
  },
  {
    title: '2BHK interior repaint, KPHB',
    requirement: 'Budget interior emulsion, owner wants it done before Diwali.',
    source: 'walk_in',
    rupees: 65_000,
    party: ['retail', 2],
    outcome: 'contacted',
    started: 0.12,
  },
  {
    title: 'Showroom facade, Ameerpet',
    requirement: 'Textured exterior finish for a jewellery showroom.',
    source: 'social_media',
    rupees: 180_000,
    party: ['retail', 3],
    outcome: 'qualified',
    started: 0.25,
  },
  {
    title: 'Temple repaint, Tarnaka',
    requirement: 'Exterior enamel and emulsion for the temple compound.',
    source: 'referral',
    rupees: 220_000,
    party: ['retail', 4],
    outcome: 'new',
    started: 0.05,
  },
  {
    title: 'Rental flat refresh, Begumpet',
    requirement: 'Quick repaint between tenants.',
    source: 'phone_call',
    rupees: 45_000,
    party: ['retail', 5],
    outcome: 'lost',
    started: 0.5,
  },
  {
    title: 'Gated community, Miyapur (48 villas)',
    requirement: 'Exterior and interior paint for 48 villas over two phases.',
    source: 'exhibition',
    rupees: 3_800_000,
    party: ['builder', 2],
    outcome: 'proposal',
    started: 0.75,
  },
  {
    title: 'Terrace waterproofing, Nizampet',
    requirement: 'Leaking terrace, 1,200 sq ft.',
    source: 'walk_in',
    rupees: 85_000,
    party: ['retail', 6],
    outcome: 'new',
    started: 0.04,
  },
  {
    title: 'Restaurant interiors, Banjara Hills',
    requirement: 'Designer finishes and wood polish for a new restaurant.',
    source: 'architect',
    rupees: 260_000,
    party: ['contractor', 3],
    outcome: 'contacted',
    started: 0.15,
  },
  {
    title: 'Wood polish for new home, Kompally',
    requirement: 'PU polish for doors, windows and wardrobes.',
    source: 'painter',
    rupees: 70_000,
    party: ['retail', 7],
    outcome: 'qualified',
    started: 0.3,
  },
  {
    title: 'Commercial complex, Gachibowli',
    requirement: 'Exterior emulsion and primer for a 6-floor complex.',
    source: 'contractor',
    rupees: 2_200_000,
    party: ['builder', 3],
    outcome: 'discovery',
    started: 0.4,
  },
  {
    title: 'PG hostel repaint, Kukatpally',
    requirement: '30 rooms, economy emulsion, fast turnaround.',
    source: 'walk_in',
    rupees: 110_000,
    party: ['retail', 8],
    outcome: 'new',
    started: 0.08,
  },
  {
    title: 'Bungalow new build, Banjara Hills',
    requirement: 'New construction, complete paint system from putty to top coat.',
    source: 'architect',
    rupees: 950_000,
    party: ['builder', 4],
    outcome: 'opportunity_won',
    started: 0.85,
    project: 'Bungalow new build, Banjara Hills',
  },
  {
    title: 'Clinic repaint, Marredpally',
    requirement: 'Anti-bacterial interior emulsion.',
    source: 'website',
    rupees: 55_000,
    party: ['retail', 9],
    outcome: 'contacted',
    started: 0.2,
  },
  {
    title: 'Factory floor coating, Bowenpally',
    requirement: 'Epoxy floor coating, 15,000 sq ft.',
    source: 'phone_call',
    rupees: 400_000,
    party: ['contractor', 4],
    outcome: 'lost',
    started: 0.65,
  },
  {
    title: 'Independent house exterior, Malkajgiri',
    requirement: 'Exterior repaint with crack filling.',
    source: 'painter',
    rupees: 160_000,
    party: ['retail', 10],
    outcome: 'qualified',
    started: 0.22,
  },
  {
    title: 'Kids room makeover, Gachibowli',
    requirement: 'Washable emulsion with a feature wall.',
    source: 'social_media',
    rupees: 35_000,
    party: ['retail', 11],
    outcome: 'won',
    started: 0.45,
  },
];

export const LOST_REASONS = [
  'Went with another dealer offering a lower price',
  'Owner postponed the work to next year',
  'Chose a cheaper waterproofing brand',
];

export type ProjectStage =
  | 'identified'
  | 'survey'
  | 'specification'
  | 'quotation'
  | 'negotiation'
  | 'order'
  | 'execution'
  | 'completed';
export const WORK_STAGES: readonly ProjectStage[] = [
  'identified',
  'survey',
  'specification',
  'quotation',
  'negotiation',
  'order',
  'execution',
  'completed',
];

export interface ProjectStory {
  readonly name: string;
  readonly customer: readonly [Segment, number];
  /** Architects, contractors, painters and dealers on the job. */
  readonly team: readonly (readonly ['architect' | 'contractor' | 'painter' | 'dealer', number])[];
  readonly stage: ProjectStage | 'cancelled';
  readonly area: string;
  readonly pincode: string;
  readonly sqft: number;
  readonly rupees: number;
  readonly started: number;
}

/** Projects started directly (two more come from won opportunities). */
export const PROJECTS: readonly ProjectStory[] = [
  {
    name: 'Lotus Ridge Phase 2, Kokapet',
    customer: ['builder', 0],
    team: [
      ['architect', 2],
      ['contractor', 3],
      ['dealer', 0],
    ],
    stage: 'quotation',
    area: 'Kokapet',
    pincode: '500075',
    sqft: 85_000,
    rupees: 2_400_000,
    started: 0.8,
  },
  {
    name: 'Row houses, Kompally (12 units)',
    customer: ['builder', 3],
    team: [
      ['contractor', 0],
      ['painter', 3],
      ['painter', 4],
    ],
    stage: 'completed',
    area: 'Kompally',
    pincode: '500014',
    sqft: 30_000,
    rupees: 780_000,
    started: 0.95,
  },
  {
    name: 'Mall food court, Kukatpally',
    customer: ['builder', 4],
    team: [['contractor', 5]],
    stage: 'cancelled',
    area: 'Kukatpally',
    pincode: '500072',
    sqft: 12_000,
    rupees: 350_000,
    started: 0.6,
  },
  {
    name: 'Pearl City Towers, Miyapur',
    customer: ['builder', 2],
    team: [
      ['contractor', 4],
      ['painter', 2],
    ],
    stage: 'order',
    area: 'Miyapur',
    pincode: '500049',
    sqft: 120_000,
    rupees: 3_100_000,
    started: 0.9,
  },
  {
    name: 'Heritage bungalow restoration, Secunderabad',
    customer: ['retail', 12],
    team: [['architect', 3]],
    stage: 'survey',
    area: 'Secunderabad',
    pincode: '500003',
    sqft: 6_500,
    rupees: 420_000,
    started: 0.2,
  },
  {
    name: 'IT office fit-out, Hitech City',
    customer: ['builder', 1],
    team: [['contractor', 5]],
    stage: 'negotiation',
    area: 'Madhapur',
    pincode: '500081',
    sqft: 40_000,
    rupees: 1_150_000,
    started: 0.5,
  },
  {
    name: 'Community hall repaint, Tarnaka',
    customer: ['retail', 13],
    team: [],
    stage: 'identified',
    area: 'Tarnaka',
    pincode: '500017',
    sqft: 5_000,
    rupees: 160_000,
    started: 0.06,
  },
  {
    name: 'Hostel block, Gachibowli',
    customer: ['contractor', 7],
    team: [['painter', 5]],
    stage: 'execution',
    area: 'Gachibowli',
    pincode: '500032',
    sqft: 18_000,
    rupees: 540_000,
    started: 0.7,
  },
];
