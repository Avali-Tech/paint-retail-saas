import {
  LEADS,
  LOST_REASONS,
  PROJECTS,
  WORK_STAGES,
  type LeadStory,
  type ProjectStage,
} from './crm-story.js';
import { indiaDate } from './history-clock.js';
import { SEGMENT_COUNTS, type Segment, type StoreKey } from './plan.js';
import { must, type SeedContext, type SeededParty, type Timeline } from './seed-context.js';

/** A party by segment and position, wrapping around in the small demo. */
export function partyAt(
  context: SeedContext,
  [segment, index]: readonly [Segment, number],
): SeededParty {
  const count = SEGMENT_COUNTS[context.plan.size][segment];
  return context.party(`${segment}-${String((index % count) + 1)}`);
}

const storeOf = (party: SeededParty): StoreKey =>
  must(party.homeStore, `home store of ${party.key}`);

/** A moment on an India date, e.g. today at 11:30. */
export function indiaMoment(daysAgo: number, time: string): string {
  return `${indiaDate(daysAgo)}T${time}:00+05:30`;
}

interface CrmRecord {
  readonly recordType: 'lead' | 'opportunity' | 'project' | 'party';
  readonly id: string;
  readonly store: StoreKey;
}

/** Records follow-ups can be about, filled in as the story plays. */
const records = new WeakMap<SeedContext, CrmRecord[]>();
const projectIds = new WeakMap<SeedContext, Map<string, string>>();

function remember(context: SeedContext, record: CrmRecord): void {
  const list = records.get(context) ?? [];
  list.push(record);
  records.set(context, list);
}

/** Logs something already done (a call, a visit) on a record, as the assignee. */
async function logActivity(
  context: SeedContext,
  member: string,
  record: CrmRecord,
  type: 'call' | 'meeting' | 'visit' | 'whatsapp' | 'email' | 'note',
  subject: string,
  outcome?: string,
): Promise<void> {
  await context.as(member).post('/activities', {
    recordType: record.recordType,
    recordId: record.id,
    type,
    subject,
    ...(outcome === undefined ? {} : { outcome }),
  });
  context.count('activities');
}

/**
 * Leads from first call to won or lost, opportunities through the pipeline,
 * and two won opportunities turned into projects.
 */
export function scheduleLeads(context: SeedContext, timeline: Timeline): void {
  const leads = context.plan.size === 'full' ? LEADS : LEADS.slice(0, 10);
  leads.forEach((story, index) => {
    scheduleLead(context, timeline, story, index);
  });
}

