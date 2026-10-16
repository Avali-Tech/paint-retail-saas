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
import {
  checkCredit,
  formatDocumentNumber,
  formatINR,
  type CreditCheck,
  type CreditRules,
} from '@paint/shared';
import { and, count, desc, eq, ilike, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { only } from '../common/only.js';
import { DATABASE } from '../database/database.module.js';
import { requireParty } from '../leads/crm-lookups.js';
import { Notifier } from '../notifications/notifier.js';
import { canSeeParty, containsPattern } from '../parties/party-access.js';
import type { ReleaseInput } from './credit-approvals.schemas.js';
import { releaseHold } from './credit-holds.js';
import {
  NO_CREDIT,
  billingLiveOn,
  creditRulesOf,
  creditSummaryOf,
  exposureOf,
  exposuresOf,
  positionOf,
  visibleParties,
  type CreditSummary,
  type Exposure,
} from './credit-lookups.js';
import type {
  CreditRequestInput,
  ListCreditQuery,
  ListRequestsQuery,
  UpdateCreditInput,
} from './credit.schemas.js';

const {
  creditApprovals,
  creditProfiles,
  creditRequests,
  creditRules,
  organizationMembers,
  parties,
  partyBalances,
  users,
} = schema;

const holders = alias(organizationMembers, 'holder');
const holderUsers = alias(users, 'holder_user');
const approvers = alias(organizationMembers, 'approver');
const approverUsers = alias(users, 'approver_user');
const requesters = alias(organizationMembers, 'requester');
const requesterUsers = alias(users, 'requester_user');
const deciders = alias(organizationMembers, 'decider');
const deciderUsers = alias(users, 'decider_user');

interface Person {
  readonly memberId: string;
  readonly name: string;
}

export interface CreditView extends CreditSummary {
  readonly party: { readonly id: string; readonly name: string; readonly phone: string | null };
  readonly hold: { readonly reason: string; readonly at: string; readonly by: Person } | null;
  readonly notes: string | null;
  /** Who approved the current limit and days. */
  readonly approvedBy: Person | null;
  readonly approvedAt: string | null;
  readonly exposureUpdatedAt: string | null;
  readonly rules: CreditRules;
}

export interface CreditListItem {
  readonly party: { readonly id: string; readonly name: string; readonly phone: string | null };
  readonly status: CreditSummary['status'];
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly risk: CreditSummary['risk'];
  readonly manualExposurePaise: number;
  readonly exposurePaise: number;
  readonly exposureSource: CreditSummary['exposureSource'];
  readonly overdueDays: number;
  readonly check: CreditCheck;
}

export interface CreditRequestView {
  readonly id: string;
  readonly number: string;
  readonly party: { readonly id: string; readonly name: string };
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly previousLimitPaise: number;
  readonly previousCreditDays: number;
  readonly note: string | null;
  readonly status: (typeof schema.creditRequestStatus.enumValues)[number];
  readonly requestedBy: Person;
  readonly createdAt: string;
  readonly decidedBy: Person | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

interface PartyRow {
  id: string;
  name: string;
  homeStoreId: string | null;
}

/** Credit profiles, requests and rules (roadmap P1-M25). */
@Injectable()
export class CreditService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  // Profiles ----------------------------------------------------------------

  get(auth: AuthContext, partyId: string): Promise<CreditView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.party(tx, auth, partyId);
      return this.view(tx, auth, partyId);
    });
  }

  /** Whether a sale of `amountPaise` on credit may go ahead, by the business's rules. */
  check(auth: AuthContext, partyId: string, amountPaise: number): Promise<CreditCheck> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.party(tx, auth, partyId);
      const [row] = await tx
        .select()
        .from(creditProfiles)
        .where(eq(creditProfiles.partyId, partyId));
      const profile = row ?? NO_CREDIT;
      return checkCredit(
        await creditRulesOf(tx, auth.organization.id),
        positionOf(profile, await exposureOf(tx, partyId, profile)),
        amountPaise,
      );
    });
  }

  /** Parties with credit, closest to their limit first. */
  list(auth: AuthContext, query: ListCreditQuery) {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        visibleParties(auth),
        query.status ? eq(creditProfiles.status, query.status) : ne(creditProfiles.status, 'none'),
        query.risk ? eq(creditProfiles.risk, query.risk) : undefined,
        query.q ? ilike(parties.displayName, containsPattern(query.q)) : undefined,
      );
      // Closest to the limit first: by the hand-entered exposure, or the ledger once live.
      const live = (await billingLiveOn(tx)) !== null;
      const owed = live
        ? sql`coalesce(${partyBalances.balancePaise}, 0)`
        : sql`${creditProfiles.manualExposurePaise}`;
      const rows = await tx
        .select({
          profile: creditProfiles,
          party: { id: parties.id, name: parties.displayName, phone: parties.phone },
        })
        .from(creditProfiles)
        .innerJoin(parties, eq(parties.id, creditProfiles.partyId))
        .leftJoin(partyBalances, eq(partyBalances.partyId, creditProfiles.partyId))
        .where(where)
        .orderBy(
          sql`${owed}::numeric / nullif(${creditProfiles.limitPaise}, 0) desc nulls last`,
          parties.displayName,
        )
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(creditProfiles)
        .innerJoin(parties, eq(parties.id, creditProfiles.partyId))
        .where(where);
      const rules = await creditRulesOf(tx, auth.organization.id);
      // One query for the whole page, however long (no query per customer).
      const exposures = await exposuresOf(
        tx,
        rows.map(({ profile, party }) => ({ partyId: party.id, manual: profile })),
      );
      const items: CreditListItem[] = [];
      for (const { profile, party } of rows) {
        // Every party asked for is answered.
        const exposure = exposures.get(party.id) as unknown as Exposure;
        items.push({
          party,
          status: profile.status,
          limitPaise: profile.limitPaise,
          creditDays: profile.creditDays,
          risk: profile.risk,
          manualExposurePaise: profile.manualExposurePaise,
          exposurePaise: exposure.exposurePaise,
          exposureSource: exposure.source,
          overdueDays: exposure.overdueDays,
          check: checkCredit(rules, positionOf(profile, exposure)),
        });
      }
      return { items, total: Number(totals?.total) };
    });
  }

  /** Risk, notes, and — until billing exists — what the party owes and how late. */
  update(auth: AuthContext, partyId: string, input: UpdateCreditInput): Promise<CreditView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.party(tx, auth, partyId, true);
      const exposureChanged =
        input.manualExposurePaise !== undefined || input.overdueDays !== undefined;
      if (exposureChanged && (await billingLiveOn(tx)) !== null) {
        throw new ConflictException(
          'Billing is live: what this party owes and how late come from its ledger now',
        );
      }
      const changes = {
        ...input,
        ...(exposureChanged
          ? { exposureUpdatedAt: sql`now()`, exposureUpdatedByMemberId: auth.memberId }
          : {}),
      };
      await tx
        .insert(creditProfiles)
        .values({ organizationId: auth.organization.id, partyId, ...changes })
        .onConflictDoUpdate({
          target: creditProfiles.partyId,
          set: { ...changes, updatedAt: sql`now()` },
        });
      return this.view(tx, auth, partyId);
    });
  }

  /** Stops credit for a party that has it, with a reason. */
  hold(auth: AuthContext, partyId: string, reason: string): Promise<CreditView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.party(tx, auth, partyId, true);
      const updated = await tx
        .update(creditProfiles)
        .set({
          status: 'on_hold',
          holdKind: 'manual',
          holdReason: reason,
          heldAt: sql`now()`,
          heldByMemberId: auth.memberId,
          updatedAt: sql`now()`,
        })
        .where(and(eq(creditProfiles.partyId, partyId), eq(creditProfiles.status, 'active')))
        .returning({ id: creditProfiles.id });
      if (updated.length === 0) throw new ConflictException('This party has no credit to hold');
      return this.view(tx, auth, partyId);
    });
  }

  /**
   * Lets a party on hold buy on credit again (an approver; MVP 3 spec §4.4),
   * optionally waiving the overdue block until a date. A release waiting for
   * approval is approved by this.
   */
  release(auth: AuthContext, partyId: string, input: ReleaseInput): Promise<CreditView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.party(tx, auth, partyId, true);
      await releaseHold(tx, partyId, input.waiveOverdueUntil ?? null);
      await tx
        .update(creditApprovals)
        .set({
          status: 'approved',
          decidedByMemberId: auth.memberId,
          decidedAt: sql`now()`,
          decisionReason: input.reason ?? null,
          waiveOverdueUntil: input.waiveOverdueUntil ?? null,
        })
        .where(
          and(
            eq(creditApprovals.partyId, partyId),
            eq(creditApprovals.kind, 'release'),
            eq(creditApprovals.status, 'pending'),
          ),
        );
      return this.view(tx, auth, partyId);
    });
  }

  // Requests ----------------------------------------------------------------

  /** Asks for credit, or a new limit or days, for a party; approvers are told. */
  request(auth: AuthContext, input: CreditRequestInput): Promise<CreditRequestView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireParty(tx, auth, input.partyId);
      const party = await this.party(tx, auth, input.partyId, true);
      const summary = await creditSummaryOf(tx, auth.organization.id, input.partyId);
      if (summary.pendingRequest) {
        throw new ConflictException(
          `${summary.pendingRequest.number} is already waiting for approval`,
        );
      }
      if (
        summary.status !== 'none' &&
        summary.limitPaise === input.limitPaise &&
        summary.creditDays === input.creditDays
      ) {
        throw new BadRequestException('This party already has this limit and these days');
      }
      const organizationId = auth.organization.id;
      const id = crypto.randomUUID();
      const number = formatDocumentNumber(
        'CR',
        await nextDocumentNumber(tx, organizationId, 'credit_request'),
      );
      await tx.insert(creditRequests).values({
        id,
        organizationId,
        number,
        partyId: input.partyId,
        limitPaise: input.limitPaise,
        creditDays: input.creditDays,
        previousLimitPaise: summary.limitPaise,
        previousCreditDays: summary.creditDays,
        note: input.note,
        requestedByMemberId: auth.memberId,
      });
      await this.notifier.notify(tx, {
        organizationId,
        event: 'credit_request_awaiting_approval',
        to: { storeId: party.homeStoreId, permission: 'credit:approve' },
        actorMemberId: auth.memberId,
        title: `Credit request ${number}: ${party.name}`,
        body: `${formatINR(input.limitPaise)} for ${String(input.creditDays)} days (now ${formatINR(summary.limitPaise)}, ${String(summary.creditDays)} days)`,
        link: `/credit-requests/${id}`,
      });
      return this.requestView(tx, auth, id);
    });
  }

  listRequests(auth: AuthContext, query: ListRequestsQuery) {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        visibleParties(auth),
        query.status ? eq(creditRequests.status, query.status) : undefined,
        query.partyId ? eq(creditRequests.partyId, query.partyId) : undefined,
      );
      const rows = await this.requestRows(tx)
        .where(where)
        .orderBy(desc(creditRequests.createdAt), desc(creditRequests.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(creditRequests)
        .innerJoin(parties, eq(parties.id, creditRequests.partyId))
        .where(where);
      return { items: rows.map(toRequestView), total: Number(totals?.total) };
    });
  }

  getRequest(auth: AuthContext, requestId: string): Promise<CreditRequestView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.requestView(tx, auth, requestId),
    );
  }

  /** Gives the party the requested limit and days; a party on hold stays on hold. */
  approve(auth: AuthContext, requestId: string, note?: string): Promise<CreditRequestView> {
    return this.decide(auth, requestId, 'approved', note, async (tx, request) => {
      const terms = {
        limitPaise: request.limitPaise,
        creditDays: request.creditDays,
        approvedByMemberId: auth.memberId,
        approvedAt: sql`now()`,
      };
      await tx
        .insert(creditProfiles)
        .values({
          organizationId: request.organizationId,
          partyId: request.partyId,
          status: 'active',
          ...terms,
        })
        .onConflictDoUpdate({
          target: creditProfiles.partyId,
          set: {
            ...terms,
            status: sql`case when ${creditProfiles.status} = 'on_hold' then 'on_hold'::credit_status else 'active'::credit_status end`,
            updatedAt: sql`now()`,
          },
        });
    });
  }

  reject(auth: AuthContext, requestId: string, reason: string): Promise<CreditRequestView> {
    return this.decide(auth, requestId, 'rejected', reason, () => Promise.resolve());
  }

  // Rules -------------------------------------------------------------------

  rules(auth: AuthContext): Promise<CreditRules> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      creditRulesOf(tx, auth.organization.id),
    );
  }

  setRules(auth: AuthContext, rules: CreditRules): Promise<CreditRules> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await tx
        .insert(creditRules)
        .values({ organizationId: auth.organization.id, ...rules })
        .onConflictDoUpdate({
          target: creditRules.organizationId,
          set: { ...rules, updatedAt: sql`now()` },
        });
      return creditRulesOf(tx, auth.organization.id);
    });
  }

  // Helpers -----------------------------------------------------------------

  /** The party, if the member can see it (404 otherwise); locked when changing its credit. */
  private async party(
    tx: Transaction,
    auth: AuthContext,
    partyId: string,
    lock = false,
  ): Promise<PartyRow> {
    const query = tx
      .select({ id: parties.id, name: parties.displayName, homeStoreId: parties.homeStoreId })
      .from(parties)
      .where(eq(parties.id, partyId));
    const [party] = lock ? await query.for('update') : await query;
    if (!party || !canSeeParty(auth, party)) throw new NotFoundException('Party not found');
    return party;
  }

  /** Locks a pending request, checks the member can see its party, applies it and tells the requester. */
  private decide(
    auth: AuthContext,
    requestId: string,
    status: 'approved' | 'rejected',
    note: string | undefined,
    apply: (tx: Transaction, request: typeof creditRequests.$inferSelect) => Promise<void>,
  ): Promise<CreditRequestView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [request] = await tx
        .select()
        .from(creditRequests)
        .where(eq(creditRequests.id, requestId))
        .for('update');
      if (!request) throw new NotFoundException('Credit request not found');
      const party = await this.party(tx, auth, request.partyId, true);
      if (request.status !== 'pending') {
        throw new ConflictException(`This request is ${request.status}`);
      }
      await apply(tx, request);
      await tx
        .update(creditRequests)
        .set({
          status,
          decidedByMemberId: auth.memberId,
          decidedAt: sql`now()`,
          decisionNote: note,
        })
        .where(eq(creditRequests.id, requestId));
      await this.notifier.notify(tx, {
        organizationId: request.organizationId,
        event: 'credit_request_decided',
        to: { memberIds: [request.requestedByMemberId] },
        actorMemberId: auth.memberId,
        title: `Credit request ${request.number} ${status}: ${party.name}`,
        body: [
          `${formatINR(request.limitPaise)} for ${String(request.creditDays)} days`,
          ...(note ? [note] : []),
        ].join('\n'),
        link: `/credit-requests/${requestId}`,
      });
      return this.requestView(tx, auth, requestId);
    });
  }

  private async view(tx: Transaction, auth: AuthContext, partyId: string): Promise<CreditView> {
    const rows = await tx
      .select({
        party: { id: parties.id, name: parties.displayName, phone: parties.phone },
        // Flat, not nested: Drizzle would turn a nested object with a null first field into null.
        holdReason: creditProfiles.holdReason,
        heldAt: creditProfiles.heldAt,
        heldBy: creditProfiles.heldByMemberId,
        notes: creditProfiles.notes,
        approvedBy: creditProfiles.approvedByMemberId,
        approvedAt: creditProfiles.approvedAt,
        exposureUpdatedAt: creditProfiles.exposureUpdatedAt,
        holderName: holderUsers.fullName,
        approverName: approverUsers.fullName,
      })
      .from(parties)
      .leftJoin(creditProfiles, eq(creditProfiles.partyId, parties.id))
      .leftJoin(holders, eq(holders.id, creditProfiles.heldByMemberId))
      .leftJoin(holderUsers, eq(holderUsers.id, holders.userId))
      .leftJoin(approvers, eq(approvers.id, creditProfiles.approvedByMemberId))
      .leftJoin(approverUsers, eq(approverUsers.id, approvers.userId))
      .where(eq(parties.id, partyId));
    // The caller has already checked the party exists and is visible.
    const row = only(rows, 'Party');
    const iso = (moment: Date | null) => (moment ? moment.toISOString() : null);
    return {
      ...(await creditSummaryOf(tx, auth.organization.id, partyId)),
      party: row.party,
      hold: row.holdReason
        ? {
            reason: row.holdReason,
            at: String(iso(row.heldAt)),
            by: { memberId: String(row.heldBy), name: String(row.holderName) },
          }
        : null,
      notes: row.notes,
      approvedBy: row.approvedBy
        ? { memberId: row.approvedBy, name: String(row.approverName) }
        : null,
      approvedAt: iso(row.approvedAt),
      exposureUpdatedAt: iso(row.exposureUpdatedAt),
      rules: await creditRulesOf(tx, auth.organization.id),
    };
  }

  private requestRows(tx: Transaction) {
    return tx
      .select({
        request: creditRequests,
        party: { id: parties.id, name: parties.displayName, homeStoreId: parties.homeStoreId },
        requesterName: requesterUsers.fullName,
        deciderName: deciderUsers.fullName,
      })
      .from(creditRequests)
      .innerJoin(parties, eq(parties.id, creditRequests.partyId))
      .innerJoin(requesters, eq(requesters.id, creditRequests.requestedByMemberId))
      .innerJoin(requesterUsers, eq(requesterUsers.id, requesters.userId))
      .leftJoin(deciders, eq(deciders.id, creditRequests.decidedByMemberId))
      .leftJoin(deciderUsers, eq(deciderUsers.id, deciders.userId))
      .$dynamic();
  }

  private async requestView(
    tx: Transaction,
    auth: AuthContext,
    requestId: string,
  ): Promise<CreditRequestView> {
    const [row] = await this.requestRows(tx).where(eq(creditRequests.id, requestId));
    if (!row || !canSeeParty(auth, row.party)) {
      throw new NotFoundException('Credit request not found');
    }
    return toRequestView(row);
  }
}

function toRequestView(row: {
  request: typeof creditRequests.$inferSelect;
  party: { id: string; name: string };
  requesterName: string;
  deciderName: string | null;
}): CreditRequestView {
  const { request } = row;
  return {
    id: request.id,
    number: request.number,
    party: { id: row.party.id, name: row.party.name },
    limitPaise: request.limitPaise,
    creditDays: request.creditDays,
    previousLimitPaise: request.previousLimitPaise,
    previousCreditDays: request.previousCreditDays,
    note: request.note,
    status: request.status,
    requestedBy: { memberId: request.requestedByMemberId, name: row.requesterName },
    createdAt: request.createdAt.toISOString(),
    decidedBy: request.decidedByMemberId
      ? { memberId: request.decidedByMemberId, name: String(row.deciderName) }
      : null,
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    decisionNote: request.decisionNote,
  };
}
