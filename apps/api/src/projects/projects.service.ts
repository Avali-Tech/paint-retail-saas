import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  nextDocumentNumber,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { canAccessStore, formatDocumentNumber } from '@paint/shared';
import { and, asc, count, desc, eq, exists, ilike, or, sql } from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import {
  assigneeFilter,
  requireParty,
  requireSalesperson,
  requireStore,
  storeScope,
} from '../leads/crm-lookups.js';
import { containsPattern } from '../parties/party-access.js';
import type {
  CreateProjectInput,
  FromOpportunityInput,
  ListProjectsQuery,
  PROJECT_STAGES,
  ProjectPartyLink,
  ProjectPipelineQuery,
  UpdateProjectInput,
  WORK_STAGES,
} from './projects.schemas.js';

const { opportunities, organizationMembers, parties, projectParties, projects, stores, users } =
  schema;

type ProjectStage = (typeof PROJECT_STAGES)[number];
type ProjectRow = typeof projects.$inferSelect;
type ProjectChanges = PgUpdateSetSource<typeof projects>;

const customers = alias(parties, 'customer');
const assignees = alias(organizationMembers, 'assignee');
const assigneeUsers = alias(users, 'assignee_user');
const OPEN: readonly ProjectStage[] = [
  'identified',
  'survey',
  'specification',
  'quotation',
  'negotiation',
  'order',
  'execution',
];