function scheduleLead(
  context: SeedContext,
  timeline: Timeline,
  story: LeadStory,
  index: number,
): void {
  const start = context.daysAgo(story.started);
  const day = (offset: number) => Math.max(1, start - offset);
  let store: StoreKey = 'AMP';
  let assignee = 'salesAmp';
  let lead: CrmRecord | null = null;
  let opportunity: CrmRecord | null = null;
  const reached = (stage: number) => OUTCOME_DEPTH[story.outcome] >= stage;

  timeline.at(start, async () => {
    const party = partyAt(context, story.party);
    store = storeOf(party);
    assignee = context.salesOf(store);
    const created = await context.as('crm').post('/leads', {
      storeId: context.storeId(store),
      partyId: party.id,
      title: story.title,
      requirement: story.requirement,
      source: story.source,
      estimatedValuePaise: story.rupees * 100,
      expectedOrderDate: indiaDate(-30 - index),
      assignedMemberId: context.memberId(assignee),
    });
    lead = { recordType: 'lead', id: created.id, store };
    remember(context, lead);
    context.count('leads');
    await logActivity(context, 'crm', lead, 'call', 'First call: understood the requirement');
  });
  if (story.outcome === 'new') return;

  timeline.at(day(1), async () => {
    const current = must(lead, 'lead');
    await context.as(assignee).post(`/leads/${current.id}/stage`, { stage: 'contacted' });
    await logActivity(context, assignee, current, 'whatsapp', 'Shared shade card and price list');
  });
  if (story.outcome === 'contacted') return;

  if (story.outcome === 'lost') {
    timeline.at(day(4), async () => {
      const current = must(lead, 'lead');
      await context.as(assignee).post(`/leads/${current.id}/lose`, {
        reason: must(LOST_REASONS[index % LOST_REASONS.length], 'reason'),
      });
    });
    return;
  }

  timeline.at(day(3), async () => {
    const current = must(lead, 'lead');
    await context.as(assignee).post(`/leads/${current.id}/stage`, { stage: 'qualified' });
    await logActivity(
      context,
      assignee,
      current,
      'visit',
      'Site visit and measurement',
      `Measured about ${String(Math.round(story.rupees / 100))} sq ft of paintable area`,
    );
  });
  if (story.outcome === 'qualified') return;
  if (story.outcome === 'won') {
    timeline.at(day(5), async () => {
      const current = must(lead, 'lead');
      await context.as(assignee).post(`/leads/${current.id}/win`);
      await logActivity(context, assignee, current, 'note', 'Order confirmed at the counter');
    });
    return;
  }

  timeline.at(day(5), async () => {
    const current = must(lead, 'lead');
    const created = await context.as(assignee).post(`/leads/${current.id}/convert`, {
      expectedValuePaise: story.rupees * 100,
      expectedOrderDate: indiaDate(-20 - index),
      categoryId: context.categoryIds.get(index % 2 === 0 ? 'interior' : 'exterior'),
      expectedQuantity: Math.round(story.rupees / 450),
    });
    opportunity = { recordType: 'opportunity', id: created.id, store };
    remember(context, opportunity);
    context.count('opportunities');
  });
  const stages: ['proposal' | 'negotiation', number][] = [
    ['proposal', 8],
    ['negotiation', 12],
  ];
  for (const [stage, offset] of stages) {
    if (!reached(stage === 'proposal' ? 2 : 3)) break;
    timeline.at(day(offset), async () => {
      const current = must(opportunity, 'opportunity');
      await context.as(assignee).post(`/opportunities/${current.id}/stage`, { stage });
      await logActivity(
        context,
        assignee,
        current,
        stage === 'proposal' ? 'email' : 'meeting',
        stage === 'proposal' ? 'Sent the quotation' : 'Discussed volume discount',
      );
    });
  }
  if (story.outcome === 'opportunity_lost') {
    timeline.at(day(14), async () => {
      const current = must(opportunity, 'opportunity');
      await context.as(assignee).post(`/opportunities/${current.id}/lose`, {
        reason: 'Chose a cheaper waterproofing brand',
      });
    });
  }
  if (story.outcome === 'opportunity_won') {
    timeline.at(day(16), async () => {
      const current = must(opportunity, 'opportunity');
      await context.as(assignee).post(`/opportunities/${current.id}/win`);
      // The CRM executive works across stores, so can link painters from any branch.
      const project = await context.as('crm').post(`/opportunities/${current.id}/project`, {
        name: story.project,
        ...siteDetails(context, story.rupees, 'Jubilee Hills', '500033'),
        parties: [
          { partyId: partyAt(context, ['architect', index]).id, role: 'architect' },
          { partyId: partyAt(context, ['contractor', index]).id, role: 'contractor' },
          { partyId: partyAt(context, ['painter', 0]).id, role: 'painter' },
          { partyId: partyAt(context, ['painter', 1]).id, role: 'painter' },
        ],
      });
      const projectRecord: CrmRecord = { recordType: 'project', id: project.id, store };
      remember(context, projectRecord);
      rememberProject(context, must(story.project, 'project name'), project.id);
      context.count('projects');
      for (const stage of WORK_STAGES.slice(1, index === 0 ? 7 : 3)) {
        await context.as(assignee).post(`/projects/${project.id}/stage`, { stage });
      }
      await logActivity(
        context,
        assignee,
        projectRecord,
        'visit',
        'Site survey with the architect',
      );
    });
  }
}

