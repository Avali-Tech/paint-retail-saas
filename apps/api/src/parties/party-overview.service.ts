import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { recordLabel } from '../activities/activity-records.js';
import type { AuthContext } from '../auth/auth-context.js';
import { contractStatusSql, renewalDueSql, visibleContracts } from '../contracts/contract-sql.js';
import { todayInIndia } from '../contracts/contract-dates.js';
import { creditSummaryOf, type CreditSummary } from '../credit/credit-lookups.js';
import { loyaltySummaryOf, type LoyaltySummary } from '../loyalty/loyalty-lookups.js';
import { DATABASE } from '../database/database.module.js';
import { storeScope } from '../leads/crm-lookups.js';
import { PartiesService, type PartyView } from './parties.service.js';

const { activities, contracts, documents, leads, opportunities, projectParties, projects, stores } =
  schema;

/** How many of each kind of record the overview lists; totals count them all. */
export const OVERVIEW_ITEMS = 10;
const OPEN_LEAD_STAGES = ['new', 'contacted', 'qualified', 'opportunity'] as const;
const OPEN_OPPORTUNITY_STAGES = ['discovery', 'proposal', 'negotiation'] as const;

interface Section<T> {
  readonly total: number;
  /** The latest ones, newest first. */
  readonly items: T[];
}

export interface PartyOverview {
  readonly party: PartyView;
  /** Null when the member cannot see leads. */
  readonly leads:
    | (Section<{
        id: string;
        number: string;
        title: string;
        stage: string;
        storeCode: string;
        estimatedValuePaise: number | null;
        updatedAt: string;
      }> & { readonly open: number })
    | null;
  readonly opportunities:
    | (Section<{
        id: string;
        number: string;
        title: string;
        stage: string;
        storeCode: string;
        expectedValuePaise: number;
        probability: number;
        updatedAt: string;
      }> & { readonly openValuePaise: number; readonly wonValuePaise: number })
    | null;
  /** Projects where the party is the customer or works on it, with its roles there. */
  readonly projects: Section<{
    id: string;
    number: string;
    name: string;
    stage: string;
    storeCode: string;
    city: string | null;
    roles: string[];
    updatedAt: string;
  }> | null;
  /** The party's agreements; null when the member cannot see contracts. */
  readonly contracts:
    | (Section<{
        id: string;
        number: string;
        title: string;
        type: string;
        status: string;
        startDate: string;
        endDate: string;
        renewalDate: string;
        renewalDue: boolean;
        valuePaise: number | null;
      }> & { readonly active: number; readonly renewalDue: number })
    | null;
  /** Credit limit, days, status and the current check; null when the member cannot see credit. */
  readonly credit: CreditSummary | null;
  /** Points, tier and next expiry (account null until enrolled); null when the member cannot see loyalty. */
  readonly loyalty: LoyaltySummary | null;
  /** Activities on the party and on its visible leads, opportunities and projects. */
  readonly activities: Section<{
    id: string;
    type: string;
    subject: string;
    status: 'scheduled' | 'done' | 'cancelled';
    record: { type: string; id: string; label: string };
    at: string;
  }> & {
    readonly nextFollowUp: { id: string; subject: string; dueAt: string; label: string } | null;
  };
  readonly documents: Section<{
    id: string;
    category: string;
    fileName: string;
    note: string | null;
    createdAt: string;
  }>;
}