export interface ProjectView {
  readonly id: string;
  readonly number: string;
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly name: string;
  readonly customer: { readonly id: string; readonly name: string; readonly phone: string | null };
  readonly opportunity: { readonly id: string; readonly number: string } | null;
  readonly site: {
    readonly addressLine: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly pincode: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
  };
  readonly startDate: string | null;
  readonly expectedCompletionDate: string | null;
  readonly estimatedAreaSqFt: number | null;
  readonly estimatedPaintLitres: number | null;
  readonly expectedOrderValuePaise: number | null;
  readonly stage: ProjectStage;
  readonly cancelReason: string | null;
  readonly notes: string | null;
  readonly assignedTo: { readonly memberId: string; readonly name: string };
  /** Architects, contractors, painters and dealers on the job. */
  readonly parties: {
    readonly partyId: string;
    readonly name: string;
    readonly phone: string | null;
    readonly role: ProjectPartyLink['role'];
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface ProjectSummary {
  readonly id: string;
  readonly number: string;
  readonly name: string;
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly customer: { readonly id: string; readonly name: string; readonly phone: string | null };
  readonly city: string | null;
  readonly stage: ProjectStage;
  readonly expectedOrderValuePaise: number | null;
  readonly assignedTo: { readonly memberId: string; readonly name: string };
  readonly updatedAt: string;
}

export interface ProjectPage {
  readonly items: ProjectSummary[];
  readonly total: number;
}

/** What every new project needs, however it is created. */
type NewProject = Omit<CreateProjectInput, 'assignedMemberId'> & {
  readonly opportunityId?: string;
  readonly assignedMemberId: string;
};

@Injectable()
export class ProjectsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(auth: AuthContext, input: CreateProjectInput): Promise<ProjectView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireStore(tx, auth, input.storeId);
      await requireParty(tx, auth, input.customerPartyId, 'customer');
      const id = await this.insert(tx, auth, {
        ...input,
        assignedMemberId: input.assignedMemberId ?? auth.memberId,
      });
      return this.view(tx, auth, id);
    });
  }

  /** Starts the project for an opportunity: same store, customer, value and paint quantity. */
  fromOpportunity(
    auth: AuthContext,
    opportunityId: string,
    input: FromOpportunityInput,
  ): Promise<ProjectView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      // Locked, so two clicks cannot start two projects.
      const [opportunity] = await tx
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, opportunityId))
        .for('update');
      if (!opportunity || !canAccessStore(auth, opportunity.storeId)) {
        throw new NotFoundException('Opportunity not found');
      }
      if (opportunity.stage === 'lost') throw new ConflictException('This opportunity is lost');
      const [existing] = await tx
        .select({ number: projects.number })
        .from(projects)
        .where(eq(projects.opportunityId, opportunityId));
      if (existing) {
        throw new ConflictException(`This opportunity already has project ${existing.number}`);
      }
      const id = await this.insert(tx, auth, {
        estimatedPaintLitres: opportunity.expectedQuantity ?? undefined,
        expectedOrderValuePaise: opportunity.expectedValuePaise,
        ...input,
        storeId: opportunity.storeId,
        customerPartyId: opportunity.partyId,
        opportunityId,
        name: input.name ?? opportunity.title,
        // Every opportunity has a salesperson.
        assignedMemberId: input.assignedMemberId ?? String(opportunity.salespersonMemberId),
      });
      return this.view(tx, auth, id);
    });
  }

  list(auth: AuthContext, query: ListProjectsQuery): Promise<ProjectPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        storeScope(auth, projects.storeId, query.storeId),
        query.stage ? eq(projects.stage, query.stage) : undefined,
        assigneeFilter(auth, projects.assignedMemberId, query.assignedTo),
        query.partyId
          ? or(
              eq(projects.customerPartyId, query.partyId),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(projectParties)
                  .where(
                    and(
                      eq(projectParties.projectId, projects.id),
                      eq(projectParties.partyId, query.partyId),
                    ),
                  ),
              ),
            )
          : undefined,
        query.q
          ? or(
              ilike(projects.name, containsPattern(query.q)),
              ilike(projects.number, containsPattern(query.q)),
              ilike(projects.city, containsPattern(query.q)),
              ilike(customers.displayName, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(desc(projects.updatedAt), desc(projects.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(projects)
        .innerJoin(customers, eq(customers.id, projects.customerPartyId))
        .where(where);
      return {
        items: rows.map(({ project, store, customer, assigneeName }) => ({
          id: project.id,
          number: project.number,
          name: project.name,
          store,
          customer,
          city: project.city,
          stage: project.stage,
          expectedOrderValuePaise: project.expectedOrderValuePaise,
          assignedTo: { memberId: project.assignedMemberId, name: assigneeName },
          updatedAt: project.updatedAt.toISOString(),
        })),
        total: Number(totals?.total),
      };
    });
  }

  /** Count and expected order value per stage. */
  pipeline(
    auth: AuthContext,
    query: ProjectPipelineQuery,
  ): Promise<{ stage: ProjectStage; count: number; valuePaise: number }[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows = await tx
        .select({
          stage: projects.stage,
          count: count(),
          valuePaise: sql<string>`coalesce(sum(${projects.expectedOrderValuePaise}), 0)`,
        })
        .from(projects)
        .where(
          and(
            storeScope(auth, projects.storeId, query.storeId),
            assigneeFilter(auth, projects.assignedMemberId, query.assignedTo),
          ),
        )
        .groupBy(projects.stage);
      const byStage = new Map(rows.map((row) => [row.stage, row]));
      return schema.projectStage.enumValues.map((stage) => {
        const totals = byStage.get(stage) ?? { count: 0, valuePaise: '0' };
        return { stage, count: totals.count, valuePaise: Number(totals.valuePaise) };
      });
    });
  }

  get(auth: AuthContext, projectId: string): Promise<ProjectView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, projectId),
    );
  }

  update(auth: AuthContext, projectId: string, input: UpdateProjectInput): Promise<ProjectView> {
    return this.act(auth, projectId, OPEN, null, (_tx, project) => {
      const start = input.startDate === undefined ? project.startDate : input.startDate;
      const end =
        input.expectedCompletionDate === undefined
          ? project.expectedCompletionDate
          : input.expectedCompletionDate;
      if (start && end && end < start) {
        throw new BadRequestException('The expected completion cannot be before the start');
      }
      return Promise.resolve(input);
    });
  }

  assign(auth: AuthContext, projectId: string, memberId: string): Promise<ProjectView> {
    return this.act(auth, projectId, OPEN, null, async (tx, project) => {
      await requireSalesperson(tx, memberId, project.storeId, 'projects:manage');
      return { assignedMemberId: memberId };
    });
  }

  /** Replaces the architects, contractors, painters and dealers on the project. */
  setParties(
    auth: AuthContext,
    projectId: string,
    links: ProjectPartyLink[],
  ): Promise<ProjectView> {
    return this.act(auth, projectId, OPEN, null, async (tx, project) => {
      for (const link of links) await requireParty(tx, auth, link.partyId);
      await tx.delete(projectParties).where(eq(projectParties.projectId, projectId));
      await this.link(tx, project.organizationId, projectId, links);
      return {};
    });
  }

  /** Moves between the work stages; reaching "completed" closes the project. */
  moveTo(
    auth: AuthContext,
    projectId: string,
    stage: (typeof WORK_STAGES)[number],
  ): Promise<ProjectView> {
    return this.act(auth, projectId, OPEN, stage, () =>
      Promise.resolve(stage === 'completed' ? { closedAt: sql`now()` } : {}),
    );
  }

  cancel(auth: AuthContext, projectId: string, reason: string): Promise<ProjectView> {
    return this.act(auth, projectId, OPEN, 'cancelled', () =>
      Promise.resolve({ cancelReason: reason, closedAt: sql`now()` }),
    );
  }

  // Helpers -----------------------------------------------------------------

  private async insert(tx: Transaction, auth: AuthContext, input: NewProject): Promise<string> {
    await requireSalesperson(tx, input.assignedMemberId, input.storeId, 'projects:manage');
    for (const link of input.parties) await requireParty(tx, auth, link.partyId);
    if (
      input.startDate &&
      input.expectedCompletionDate &&
      input.expectedCompletionDate < input.startDate
    ) {
      throw new BadRequestException('The expected completion cannot be before the start');
    }
    const organizationId = auth.organization.id;
    const id = crypto.randomUUID();
    const { parties: links, ...fields } = input;
    await tx.insert(projects).values({
      ...fields,
      id,
      organizationId,
      number: formatDocumentNumber('PJ', await nextDocumentNumber(tx, organizationId, 'project')),
      createdByMemberId: auth.memberId,
    });
    await this.link(tx, organizationId, id, links);
    return id;
  }

  private async link(
    tx: Transaction,
    organizationId: string,
    projectId: string,
    links: ProjectPartyLink[],
  ): Promise<void> {
    if (links.length === 0) return;
    await tx
      .insert(projectParties)
      .values(links.map((link) => ({ organizationId, projectId, ...link })));
  }

  /** Locks the project, checks its stage, does the work, then saves stage and changes together. */
  private act(
    auth: AuthContext,
    projectId: string,
    allowed: readonly ProjectStage[],
    next: ProjectStage | null,
    work: (tx: Transaction, project: ProjectRow) => Promise<ProjectChanges>,
  ): Promise<ProjectView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update');
      if (!project || !canAccessStore(auth, project.storeId)) {
        throw new NotFoundException('Project not found');
      }
      if (!allowed.includes(project.stage)) {
        throw new ConflictException(`This project is ${project.stage}`);
      }
      const changes = await work(tx, project);
      await tx
        .update(projects)
        .set({ ...changes, ...(next ? { stage: next } : {}), updatedAt: sql`now()` })
        .where(eq(projects.id, projectId));
      return this.view(tx, auth, projectId);
    });
  }

  private rows(tx: Transaction) {
    return tx
      .select({
        project: projects,
        store: { id: stores.id, code: stores.code, name: stores.name },
        customer: { id: customers.id, name: customers.displayName, phone: customers.phone },
        opportunity: { id: opportunities.id, number: opportunities.number },
        assigneeName: assigneeUsers.fullName,
      })
      .from(projects)
      .innerJoin(stores, eq(stores.id, projects.storeId))
      .innerJoin(customers, eq(customers.id, projects.customerPartyId))
      .leftJoin(opportunities, eq(opportunities.id, projects.opportunityId))
      .innerJoin(assignees, eq(assignees.id, projects.assignedMemberId))
      .innerJoin(assigneeUsers, eq(assigneeUsers.id, assignees.userId))
      .$dynamic();
  }

  private async view(tx: Transaction, auth: AuthContext, projectId: string): Promise<ProjectView> {
    const [row] = await this.rows(tx).where(eq(projects.id, projectId));
    if (!row || !canAccessStore(auth, row.project.storeId)) {
      throw new NotFoundException('Project not found');
    }
    const { project } = row;
    const links = await tx
      .select({
        partyId: projectParties.partyId,
        name: parties.displayName,
        phone: parties.phone,
        role: projectParties.role,
      })
      .from(projectParties)
      .innerJoin(parties, eq(parties.id, projectParties.partyId))
      .where(eq(projectParties.projectId, projectId))
      .orderBy(asc(projectParties.role), asc(parties.displayName));
    return {
      id: project.id,
      number: project.number,
      store: row.store,
      name: project.name,
      customer: row.customer,
      opportunity: row.opportunity,
      site: {
        addressLine: project.addressLine,
        city: project.city,
        state: project.state,
        pincode: project.pincode,
        latitude: project.latitude,
        longitude: project.longitude,
      },
      startDate: project.startDate,
      expectedCompletionDate: project.expectedCompletionDate,
      estimatedAreaSqFt: project.estimatedAreaSqFt,
      estimatedPaintLitres: project.estimatedPaintLitres,
      expectedOrderValuePaise: project.expectedOrderValuePaise,
      stage: project.stage,
      cancelReason: project.cancelReason,
      notes: project.notes,
      assignedTo: { memberId: project.assignedMemberId, name: row.assigneeName },
      parties: links,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      closedAt: project.closedAt ? project.closedAt.toISOString() : null,
    };
  }
}
