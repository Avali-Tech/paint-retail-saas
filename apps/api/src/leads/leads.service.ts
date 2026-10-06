import 'reflect-metadata';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  nextDocumentNumber,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { canAccessStore, formatDocumentNumber } from '@paint/shared';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import {
  assigneeFilter,
  requireParty,
  requireSalesperson,
  requireStore,
  storeScope,
} from './crm-lookups.js';
import type {
  ConvertLeadInput,
  CreateLeadInput,
  LEAD_STAGES,
  ListLeadsQuery,
  OPEN_LEAD_STAGES,
  PipelineQuery,
  UpdateLeadInput,
} from './leads.schemas.js';
import { OpportunitiesService, type OpportunityView } from './opportunities.service.js';

const {
  customerProfiles,
  leads,
  opportunities,
  organizationMembers,
  parties,
  partyRoles,
  stores,
  users,
} = schema;

type LeadStage = (typeof LEAD_STAGES)[number];
type LeadRow = typeof leads.$inferSelect;
type LeadChanges = PgUpdateSetSource<typeof leads>;

const referrers = alias(parties, 'referrer');
const assignees = alias(organizationMembers, 'assignee');
const assigneeUsers = alias(users, 'assignee_user');

export interface LeadView {
  readonly id: string;
  readonly number: string;
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly party: { readonly id: string; readonly name: string; readonly phone: string | null };
  readonly title: string;
  readonly requirement: string | null;
  readonly source: LeadRow['source'];
  readonly referredBy: { readonly id: string; readonly name: string } | null;
  readonly estimatedValuePaise: number | null;
  readonly expectedOrderDate: string | null;
  readonly assignedTo: { readonly memberId: string; readonly name: string };
  readonly stage: LeadStage;
  readonly lostReason: string | null;
  readonly opportunityId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface LeadPage {
  readonly items: LeadView[];
  readonly total: number;
}

export interface StageTotal {
  readonly stage: string;
  readonly count: number;
  readonly valuePaise: number;
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
  ) {}

  create(auth: AuthContext, input: CreateLeadInput): Promise<LeadView> {
    const organizationId = auth.organization.id;
    return withTenant(this.connection.db, organizationId, async (tx) => {
      await requireStore(tx, auth, input.storeId);
      const partyId = input.contact
        ? await this.contactParty(tx, auth, input.storeId, input.contact)
        : String(input.partyId);
      await requireParty(tx, auth, partyId);
      if (input.referredByPartyId) {
        await requireParty(tx, auth, input.referredByPartyId, 'referrer');
      }
      const assignedMemberId = input.assignedMemberId ?? auth.memberId;
      await requireSalesperson(tx, assignedMemberId, input.storeId);
      const id = crypto.randomUUID();
      await tx.insert(leads).values({
        id,
        organizationId,
        number: formatDocumentNumber('LD', await nextDocumentNumber(tx, organizationId, 'lead')),
        storeId: input.storeId,
        partyId,
        title: input.title,
        requirement: input.requirement,
        source: input.source,
        referredByPartyId: input.referredByPartyId,
        estimatedValuePaise: input.estimatedValuePaise,
        expectedOrderDate: input.expectedOrderDate,
        assignedMemberId,
        createdByMemberId: auth.memberId,
      });
      return this.view(tx, auth, id);
    });
  }