/** The customer 360 (roadmap P1-M06): a party with everything linked to it. */
@Injectable()
export class PartyOverviewService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PartiesService) private readonly parties: PartiesService,
  ) {}

  async overview(auth: AuthContext, partyId: string): Promise<PartyOverview> {
    // 404 unless the member can see the party.
    const party = await this.parties.get(auth, partyId);
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const canSee = (
        permission:
          'leads:read' | 'projects:read' | 'contracts:read' | 'credit:read' | 'loyalty:read',
      ) => auth.permissions.has(permission);
      const leadSection = canSee('leads:read') ? await this.leads(tx, auth, partyId) : null;
      const opportunitySection = canSee('leads:read')
        ? await this.opportunities(tx, auth, partyId)
        : null;
      const projectSection = canSee('projects:read')
        ? await this.projects(tx, auth, partyId)
        : null;
      const records: SQL[] = [
        sql`(${eq(activities.recordType, 'party')} and ${eq(activities.recordId, partyId)})`,
      ];
      for (const [type, section] of [
        ['lead', leadSection],
        ['opportunity', opportunitySection],
        ['project', projectSection],
      ] as const) {
        const ids = section?.ids ?? [];
        if (ids.length > 0) {
          records.push(
            sql`(${eq(activities.recordType, type)} and ${inArray(activities.recordId, ids)})`,
          );
        }
      }
      return {
        party,
        leads: leadSection?.view ?? null,
        opportunities: opportunitySection?.view ?? null,
        projects: projectSection?.view ?? null,
        contracts: canSee('contracts:read') ? await this.contracts(tx, auth, partyId) : null,
        credit: canSee('credit:read')
          ? await creditSummaryOf(tx, auth.organization.id, partyId)
          : null,
        loyalty: canSee('loyalty:read')
          ? await loyaltySummaryOf(tx, auth.organization.id, partyId, todayInIndia())
          : null,
        activities: await this.activities(tx, sql`(${sql.join(records, sql` or `)})`),
        documents: await this.documents(tx, partyId),
      };
    });
  }

  private async leads(tx: Transaction, auth: AuthContext, partyId: string) {
    const rows = await tx
      .select({ lead: leads, storeCode: stores.code })
      .from(leads)
      .innerJoin(stores, eq(stores.id, leads.storeId))
      .where(and(eq(leads.partyId, partyId), storeScope(auth, leads.storeId)))
      .orderBy(desc(leads.updatedAt), desc(leads.number));
    return {
      ids: rows.map(({ lead }) => lead.id),
      view: {
        total: rows.length,
        open: rows.filter(({ lead }) =>
          (OPEN_LEAD_STAGES as readonly string[]).includes(lead.stage),
        ).length,
        items: rows.slice(0, OVERVIEW_ITEMS).map(({ lead, storeCode }) => ({
          id: lead.id,
          number: lead.number,
          title: lead.title,
          stage: lead.stage,
          storeCode,
          estimatedValuePaise: lead.estimatedValuePaise,
          updatedAt: lead.updatedAt.toISOString(),
        })),
      },
    };
  }

  private async opportunities(tx: Transaction, auth: AuthContext, partyId: string) {
    const rows = await tx
      .select({ opportunity: opportunities, storeCode: stores.code })
      .from(opportunities)
      .innerJoin(stores, eq(stores.id, opportunities.storeId))
      .where(and(eq(opportunities.partyId, partyId), storeScope(auth, opportunities.storeId)))
      .orderBy(desc(opportunities.updatedAt), desc(opportunities.number));
    const sum = (stages: readonly string[]) =>
      rows
        .filter(({ opportunity }) => stages.includes(opportunity.stage))
        .reduce((total, { opportunity }) => total + opportunity.expectedValuePaise, 0);
    return {
      ids: rows.map(({ opportunity }) => opportunity.id),
      view: {
        total: rows.length,
        openValuePaise: sum(OPEN_OPPORTUNITY_STAGES),
        wonValuePaise: sum(['won']),
        items: rows.slice(0, OVERVIEW_ITEMS).map(({ opportunity, storeCode }) => ({
          id: opportunity.id,
          number: opportunity.number,
          title: opportunity.title,
          stage: opportunity.stage,
          storeCode,
          expectedValuePaise: opportunity.expectedValuePaise,
          probability: opportunity.probability,
          updatedAt: opportunity.updatedAt.toISOString(),
        })),
      },
    };
  }

  private async projects(tx: Transaction, auth: AuthContext, partyId: string) {
    const roles = await tx
      .select({ projectId: projectParties.projectId, role: projectParties.role })
      .from(projectParties)
      .where(eq(projectParties.partyId, partyId));
    const rows = await tx
      .select({ project: projects, storeCode: stores.code })
      .from(projects)
      .innerJoin(stores, eq(stores.id, projects.storeId))
      .where(
        and(
          or(
            eq(projects.customerPartyId, partyId),
            inArray(
              projects.id,
              roles.map((link) => link.projectId),
            ),
          ),
          storeScope(auth, projects.storeId),
        ),
      )
      .orderBy(desc(projects.updatedAt), desc(projects.number));
    return {
      ids: rows.map(({ project }) => project.id),
      view: {
        total: rows.length,
        items: rows.slice(0, OVERVIEW_ITEMS).map(({ project, storeCode }) => ({
          id: project.id,
          number: project.number,
          name: project.name,
          stage: project.stage,
          storeCode,
          city: project.city,
          roles: [
            ...(project.customerPartyId === partyId ? ['customer'] : []),
            ...roles.filter((link) => link.projectId === project.id).map((link) => link.role),
          ],
          updatedAt: project.updatedAt.toISOString(),
        })),
      },
    };
  }

  private async contracts(
    tx: Transaction,
    auth: AuthContext,
    partyId: string,
  ): Promise<PartyOverview['contracts']> {
    const rows = await tx
      .select({ contract: contracts, status: contractStatusSql, renewalDue: renewalDueSql })
      .from(contracts)
      .where(and(eq(contracts.partyId, partyId), visibleContracts(auth)))
      .orderBy(desc(contracts.endDate), desc(contracts.number));
    return {
      total: rows.length,
      active: rows.filter((row) => row.status === 'active').length,
      renewalDue: rows.filter((row) => row.renewalDue).length,
      items: rows.slice(0, OVERVIEW_ITEMS).map(({ contract, status, renewalDue }) => ({
        id: contract.id,
        number: contract.number,
        title: contract.title,
        type: contract.type,
        status,
        startDate: contract.startDate,
        endDate: contract.endDate,
        renewalDate: contract.renewalDate,
        renewalDue,
        valuePaise: contract.valuePaise,
      })),
    };
  }

  private async activities(tx: Transaction, records: SQL): Promise<PartyOverview['activities']> {
    const when = sql<Date>`coalesce(${activities.completedAt}, ${activities.cancelledAt}, ${activities.dueAt})`;
    const rows = await tx
      .select({ activity: activities, label: recordLabel, at: when })
      .from(activities)
      .where(records)
      .orderBy(desc(when), desc(activities.createdAt), desc(activities.id));
    const [next] = await tx
      .select({
        id: activities.id,
        subject: activities.subject,
        dueAt: sql<string>`${activities.dueAt}`,
        label: recordLabel,
      })
      .from(activities)
      .where(
        and(
          records,
          isNull(activities.completedAt),
          isNull(activities.cancelledAt),
          isNotNull(activities.dueAt),
        ),
      )
      .orderBy(asc(activities.dueAt))
      .limit(1);
    return {
      total: rows.length,
      nextFollowUp: next ? { ...next, dueAt: new Date(next.dueAt).toISOString() } : null,
      items: rows.slice(0, OVERVIEW_ITEMS).map(({ activity, label, at }) => ({
        id: activity.id,
        type: activity.type,
        subject: activity.subject,
        status: activity.completedAt ? 'done' : activity.cancelledAt ? 'cancelled' : 'scheduled',
        record: { type: activity.recordType, id: activity.recordId, label },
        at: new Date(at).toISOString(),
      })),
    };
  }

  private async documents(tx: Transaction, partyId: string): Promise<PartyOverview['documents']> {
    const rows = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.recordType, 'party'),
          eq(documents.recordId, partyId),
          isNull(documents.deletedAt),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.id));
    return {
      total: rows.length,
      items: rows.slice(0, OVERVIEW_ITEMS).map((document) => ({
        id: document.id,
        category: document.category,
        fileName: document.fileName,
        note: document.note,
        createdAt: document.createdAt.toISOString(),
      })),
    };
  }
}