/** How far each outcome goes: 1 opportunity, 2 proposal, 3 negotiation. */
const OUTCOME_DEPTH: Record<LeadStory['outcome'], number> = {
  new: 0,
  contacted: 0,
  qualified: 0,
  lost: 0,
  won: 0,
  discovery: 1,
  opportunity_lost: 1,
  proposal: 2,
  negotiation: 3,
  opportunity_won: 3,
};

function rememberProject(context: SeedContext, name: string, id: string): void {
  const map = projectIds.get(context) ?? new Map<string, string>();
  map.set(name, id);
  projectIds.set(context, map);
}

/** Site address, map pin, dates and quantities for a project worth `rupees`. */
function siteDetails(context: SeedContext, rupees: number, area: string, pincode: string) {
  const { random } = context;
  const sqft = Math.round(rupees / 12);
  return {
    addressLine: `Plot ${String(random.int(1, 400))}, ${area}`,
    city: 'Hyderabad',
    state: 'Telangana',
    pincode,
    latitude: Math.round((17.36 + random.next() * 0.14) * 1e6) / 1e6,
    longitude: Math.round((78.34 + random.next() * 0.2) * 1e6) / 1e6,
    startDate: indiaDate(random.int(5, 25)),
    expectedCompletionDate: indiaDate(-random.int(30, 120)),
    estimatedAreaSqFt: sqft,
    estimatedPaintLitres: Math.round(sqft / 45),
    expectedOrderValuePaise: rupees * 100,
  };
}

/** Projects started directly, moved through their stages; one completed, one cancelled. */
export function scheduleProjects(context: SeedContext, timeline: Timeline): void {
  const projects = context.plan.size === 'full' ? PROJECTS : PROJECTS.slice(0, 3);
  for (const story of projects) {
    const start = context.daysAgo(story.started);
    let project: CrmRecord | null = null;
    let assignee = 'salesAmp';
    timeline.at(start, async () => {
      const customer = partyAt(context, story.customer);
      const store = storeOf(customer);
      assignee = context.salesOf(store);
      const created = await context.as('crm').post('/projects', {
        storeId: context.storeId(store),
        customerPartyId: customer.id,
        name: story.name,
        ...siteDetails(context, story.rupees, story.area, story.pincode),
        estimatedAreaSqFt: story.sqft,
        notes: `Customer contact: ${customer.contactPerson ?? customer.displayName}`,
        assignedMemberId: context.memberId(assignee),
        parties: story.team.map((link) => ({ partyId: partyAt(context, link).id, role: link[0] })),
      });
      project = { recordType: 'project', id: created.id, store };
      remember(context, project);
      rememberProject(context, story.name, created.id);
      context.count('projects');
    });
    const target = story.stage === 'cancelled' ? 3 : WORK_STAGES.indexOf(story.stage);
    WORK_STAGES.slice(1, target + 1).forEach((stage: ProjectStage, step) => {
      timeline.at(Math.max(1, start - 2 * (step + 1)), async () => {
        const current = must(project, 'project');
        await context.as(assignee).post(`/projects/${current.id}/stage`, { stage });
        if (stage === 'survey') {
          await logActivity(context, assignee, current, 'visit', 'Site survey and photos');
        }
      });
    });
    if (story.stage === 'cancelled') {
      timeline.at(Math.max(1, start - 10), async () => {
        const current = must(project, 'project');
        await context.as(assignee).post(`/projects/${current.id}/cancel`, {
          reason: 'Client moved to a turnkey interiors vendor',
        });
      });
    }
  }
}

