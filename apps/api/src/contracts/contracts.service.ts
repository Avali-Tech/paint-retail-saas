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
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import {
  assigneeFilter,
  requireParty,
  requireSalesperson,
  requireStore,
} from '../leads/crm-lookups.js';
import { containsPattern } from '../parties/party-access.js';
import { addDays, defaultRenewalDate, todayInIndia } from './contract-dates.js';
import {
  contractStatusSql,
  daysToEndSql,
  renewalDueSql,
  todayIst,
  visibleContracts,
} from './contract-sql.js';
import type {
  ContractStatus,
  CreateContractInput,
  ListContractsQuery,
  RenewContractInput,
  UpdateContractInput,
} from './contracts.schemas.js';

const { contracts, organizationMembers, parties, projects, stores, users } = schema;

type StoredStatus = (typeof schema.contractStatus.enumValues)[number];
type ContractRow = typeof contracts.$inferSelect;
type ContractChanges = PgUpdateSetSource<typeof contracts>;

const assignees = alias(organizationMembers, 'assignee');
const assigneeUsers = alias(users, 'assignee_user');
const previous = alias(contracts, 'previous');
const renewals = alias(contracts, 'renewal');

export interface ContractView {
  readonly id: string;
  readonly number: string;
  readonly type: ContractRow['type'];
  readonly title: string;
  readonly party: { readonly id: string; readonly name: string; readonly phone: string | null };
  /** Null for a business-wide agreement. */
  readonly store: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly project: { readonly id: string; readonly number: string; readonly name: string } | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly renewalDate: string;
  readonly valuePaise: number | null;
  readonly terms: string | null;
  readonly creditTerms: string | null;
  readonly discountTerms: string | null;
  readonly notes: string | null;
  readonly status: ContractStatus;
  /** Active and its renewal date has come: time to renew or let it go. */
  readonly renewalDue: boolean;
  /** Days left until the end date; negative once it has passed. */
  readonly daysToEnd: number;
  readonly terminationReason: string | null;
  /** The contract this one renews… */
  readonly renewalOf: { readonly id: string; readonly number: string } | null;
  /** …and the one that renewed it. */
  readonly renewedBy: { readonly id: string; readonly number: string } | null;
  readonly assignedTo: { readonly memberId: string; readonly name: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export type ContractSummary = Pick<
  ContractView,
  | 'id'
  | 'number'
  | 'type'
  | 'title'
  | 'party'
  | 'store'
  | 'startDate'
  | 'endDate'
  | 'renewalDate'
  | 'valuePaise'
  | 'status'
  | 'renewalDue'
  | 'daysToEnd'
  | 'assignedTo'
  | 'updatedAt'
>;

export interface ContractPage {
  readonly items: ContractSummary[];
  readonly total: number;
}

/** Everything a new contract row needs, however it is created. */
interface NewContract {
  readonly type: ContractRow['type'];
  readonly title: string;
  readonly partyId: string;
  readonly storeId: string | null;
  readonly projectId: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly renewalDate: string;
  readonly valuePaise: number | null;
  readonly terms: string | null;
  readonly creditTerms: string | null;
  readonly discountTerms: string | null;
  readonly notes: string | null;
  readonly assignedMemberId: string;
  readonly status: StoredStatus;
  readonly renewalOfId: string | null;
}

const canSee = (auth: AuthContext, storeId: string | null) =>
  storeId === null || canAccessStore(auth, storeId);

/** Contractor, supplier, customer and dealer agreements (roadmap P1-M24). */
@Injectable()
export class ContractsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(auth: AuthContext, input: CreateContractInput): Promise<ContractView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireParty(tx, auth, input.partyId);
      let storeId = input.storeId ?? null;
      if (input.projectId) {
        const [project] = await tx
          .select({ storeId: projects.storeId })
          .from(projects)
          .where(eq(projects.id, input.projectId));
        if (!project || !canAccessStore(auth, project.storeId)) {
          throw new BadRequestException('Unknown project');
        }
        if (storeId !== null && storeId !== project.storeId) {
          throw new BadRequestException('The project belongs to another store');
        }
        storeId = project.storeId;
      }
      if (storeId !== null) await requireStore(tx, auth, storeId);
      const id = await this.insert(tx, auth, {
        type: input.type,
        title: input.title,
        partyId: input.partyId,
        storeId,
        projectId: input.projectId ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        renewalDate: input.renewalDate ?? defaultRenewalDate(input.startDate, input.endDate),
        valuePaise: input.valuePaise ?? null,
        terms: input.terms ?? null,
        creditTerms: input.creditTerms ?? null,
        discountTerms: input.discountTerms ?? null,
        notes: input.notes ?? null,
        assignedMemberId: input.assignedMemberId ?? auth.memberId,
        status: 'draft',
        renewalOfId: null,
      });
      return this.view(tx, auth, id);
    });
  }

  list(auth: AuthContext, query: ListContractsQuery): Promise<ContractPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (query.storeId && !canAccessStore(auth, query.storeId)) {
        throw new NotFoundException('Store not found');
      }
      const where = and(
        visibleContracts(auth),
        query.storeId ? eq(contracts.storeId, query.storeId) : undefined,
        query.status ? sql`${contractStatusSql} = ${query.status}` : undefined,
        query.type ? eq(contracts.type, query.type) : undefined,
        query.partyId ? eq(contracts.partyId, query.partyId) : undefined,
        query.projectId ? eq(contracts.projectId, query.projectId) : undefined,
        query.renewalDue === undefined
          ? undefined
          : and(
              eq(contracts.status, 'active'),
              sql`${contracts.endDate} <= ${todayIst} + ${query.renewalDue}::int`,
            ),
        assigneeFilter(auth, contracts.assignedMemberId, query.assignedTo),
        query.q
          ? or(
              ilike(contracts.number, containsPattern(query.q)),
              ilike(contracts.title, containsPattern(query.q)),
              ilike(parties.displayName, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(
          ...(query.renewalDue === undefined
            ? [desc(contracts.updatedAt), desc(contracts.number)]
            : [asc(contracts.endDate), asc(contracts.number)]),
        )
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(contracts)
        .innerJoin(parties, eq(parties.id, contracts.partyId))
        .where(where);
      return {
        items: rows.map((row) => ({
          id: row.contract.id,
          number: row.contract.number,
          type: row.contract.type,
          title: row.contract.title,
          party: row.party,
          store: row.store,
          startDate: row.contract.startDate,
          endDate: row.contract.endDate,
          renewalDate: row.contract.renewalDate,
          valuePaise: row.contract.valuePaise,
          status: row.status,
          renewalDue: row.renewalDue,
          daysToEnd: row.daysToEnd,
          assignedTo: { memberId: row.contract.assignedMemberId, name: row.assigneeName },
          updatedAt: row.contract.updatedAt.toISOString(),
        })),
        total: Number(totals?.total),
      };
    });
  }

  get(auth: AuthContext, contractId: string): Promise<ContractView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, contractId),
    );
  }

  /** Changes a draft or active contract; moving its renewal date re-arms the reminder. */
  update(auth: AuthContext, contractId: string, input: UpdateContractInput): Promise<ContractView> {
    return this.act(auth, contractId, ['draft', 'active'], null, async (tx, contract) => {
      const startDate = input.startDate ?? contract.startDate;
      const endDate = input.endDate ?? contract.endDate;
      const datesMoved = input.startDate !== undefined || input.endDate !== undefined;
      const renewalDate =
        input.renewalDate ??
        (datesMoved ? defaultRenewalDate(startDate, endDate) : contract.renewalDate);
      if (endDate < startDate) {
        throw new BadRequestException('The end date cannot be before the start date');
      }
      if (renewalDate > endDate) {
        throw new BadRequestException('The renewal date cannot be after the end date');
      }
      if (input.assignedMemberId) {
        await requireSalesperson(tx, input.assignedMemberId, contract.storeId, 'contracts:manage');
      }
      return {
        ...input,
        startDate,
        endDate,
        renewalDate,
        ...(renewalDate === contract.renewalDate ? {} : { remindedAt: null }),
      };
    });
  }

  /** Puts a draft into force. */
  activate(auth: AuthContext, contractId: string): Promise<ContractView> {
    return this.act(auth, contractId, ['draft'], 'active', (_tx, contract) => {
      if (contract.endDate < todayInIndia()) {
        throw new ConflictException('This contract has already ended');
      }
      return Promise.resolve({});
    });
  }

  /** Ends a draft or active contract early, or closes one that will not be renewed. */
  terminate(auth: AuthContext, contractId: string, reason: string): Promise<ContractView> {
    return this.act(auth, contractId, ['draft', 'active'], 'terminated', () =>
      Promise.resolve({ terminationReason: reason, endedAt: sql`now()` }),
    );
  }

  /**
   * Renews an active (or expired) contract: creates the follow-on contract,
   * active straight away, and marks this one renewed. Returns the new contract.
   */
  renew(auth: AuthContext, contractId: string, input: RenewContractInput): Promise<ContractView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const contract = await this.lock(tx, auth, contractId, ['active']);
      const startDate = input.startDate ?? addDays(contract.endDate, 1);
      if (input.endDate < startDate) {
        throw new BadRequestException('The end date cannot be before the start date');
      }
      const id = await this.insert(tx, auth, {
        type: contract.type,
        title: input.title ?? contract.title,
        partyId: contract.partyId,
        storeId: contract.storeId,
        projectId: contract.projectId,
        startDate,
        endDate: input.endDate,
        renewalDate: input.renewalDate ?? defaultRenewalDate(startDate, input.endDate),
        valuePaise: input.valuePaise === undefined ? contract.valuePaise : input.valuePaise,
        terms: input.terms === undefined ? contract.terms : input.terms,
        creditTerms: input.creditTerms === undefined ? contract.creditTerms : input.creditTerms,
        discountTerms:
          input.discountTerms === undefined ? contract.discountTerms : input.discountTerms,
        notes: input.notes === undefined ? contract.notes : input.notes,
        assignedMemberId: contract.assignedMemberId,
        status: 'active',
        renewalOfId: contract.id,
      });
      await tx
        .update(contracts)
        .set({ status: 'renewed', endedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(contracts.id, contractId));
      return this.view(tx, auth, id);
    });
  }

  // Helpers -----------------------------------------------------------------

  private async insert(tx: Transaction, auth: AuthContext, input: NewContract): Promise<string> {
    await requireSalesperson(tx, input.assignedMemberId, input.storeId, 'contracts:manage');
    const organizationId = auth.organization.id;
    const id = crypto.randomUUID();
    await tx.insert(contracts).values({
      ...input,
      id,
      organizationId,
      number: formatDocumentNumber('CT', await nextDocumentNumber(tx, organizationId, 'contract')),
      createdByMemberId: auth.memberId,
    });
    return id;
  }

  /** Locks the contract and checks the member may see it and its stored status allows the action. */
  private async lock(
    tx: Transaction,
    auth: AuthContext,
    contractId: string,
    allowed: readonly StoredStatus[],
  ): Promise<ContractRow> {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .for('update');
    if (!contract || !canSee(auth, contract.storeId)) {
      throw new NotFoundException('Contract not found');
    }
    if (!allowed.includes(contract.status)) {
      throw new ConflictException(`This contract is ${contract.status}`);
    }
    return contract;
  }

  /** Locks the contract, checks its status, does the work, then saves status and changes together. */
  private act(
    auth: AuthContext,
    contractId: string,
    allowed: readonly StoredStatus[],
    next: StoredStatus | null,
    work: (tx: Transaction, contract: ContractRow) => Promise<ContractChanges>,
  ): Promise<ContractView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const contract = await this.lock(tx, auth, contractId, allowed);
      const changes = await work(tx, contract);
      await tx
        .update(contracts)
        .set({ ...changes, ...(next ? { status: next } : {}), updatedAt: sql`now()` })
        .where(eq(contracts.id, contractId));
      return this.view(tx, auth, contractId);
    });
  }

  private rows(tx: Transaction) {
    return tx
      .select({
        contract: contracts,
        party: { id: parties.id, name: parties.displayName, phone: parties.phone },
        store: { id: stores.id, code: stores.code, name: stores.name },
        project: { id: projects.id, number: projects.number, name: projects.name },
        renewalOf: { id: previous.id, number: previous.number },
        renewedBy: { id: renewals.id, number: renewals.number },
        status: contractStatusSql,
        renewalDue: renewalDueSql,
        daysToEnd: daysToEndSql,
        assigneeName: assigneeUsers.fullName,
      })
      .from(contracts)
      .innerJoin(parties, eq(parties.id, contracts.partyId))
      .leftJoin(stores, eq(stores.id, contracts.storeId))
      .leftJoin(projects, eq(projects.id, contracts.projectId))
      .leftJoin(previous, eq(previous.id, contracts.renewalOfId))
      .leftJoin(renewals, eq(renewals.renewalOfId, contracts.id))
      .innerJoin(assignees, eq(assignees.id, contracts.assignedMemberId))
      .innerJoin(assigneeUsers, eq(assigneeUsers.id, assignees.userId))
      .$dynamic();
  }

  private async view(
    tx: Transaction,
    auth: AuthContext,
    contractId: string,
  ): Promise<ContractView> {
    const [row] = await this.rows(tx).where(eq(contracts.id, contractId));
    if (!row || !canSee(auth, row.contract.storeId)) {
      throw new NotFoundException('Contract not found');
    }
    const { contract } = row;
    return {
      id: contract.id,
      number: contract.number,
      type: contract.type,
      title: contract.title,
      party: row.party,
      store: row.store,
      project: row.project,
      startDate: contract.startDate,
      endDate: contract.endDate,
      renewalDate: contract.renewalDate,
      valuePaise: contract.valuePaise,
      terms: contract.terms,
      creditTerms: contract.creditTerms,
      discountTerms: contract.discountTerms,
      notes: contract.notes,
      status: row.status,
      renewalDue: row.renewalDue,
      daysToEnd: row.daysToEnd,
      terminationReason: contract.terminationReason,
      renewalOf: row.renewalOf,
      renewedBy: row.renewedBy,
      assignedTo: { memberId: contract.assignedMemberId, name: row.assigneeName },
      createdAt: contract.createdAt.toISOString(),
      updatedAt: contract.updatedAt.toISOString(),
      endedAt: contract.endedAt ? contract.endedAt.toISOString() : null,
    };
  }
}
