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
  requireCategory,
  requireParty,
  requireSalesperson,
  requireStore,
  storeScope,
} from './crm-lookups.js';
import type {
  CreateOpportunityInput,
  ListOpportunitiesQuery,
  OPPORTUNITY_STAGES,
  OpportunityStageInput,
  PipelineQuery,
  UpdateOpportunityInput,
} from './leads.schemas.js';

const { categories, leads, opportunities, organizationMembers, parties, projects, stores, users } =
  schema;

type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];
type OpportunityRow = typeof opportunities.$inferSelect;
type OpportunityChanges = PgUpdateSetSource<typeof opportunities>;

const salespeople = alias(organizationMembers, 'salesperson');
const salespersonUsers = alias(users, 'salesperson_user');

/** The usual chance of winning at each open stage, when none is given. */
export const STAGE_PROBABILITY: Record<'discovery' | 'proposal' | 'negotiation', number> = {
  discovery: 20,
  proposal: 50,
  negotiation: 75,
};

export interface OpportunityView {
  readonly id: string;
  readonly number: string;
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly party: { readonly id: string; readonly name: string; readonly phone: string | null };
  readonly lead: { readonly id: string; readonly number: string } | null;
  readonly project: { readonly id: string; readonly number: string } | null;
  readonly title: string;
  readonly expectedValuePaise: number;
  /** Expected value × probability. */
  readonly weightedValuePaise: number;
  readonly expectedQuantity: number | null;
  readonly expectedOrderDate: string | null;
  readonly category: { readonly id: string; readonly name: string } | null;
  readonly salesperson: { readonly memberId: string; readonly name: string };
  readonly probability: number;
  readonly stage: OpportunityStage;
  readonly lostReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface OpportunityPage {
  readonly items: OpportunityView[];
  readonly total: number;
}

export interface OpportunityStageTotal {
  readonly stage: OpportunityStage;
  readonly count: number;
  readonly valuePaise: number;
  readonly weightedValuePaise: number;
}

/** What a new opportunity needs; used directly and when converting a lead. */
export type NewOpportunity = Omit<CreateOpportunityInput, 'salespersonMemberId'> & {
  readonly leadId?: string;
  readonly salespersonMemberId: string;
};

const OPEN: readonly OpportunityStage[] = ['discovery', 'proposal', 'negotiation'];

@Injectable()
export class OpportunitiesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(auth: AuthContext, input: CreateOpportunityInput): Promise<OpportunityView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireStore(tx, auth, input.storeId);
      await requireParty(tx, auth, input.partyId);
      const id = await this.insert(tx, auth, {
        ...input,
        salespersonMemberId: input.salespersonMemberId ?? auth.memberId,
      });
      return this.view(tx, auth, id);
    });
  }

  /** Adds an opportunity in the caller's transaction and returns its id. */
  async insert(tx: Transaction, auth: AuthContext, input: NewOpportunity): Promise<string> {
    if (input.categoryId) await requireCategory(tx, input.categoryId);
    await requireSalesperson(tx, input.salespersonMemberId, input.storeId);
    const organizationId = auth.organization.id;
    const id = crypto.randomUUID();
    await tx.insert(opportunities).values({
      id,
      organizationId,
      number: formatDocumentNumber(
        'OP',
        await nextDocumentNumber(tx, organizationId, 'opportunity'),
      ),
      storeId: input.storeId,
      partyId: input.partyId,
      leadId: input.leadId,
      title: input.title,
      expectedValuePaise: input.expectedValuePaise,
      expectedQuantity: input.expectedQuantity,
      expectedOrderDate: input.expectedOrderDate,
      categoryId: input.categoryId,
      salespersonMemberId: input.salespersonMemberId,
      probability: input.probability ?? STAGE_PROBABILITY.discovery,
      createdByMemberId: auth.memberId,
    });
    return id;
  }

  list(auth: AuthContext, query: ListOpportunitiesQuery): Promise<OpportunityPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        storeScope(auth, opportunities.storeId, query.storeId),
        query.stage ? eq(opportunities.stage, query.stage) : undefined,
        assigneeFilter(auth, opportunities.salespersonMemberId, query.assignedTo),
        query.q
          ? or(
              ilike(opportunities.title, containsPattern(query.q)),
              ilike(opportunities.number, containsPattern(query.q)),
              ilike(parties.displayName, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(desc(opportunities.updatedAt), desc(opportunities.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(opportunities)
        .innerJoin(parties, eq(parties.id, opportunities.partyId))
        .where(where);
      return { items: rows.map((row) => this.toView(row)), total: Number(totals?.total) };
    });
  }

  /** Count, value and probability-weighted value per stage. */
  pipeline(auth: AuthContext, query: PipelineQuery): Promise<OpportunityStageTotal[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows = await tx
        .select({
          stage: opportunities.stage,
          count: count(),
          valuePaise: sql<string>`sum(${opportunities.expectedValuePaise})`,
          weightedValuePaise: sql<string>`sum(round(${opportunities.expectedValuePaise} * ${opportunities.probability} / 100.0))`,
        })
        .from(opportunities)
        .where(
          and(
            storeScope(auth, opportunities.storeId, query.storeId),
            assigneeFilter(auth, opportunities.salespersonMemberId, query.assignedTo),
          ),
        )
        .groupBy(opportunities.stage);
      const byStage = new Map(rows.map((row) => [row.stage, row]));
      return schema.opportunityStage.enumValues.map((stage) => {
        const totals = byStage.get(stage) ?? { count: 0, valuePaise: '0', weightedValuePaise: '0' };
        return {
          stage,
          count: totals.count,
          valuePaise: Number(totals.valuePaise),
          weightedValuePaise: Number(totals.weightedValuePaise),
        };
      });
    });
  }

  get(auth: AuthContext, opportunityId: string): Promise<OpportunityView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, opportunityId),
    );
  }

  update(
    auth: AuthContext,
    opportunityId: string,
    input: UpdateOpportunityInput,
  ): Promise<OpportunityView> {
    return this.act(auth, opportunityId, OPEN, null, async (tx) => {
      if (input.categoryId) await requireCategory(tx, input.categoryId);
      return input;
    });
  }

  assign(auth: AuthContext, opportunityId: string, memberId: string): Promise<OpportunityView> {
    return this.act(auth, opportunityId, OPEN, null, async (tx, opportunity) => {
      await requireSalesperson(tx, memberId, opportunity.storeId);
      return { salespersonMemberId: memberId };
    });
  }

  moveTo(
    auth: AuthContext,
    opportunityId: string,
    input: OpportunityStageInput,
  ): Promise<OpportunityView> {
    return this.act(auth, opportunityId, OPEN, input.stage, () =>
      Promise.resolve({ probability: input.probability ?? STAGE_PROBABILITY[input.stage] }),
    );
  }

  /** The order came in; its lead is won too. */
  win(auth: AuthContext, opportunityId: string): Promise<OpportunityView> {
    return this.act(auth, opportunityId, OPEN, 'won', async (tx, opportunity) => {
      await this.closeLead(tx, opportunity, { stage: 'won', closedAt: sql`now()` });
      return { probability: 100, closedAt: sql`now()` };
    });
  }

  /** Lost to a competitor or dropped; its lead is lost with the same reason. */
  lose(auth: AuthContext, opportunityId: string, reason: string): Promise<OpportunityView> {
    return this.act(auth, opportunityId, OPEN, 'lost', async (tx, opportunity) => {
      await this.closeLead(tx, opportunity, {
        stage: 'lost',
        lostReason: reason,
        closedAt: sql`now()`,
      });
      return { probability: 0, lostReason: reason, closedAt: sql`now()` };
    });
  }

  // Helpers -----------------------------------------------------------------

  private async closeLead(
    tx: Transaction,
    opportunity: OpportunityRow,
    changes: PgUpdateSetSource<typeof leads>,
  ): Promise<void> {
    if (opportunity.leadId) {
      await tx
        .update(leads)
        .set({ ...changes, updatedAt: sql`now()` })
        .where(eq(leads.id, opportunity.leadId));
    }
  }

  /** Same contract as LeadsService.act: allowed stages, a guarded move, then the work. */
  private act(
    auth: AuthContext,
    opportunityId: string,
    allowed: readonly OpportunityStage[],
    next: OpportunityStage | null,
    work: (tx: Transaction, opportunity: OpportunityRow) => Promise<OpportunityChanges>,
  ): Promise<OpportunityView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      // Locking the row makes a second click or a racing request wait, then see the new stage.
      const [opportunity] = await tx
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, opportunityId))
        .for('update');
      if (!opportunity || !canAccessStore(auth, opportunity.storeId)) {
        throw new NotFoundException('Opportunity not found');
      }
      if (!allowed.includes(opportunity.stage)) {
        throw new ConflictException(`This opportunity is ${opportunity.stage}`);
      }
      const changes = await work(tx, opportunity);
      // One statement, so the stage and its closing details always change together.
      await tx
        .update(opportunities)
        .set({ ...changes, ...(next ? { stage: next } : {}), updatedAt: sql`now()` })
        .where(eq(opportunities.id, opportunityId));
      return this.view(tx, auth, opportunityId);
    });
  }

  private rows(tx: Transaction) {
    return tx
      .select({
        opportunity: opportunities,
        store: { id: stores.id, code: stores.code, name: stores.name },
        party: { id: parties.id, name: parties.displayName, phone: parties.phone },
        lead: { id: leads.id, number: leads.number },
        project: { id: projects.id, number: projects.number },
        category: { id: categories.id, name: categories.name },
        salespersonName: salespersonUsers.fullName,
      })
      .from(opportunities)
      .innerJoin(stores, eq(stores.id, opportunities.storeId))
      .innerJoin(parties, eq(parties.id, opportunities.partyId))
      .leftJoin(leads, eq(leads.id, opportunities.leadId))
      .leftJoin(projects, eq(projects.opportunityId, opportunities.id))
      .leftJoin(categories, eq(categories.id, opportunities.categoryId))
      .leftJoin(salespeople, eq(salespeople.id, opportunities.salespersonMemberId))
      .leftJoin(salespersonUsers, eq(salespersonUsers.id, salespeople.userId))
      .$dynamic();
  }

  private async view(
    tx: Transaction,
    auth: AuthContext,
    opportunityId: string,
  ): Promise<OpportunityView> {
    const [row] = await this.rows(tx).where(eq(opportunities.id, opportunityId));
    if (!row || !canAccessStore(auth, row.opportunity.storeId)) {
      throw new NotFoundException('Opportunity not found');
    }
    return this.toView(row);
  }

  private toView(row: Awaited<ReturnType<OpportunitiesService['rows']>>[number]): OpportunityView {
    const { opportunity } = row;
    return {
      id: opportunity.id,
      number: opportunity.number,
      store: row.store,
      party: row.party,
      lead: row.lead,
      project: row.project,
      title: opportunity.title,
      expectedValuePaise: opportunity.expectedValuePaise,
      weightedValuePaise: Math.round(
        (opportunity.expectedValuePaise * opportunity.probability) / 100,
      ),
      expectedQuantity: opportunity.expectedQuantity,
      expectedOrderDate: opportunity.expectedOrderDate,
      category: row.category,
      // Every opportunity has a salesperson: the lead's assignee or its creator.
      salesperson: {
        memberId: String(opportunity.salespersonMemberId),
        name: String(row.salespersonName),
      },
      probability: opportunity.probability,
      stage: opportunity.stage,
      lostReason: opportunity.lostReason,
      createdAt: opportunity.createdAt.toISOString(),
      updatedAt: opportunity.updatedAt.toISOString(),
      closedAt: opportunity.closedAt ? opportunity.closedAt.toISOString() : null,
    };
  }
}