/** Calls and visits logged on customers, and follow-ups: overdue, due today and coming up. */
export function scheduleFollowUps(context: SeedContext, timeline: Timeline): void {
  const { random } = context;
  // A steady trickle of logged contact with customers across the history.
  const touches = context.plan.size === 'full' ? 30 : 8;
  for (let index = 0; index < touches; index++) {
    timeline.at(context.daysAgo(1 - index / touches), async () => {
      const customers = [...context.parties.values()].filter(
        (party) => party.homeStore !== null && party.duplicateOf === null,
      );
      const party = random.pick(customers);
      const store = storeOf(party);
      const member = random.chance(0.5) ? context.salesOf(store) : context.managerOf(store);
      const [type, subject] = random.pick([
        ['call', 'Called about pending order'],
        ['whatsapp', 'Sent new colour catalogue'],
        ['visit', 'Visited the site'],
        ['call', 'Payment reminder'],
        ['meeting', 'Met at the store to finalise shades'],
      ] as const);
      await logActivity(
        context,
        member,
        { recordType: 'party', id: party.id, store },
        type,
        subject,
      );
    });
  }

  // A follow-up done on time, with the next step scheduled from it.
  timeline.at(context.daysAgo(0.4), async () => {
    const party = partyAt(context, ['contractor', 0]);
    const store = storeOf(party);
    const created = await context.as('owner').post('/activities', {
      recordType: 'party',
      recordId: party.id,
      type: 'follow_up',
      subject: 'Discuss rate contract renewal',
      dueAt: indiaMoment(context.daysAgo(0.4), '17:00'),
      assignedMemberId: context.memberId(context.managerOf(store)),
    });
    await context.as(context.managerOf(store)).post(`/activities/${created.id}/complete`, {
      outcome: 'Agreed to renew at the same discount; wants 45 days credit',
      next: { dueAt: indiaMoment(-5, '11:00'), subject: 'Send the renewed rate contract' },
    });
    context.count('activities', 2);
  });

  const followUps: [string, number, string, string][] = [
    ['owner', 2, '11:00', 'Call about the Phase 2 payment schedule'],
    ['managerAmp', 1, '16:00', 'Share the shade card for the temple'],
    ['salesAmp', 3, '12:30', 'Send the revised quotation'],
    ['salesSec', 1, '10:00', 'Collect the cheque for September dues'],
    ['owner', 0, '11:30', 'Review the final colour scheme with the architect'],
    ['owner', 0, '17:00', 'Confirm the Diwali scheme order'],
    ['managerKpl', 0, '12:00', 'Visit the site and measure'],
    ['salesAmp', 0, '15:00', 'Negotiate the volume discount'],
    ['crm', 0, '18:30', 'Invite to the painter meet'],
    ['managerSec', 0, '10:30', 'Discuss the credit limit'],
    ['owner', -1, '10:00', 'Visit the Kokapet site with the contractor'],
    ['salesSec', -2, '16:30', 'Demo of the new waterproofing range'],
    ['managerAmp', -3, '11:00', 'Stock review with the Asian Paints distributor'],
    ['crm', -5, '12:00', 'Quarterly call to architects'],
  ];
  const scheduled =
    context.plan.size === 'full' ? followUps : followUps.filter((_, i) => i % 2 === 0);
  timeline.at(context.daysAgo(0.15), async () => {
    for (const [member, daysAgo, time, subject] of scheduled) {
      const stores = memberStores(context, member);
      // A lead, opportunity or project at one of the member's stores.
      const record = random.pick(
        must(records.get(context), 'records').filter((entry) => stores.includes(entry.store)),
      );
      await context.as('owner').post('/activities', {
        recordType: record.recordType,
        recordId: record.id,
        type: 'follow_up',
        subject,
        dueAt: indiaMoment(daysAgo, time),
        assignedMemberId: context.memberId(member),
      });
      context.count('follow-ups');
    }
  });
}