  list(auth: AuthContext, query: ListLeadsQuery): Promise<LeadPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        storeScope(auth, leads.storeId, query.storeId),
        query.stage ? eq(leads.stage, query.stage) : undefined,
        query.source ? eq(leads.source, query.source) : undefined,
        query.partyId ? eq(leads.partyId, query.partyId) : undefined,
        assigneeFilter(auth, leads.assignedMemberId, query.assignedTo),
        query.q
          ? or(
              ilike(leads.title, containsPattern(query.q)),
              ilike(leads.number, containsPattern(query.q)),
              ilike(parties.displayName, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(desc(leads.updatedAt), desc(leads.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(leads)
        .innerJoin(parties, eq(parties.id, leads.partyId))
        .where(where);
      return { items: rows.map((row) => this.toView(row)), total: Number(totals?.total) };
    });
  }

  /** Count and estimated value per stage, for a kanban board's column headers. */
  pipeline(auth: AuthContext, query: PipelineQuery): Promise<StageTotal[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows = await tx
        .select({
          stage: leads.stage,
          count: count(),
          valuePaise: sql<string>`coalesce(sum(${leads.estimatedValuePaise}), 0)`,
        })
        .from(leads)
        .where(
          and(
            storeScope(auth, leads.storeId, query.storeId),
            assigneeFilter(auth, leads.assignedMemberId, query.assignedTo),
          ),
        )
        .groupBy(leads.stage);
      const byStage = new Map(rows.map((row) => [row.stage, row]));
      return schema.leadStage.enumValues.map((stage) => {
        const totals = byStage.get(stage) ?? { count: 0, valuePaise: '0' };
        return { stage, count: totals.count, valuePaise: Number(totals.valuePaise) };
      });
    });
  }

  get(auth: AuthContext, leadId: string): Promise<LeadView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, leadId),
    );
  }

  update(auth: AuthContext, leadId: string, input: UpdateLeadInput): Promise<LeadView> {
    return this.act(auth, leadId, OPEN, null, async (tx) => {
      if (input.referredByPartyId) {
        await requireParty(tx, auth, input.referredByPartyId, 'referrer');
      }
      return input;
    });
  }

  assign(auth: AuthContext, leadId: string, memberId: string): Promise<LeadView> {
    return this.act(auth, leadId, OPEN_OR_OPPORTUNITY, null, async (tx, lead) => {
      await requireSalesperson(tx, memberId, lead.storeId);
      return { assignedMemberId: memberId };
    });
  }

  /** Moves an open lead between new, contacted and qualified. */
  moveTo(
    auth: AuthContext,
    leadId: string,
    stage: (typeof OPEN_LEAD_STAGES)[number],
  ): Promise<LeadView> {
    return this.act(auth, leadId, OPEN, stage, () => Promise.resolve({}));
  }

  lose(auth: AuthContext, leadId: string, reason: string): Promise<LeadView> {
    return this.act(auth, leadId, OPEN, 'lost', () =>
      Promise.resolve({ lostReason: reason, closedAt: sql`now()` }),
    );
  }

  /** A qualified lead that turned into a sale without an opportunity. */
  win(auth: AuthContext, leadId: string): Promise<LeadView> {
    return this.act(auth, leadId, ['qualified'], 'won', () =>
      Promise.resolve({ closedAt: sql`now()` }),
    );
  }

  /** Brings back a lost lead that never became an opportunity. */
  reopen(auth: AuthContext, leadId: string): Promise<LeadView> {
    return this.act(auth, leadId, ['lost'], 'contacted', async (tx, lead) => {
      if (await this.opportunityOf(tx, lead.id)) {
        throw new ConflictException('Its opportunity was lost; start a new opportunity instead');
      }
      return { lostReason: null, closedAt: null };
    });
  }

  /** Turns a qualified lead into an opportunity. */
  async convert(
    auth: AuthContext,
    leadId: string,
    input: ConvertLeadInput,
  ): Promise<OpportunityView> {
    let opportunityId = '';
    await this.act(auth, leadId, ['qualified'], 'opportunity', async (tx, lead) => {
      opportunityId = await this.opportunities.insert(tx, auth, {
        ...input,
        storeId: lead.storeId,
        partyId: lead.partyId,
        leadId: lead.id,
        title: input.title ?? lead.title,
        // Every lead has an assignee.
        salespersonMemberId: input.salespersonMemberId ?? String(lead.assignedMemberId),
      });
      return {};
    });
    return this.opportunities.get(auth, opportunityId);
  }

  // Helpers -----------------------------------------------------------------

  /**
   * Runs one change to a lead: checks the member works at its store and that it
   * is in an allowed stage, does the work, then saves the new stage with it.
   */
  private act(
    auth: AuthContext,
    leadId: string,
    allowed: readonly LeadStage[],
    next: LeadStage | null,
    work: (tx: Transaction, lead: LeadRow) => Promise<LeadChanges>,
  ): Promise<LeadView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      // Locking the row makes a second click or a racing request wait, then see the new stage.
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId)).for('update');
      if (!lead || !canAccessStore(auth, lead.storeId)) {
        throw new NotFoundException('Lead not found');
      }
      if (!allowed.includes(lead.stage)) {
        throw new ConflictException(`This lead is ${lead.stage}`);
      }
      const changes = await work(tx, lead);
      // One statement, so the stage and its closing details always change together.
      await tx
        .update(leads)
        .set({ ...changes, ...(next ? { stage: next } : {}), updatedAt: sql`now()` })
        .where(eq(leads.id, leadId));
      return this.view(tx, auth, leadId);
    });
  }

  /** Finds the party with this mobile number, or adds the contact as a customer of the store. */
  private async contactParty(
    tx: Transaction,
    auth: AuthContext,
    storeId: string,
    contact: NonNullable<CreateLeadInput['contact']>,
  ): Promise<string> {
    const [existing] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(eq(parties.phone, contact.phone));
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    const organizationId = auth.organization.id;
    await tx.insert(parties).values({
      id,
      organizationId,
      kind: contact.kind,
      displayName: contact.displayName,
      phone: contact.phone,
      homeStoreId: storeId,
    });
    await tx.insert(partyRoles).values({ organizationId, partyId: id, role: 'customer' });
    await tx.insert(customerProfiles).values({ organizationId, partyId: id });
    return id;
  }

  private async opportunityOf(tx: Transaction, leadId: string): Promise<string | null> {
    const [opportunity] = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.leadId, leadId));
    return opportunity ? opportunity.id : null;
  }

  private rows(tx: Transaction) {
    return tx
      .select({
        lead: leads,
        store: { id: stores.id, code: stores.code, name: stores.name },
        party: { id: parties.id, name: parties.displayName, phone: parties.phone },
        referrer: { id: referrers.id, name: referrers.displayName },
        assigneeName: assigneeUsers.fullName,
        opportunityId: opportunities.id,
      })
      .from(leads)
      .innerJoin(stores, eq(stores.id, leads.storeId))
      .innerJoin(parties, eq(parties.id, leads.partyId))
      .leftJoin(referrers, eq(referrers.id, leads.referredByPartyId))
      .leftJoin(assignees, eq(assignees.id, leads.assignedMemberId))
      .leftJoin(assigneeUsers, eq(assigneeUsers.id, assignees.userId))
      .leftJoin(opportunities, eq(opportunities.leadId, leads.id))
      .$dynamic();
  }

  private async view(tx: Transaction, auth: AuthContext, leadId: string): Promise<LeadView> {
    const [row] = await this.rows(tx).where(eq(leads.id, leadId));
    if (!row || !canAccessStore(auth, row.lead.storeId)) {
      throw new NotFoundException('Lead not found');
    }
    return this.toView(row);
  }

  private toView(row: Awaited<ReturnType<LeadsService['rows']>>[number]): LeadView {
    const { lead } = row;
    return {
      id: lead.id,
      number: lead.number,
      store: row.store,
      party: row.party,
      title: lead.title,
      requirement: lead.requirement,
      source: lead.source,
      referredBy: row.referrer,
      estimatedValuePaise: lead.estimatedValuePaise,
      expectedOrderDate: lead.expectedOrderDate,
      // Every lead has an assignee: whoever created it, unless reassigned.
      assignedTo: { memberId: String(lead.assignedMemberId), name: String(row.assigneeName) },
      stage: lead.stage,
      lostReason: lead.lostReason,
      opportunityId: row.opportunityId,
      createdAt: lead.createdAt.toISOString(),
      updatedAt: lead.updatedAt.toISOString(),
      closedAt: lead.closedAt ? lead.closedAt.toISOString() : null,
    };
  }
}

const OPEN: readonly LeadStage[] = ['new', 'contacted', 'qualified'];
const OPEN_OR_OPPORTUNITY: readonly LeadStage[] = [...OPEN, 'opportunity'];