function memberStores(context: SeedContext, member: string): StoreKey[] {
  const plan = must(
    [context.plan.owner, ...context.plan.team].find((person) => person.key === member),
    member,
  );
  return plan.allStores ? ['AMP', 'KPL', 'SEC'] : [...plan.stores];
}

/**
 * Agreements in every state: active, renewing within the month, draft,
 * renewed and terminated.
 */
export function scheduleContracts(context: SeedContext, timeline: Timeline): void {
  const full = context.plan.size === 'full';
  timeline.at(context.daysAgo(0.85), async () => {
    const owner = context.as('owner');
    const contractor = partyAt(context, ['contractor', 0]);
    const supplier = context.partiesOf('supplier');
    const create = async (body: Record<string, unknown>, activate = true) => {
      const created = await owner.post('/contracts', body);
      if (activate) await owner.post(`/contracts/${created.id}/activate`);
      context.count('contracts');
      return created.id;
    };
    await create({
      type: 'contractor_agreement',
      title: `Annual supply agreement – ${contractor.displayName}`,
      partyId: contractor.id,
      storeId: context.storeId(storeOf(contractor)),
      startDate: indiaDate(210),
      endDate: indiaDate(-155),
      valuePaise: 1_800_000_00,
      terms: 'Supply of emulsions, primers and putty for all sites at agreed rates.',
      creditTerms: '45 days credit up to ₹5,00,000',
      discountTerms: '8% off MRP on emulsions, 5% on enamels',
    });
    await create({
      type: 'supplier_agreement',
      title: 'Asian Paints distributorship terms 2025-26',
      partyId: must(supplier[0], 'supplier').id,
      startDate: indiaDate(345),
      endDate: indiaDate(-20),
      valuePaise: 9_000_000_00,
      terms: 'Quarterly volume targets with turnover discount slabs.',
      creditTerms: '30 days from invoice',
    });
    await create(
      {
        type: 'contractor_agreement',
        title: `Rate contract – ${partyAt(context, ['contractor', 2]).displayName}`,
        partyId: partyAt(context, ['contractor', 2]).id,
        startDate: indiaDate(-5),
        endDate: indiaDate(-370),
        valuePaise: 600_000_00,
        notes: 'Waiting for the signed copy',
      },
      false,
    );
    if (!full) return;
    await create({
      type: 'dealer_agreement',
      title: `Sub-dealer arrangement – ${partyAt(context, ['dealer', 1]).displayName}`,
      partyId: partyAt(context, ['dealer', 1]).id,
      startDate: indiaDate(90),
      endDate: indiaDate(-275),
      discountTerms: '12% off MRP; free delivery above ₹50,000',
    });
    const pearl = must(projectIds.get(context)?.get('Pearl City Towers, Miyapur'), 'project');
    await create({
      type: 'customer_agreement',
      title: 'Paint supply – Pearl City Towers',
      partyId: partyAt(context, ['builder', 2]).id,
      projectId: pearl,
      startDate: indiaDate(40),
      endDate: indiaDate(-140),
      valuePaise: 3_100_000_00,
    });
    const old = await create({
      type: 'supplier_agreement',
      title: 'Berger dealer terms 2025-26',
      partyId: must(supplier[1], 'supplier').id,
      startDate: indiaDate(355),
      endDate: indiaDate(-10),
      creditTerms: '45 days from invoice',
    });
    // Renewed early: the follow-on starts the day after this one ends.
    await owner.post(`/contracts/${old}/renew`, {
      endDate: indiaDate(-375),
      title: 'Berger dealer terms 2026-27',
    });
    context.count('contracts');
    const ended = await create({
      type: 'contractor_agreement',
      title: `Labour and material – ${partyAt(context, ['contractor', 4]).displayName}`,
      partyId: partyAt(context, ['contractor', 4]).id,
      startDate: indiaDate(120),
      endDate: indiaDate(-245),
    });
    await owner.post(`/contracts/${ended}/terminate`, { reason: 'Contractor closed operations' });
  });
}
