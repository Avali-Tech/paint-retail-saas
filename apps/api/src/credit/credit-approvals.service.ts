import 'reflect-metadata';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  approvalLevelOf,
  canApproveSale,
  can,
  formatINR,
  type CreditApprovalDetail,
  type CreditApprovalPage,
  type CreditApprovalRefusal,
  type CreditApprovalView,
  type SaleCreditView,
} from '@paint/shared';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { invoiceCreditSubject } from '../billing/invoice-credit.js';
import { loadDocument } from '../billing/invoice-view.js';
import { DATABASE } from '../database/database.module.js';
import { Notifier } from '../notifications/notifier.js';
import { orderCredit, orderSubject } from '../orders/order-credit.js';
import { loadOrder } from '../orders/order-views.js';
import { canSeeParty } from '../parties/party-access.js';
import {
  APPROVAL_PATH,
  announceApproval,
  insertApproval,
  levelOf,
  openApprovalOf,
  saleCredit,
  type SaleSubject,
} from './credit-gate.js';
import type {
  ApproveInput,
  CreateApprovalInput,
  ListApprovalsQuery,
} from './credit-approvals.schemas.js';
import { releaseHold } from './credit-holds.js';
import { visibleParties } from './credit-lookups.js';

const {
  creditApprovals,
  creditProfiles,
  organizationMembers,
  parties,
  projects,
  salesOrders,
  stores,
  taxDocuments,
  users,
} = schema;

const requesters = alias(organizationMembers, 'requester');
const requesterUsers = alias(users, 'requester_user');
const deciders = alias(organizationMembers, 'decider');
const deciderUsers = alias(users, 'decider_user');

type ApprovalRow = typeof creditApprovals.$inferSelect;

/**
 * Credit approvals (MVP 3 round 1a, P2-M09; spec §4.3–§4.4): asking for a sale
 * past the credit rules or the release of a hold, the queue approvers work
 * from, and the decision. Using an approved sale is the confirm's or issue's
 * job (credit-gate.ts).
 */
@Injectable()
export class CreditApprovalsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  /** Asks for an approval; approvers are told. */
  create(auth: AuthContext, input: CreateApprovalInput): Promise<CreditApprovalView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const row =
        'kind' in input
          ? await this.askRelease(tx, auth, input)
          : await this.askSale(tx, auth, input);
      const [party] = (await tx
        .select({ name: parties.displayName })
        .from(parties)
        .where(eq(parties.id, row.partyId))) as [{ name: string }];
      await announceApproval(tx, this.notifier, auth, row, party.name);
      return this.view(tx, auth, row.id);
    });
  }

  list(auth: AuthContext, query: ListApprovalsQuery): Promise<CreditApprovalPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        visibleParties(auth),
        query.mine ? eq(creditApprovals.status, 'pending') : undefined,
        query.status ? eq(creditApprovals.status, query.status) : undefined,
        query.kind ? eq(creditApprovals.kind, query.kind) : undefined,
        query.partyId ? eq(creditApprovals.partyId, query.partyId) : undefined,
        query.storeId ? eq(creditApprovals.storeId, query.storeId) : undefined,
        query.mine ? this.decidable(auth) : undefined,
      );
      const pendingFirst = query.status === 'pending' || query.mine;
      const rows = await this.rows(tx)
        .where(where)
        .orderBy(
          ...(pendingFirst
            ? [asc(creditApprovals.createdAt), asc(creditApprovals.number)]
            : [desc(creditApprovals.createdAt), desc(creditApprovals.number)]),
        )
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(creditApprovals)
        .innerJoin(parties, eq(parties.id, creditApprovals.partyId))
        .where(where);
      return {
        items: rows.map((row) => toView(auth, row)),
        total: Number(totals?.total),
        totalCapped: false,
        nextCursor: null,
      };
    });
  }

  get(auth: AuthContext, id: string): Promise<CreditApprovalDetail> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const view = await this.view(tx, auth, id);
      const [row] = (await tx.select().from(creditApprovals).where(eq(creditApprovals.id, id))) as [
        ApprovalRow,
      ];
      const open = row.status === 'pending' || row.status === 'approved';
      return {
        ...view,
        checkNow: open && row.kind === 'sale' ? await this.checkNow(tx, auth, row) : null,
      };
    });
  }

  approve(auth: AuthContext, id: string, input: ApproveInput): Promise<CreditApprovalView> {
    return this.decide(auth, id, async (tx, row) => {
      if (row.kind === 'release') {
        await releaseHold(tx, row.partyId, input.waiveOverdueUntil ?? null);
      } else if (input.waiveOverdueUntil !== undefined) {
        throw new ConflictException('Only the release of a hold waives overdue days');
      }
      await tx
        .update(creditApprovals)
        .set({
          status: 'approved',
          decidedByMemberId: auth.memberId,
          decidedAt: sql`now()`,
          decisionReason: input.reason,
          waiveOverdueUntil: row.kind === 'release' ? (input.waiveOverdueUntil ?? null) : null,
        })
        .where(eq(creditApprovals.id, id));
      return 'approved';
    });
  }

  reject(auth: AuthContext, id: string, reason: string): Promise<CreditApprovalView> {
    return this.decide(auth, id, async (tx) => {
      await tx
        .update(creditApprovals)
        .set({
          status: 'rejected',
          decidedByMemberId: auth.memberId,
          decidedAt: sql`now()`,
          decisionReason: reason,
        })
        .where(eq(creditApprovals.id, id));
      return 'rejected';
    });
  }

  /** Withdraws a pending or unused approval: the requester, or someone who may decide it. */
  cancel(auth: AuthContext, id: string): Promise<CreditApprovalView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const row = await this.locked(tx, auth, id);
      if (row.status !== 'pending' && row.status !== 'approved') {
        throw new ConflictException(`This approval is ${row.status}`);
      }
      if (row.requestedByMemberId !== auth.memberId && !mayDecide(auth, row)) {
        throw new ForbiddenException('Only who asked, or an approver, can cancel it');
      }
      await tx
        .update(creditApprovals)
        .set(
          row.status === 'pending'
            ? { status: 'cancelled', decidedByMemberId: auth.memberId, decidedAt: sql`now()` }
            : { status: 'cancelled' },
        )
        .where(eq(creditApprovals.id, id));
      return this.view(tx, auth, id);
    });
  }

  // Asking ------------------------------------------------------------------

  private async askSale(
    tx: Transaction,
    auth: AuthContext,
    input: Exclude<CreateApprovalInput, { kind: 'release' }>,
  ): Promise<ApprovalRow> {
    let subject: SaleSubject;
    let credit: SaleCreditView;
    if ('salesOrderId' in input) {
      if (!can(auth, 'sales:manage'))
        throw new ForbiddenException('You do not have permission to do this');
      const order = await loadOrder(tx, auth, input.salesOrderId, true);
      if (order.status !== 'draft')
        throw new ConflictException(`This order is already ${order.status}`);
      if (order.paymentTerms !== 'postpaid') {
        throw new ConflictException('Only a postpaid order is sold on credit');
      }
      subject = orderSubject(order);
      credit = await orderCredit(tx, auth.organization.id, order);
    } else {
      if (!can(auth, 'billing:issue'))
        throw new ForbiddenException('You do not have permission to do this');
      const document = await loadDocument(tx, auth, input.invoiceId, true);
      if (document.status !== 'draft') {
        throw new ConflictException(`This invoice is already ${document.status}`);
      }
      const found = await invoiceCreditSubject(tx, document, input.amountPaise, {
        allocateAdvances: false,
      });
      if (found === null) {
        throw new ConflictException(
          'This bill is not sold on credit (a walk-in bill, billing not live yet, or a postpaid order checked at confirm)',
        );
      }
      subject = found;
      credit = await saleCredit(tx, auth.organization.id, subject, true);
    }
    const level = approvalLevelOf(credit.approval);
    if (level === null) {
      const refusal: Omit<CreditApprovalRefusal, 'code'> & { code: string } = {
        statusCode: 409,
        code: credit.approval === 'blocked' ? 'credit_blocked' : 'credit_approval_not_needed',
        message:
          credit.approval === 'blocked'
            ? 'Credit is blocked for this customer: no approval can let this sale through'
            : 'This sale is within the credit rules: no approval is needed',
        credit,
        approval: null,
      };
      throw new ConflictException(refusal);
    }
    const open = await openApprovalOf(tx, subject);
    if (open?.status === 'pending') {
      throw new ConflictException(`${open.number} is already waiting for approval`);
    }
    // An approval that no longer covers the sale gives way to the new request.
    if (open !== null) {
      await tx
        .update(creditApprovals)
        .set({ status: 'cancelled' })
        .where(eq(creditApprovals.id, open.id));
    }
    return insertApproval(tx, auth, {
      kind: 'sale',
      partyId: subject.partyId,
      projectId: subject.projectId,
      storeId: subject.storeId,
      ...(subject.type === 'sales_order'
        ? { salesOrderId: subject.id }
        : { taxDocumentId: subject.id }),
      level,
      amountPaise: subject.amountPaise,
      check: { ...credit },
      reason: input.reason,
    });
  }

  private async askRelease(
    tx: Transaction,
    auth: AuthContext,
    input: Extract<CreateApprovalInput, { kind: 'release' }>,
  ): Promise<ApprovalRow> {
    if (!can(auth, 'credit:manage'))
      throw new ForbiddenException('You do not have permission to do this');
    const [party] = await tx
      .select({ id: parties.id, homeStoreId: parties.homeStoreId, status: creditProfiles.status })
      .from(parties)
      .leftJoin(creditProfiles, eq(creditProfiles.partyId, parties.id))
      .where(eq(parties.id, input.partyId))
      .for('update', { of: parties });
    if (!party || !canSeeParty(auth, party)) throw new NotFoundException('Party not found');
    if (party.status !== 'on_hold') throw new ConflictException('This party is not on hold');
    const [pending] = await tx
      .select({ number: creditApprovals.number })
      .from(creditApprovals)
      .where(
        and(
          eq(creditApprovals.partyId, input.partyId),
          eq(creditApprovals.kind, 'release'),
          eq(creditApprovals.status, 'pending'),
        ),
      );
    if (pending) throw new ConflictException(`${pending.number} is already waiting for approval`);
    return insertApproval(tx, auth, {
      kind: 'release',
      partyId: input.partyId,
      storeId: party.homeStoreId,
      reason: input.reason,
    });
  }

  // Deciding ----------------------------------------------------------------

  /** The SQL twin of mayDecide, for the queue: pending approvals the member may decide. */
  private decidable(auth: AuthContext): SQL | undefined {
    const notMine = sql`${creditApprovals.requestedByMemberId} <> ${auth.memberId}`;
    if (auth.role.key === 'owner') return notMine;
    const release = can(auth, 'credit:approve')
      ? sql`${creditApprovals.kind} = 'release'`
      : sql`false`;
    const stores = auth.allStores
      ? sql`true`
      : inArray(creditApprovals.storeId, [...auth.storeIds]);
    const sale = can(auth, 'credit:approve_sale')
      ? sql`(${creditApprovals.kind} = 'sale' and ${creditApprovals.level} = 'manager' and ${stores})`
      : sql`false`;
    return sql`(${notMine} and (${release} or ${sale}))`;
  }

  private decide(
    auth: AuthContext,
    id: string,
    apply: (tx: Transaction, row: ApprovalRow) => Promise<'approved' | 'rejected'>,
  ): Promise<CreditApprovalView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const row = await this.locked(tx, auth, id);
      if (row.status !== 'pending') throw new ConflictException(`This approval is ${row.status}`);
      if (row.requestedByMemberId === auth.memberId) {
        throw new ForbiddenException('You asked for this approval: another approver decides it');
      }
      if (!mayDecide(auth, row)) {
        throw new ForbiddenException(
          row.level === 'owner'
            ? 'Only the owner can decide this approval'
            : 'You cannot decide this approval',
        );
      }
      const status = await apply(tx, row);
      const [decided] = (await tx
        .select({ reason: creditApprovals.decisionReason, party: parties.displayName })
        .from(creditApprovals)
        .innerJoin(parties, eq(parties.id, creditApprovals.partyId))
        .where(eq(creditApprovals.id, id))) as [{ reason: string | null; party: string }];
      await this.notifier.notify(tx, {
        organizationId: row.organizationId,
        event: 'credit_approval_decided',
        to: { memberIds: [row.requestedByMemberId] },
        actorMemberId: auth.memberId,
        title: `Credit approval ${row.number} ${status}: ${decided.party}`,
        body: [
          row.kind === 'release'
            ? 'Release the credit hold'
            : `${formatINR(row.amountPaise)} on credit`,
          ...(decided.reason === null ? [] : [decided.reason]),
        ].join('\n'),
        link: `${APPROVAL_PATH}/${id}`,
      });
      return this.view(tx, auth, id);
    });
  }

  /** The approval locked, if the member can see its party (404 otherwise). */
  private async locked(tx: Transaction, auth: AuthContext, id: string): Promise<ApprovalRow> {
    const [row] = await tx
      .select({ approval: creditApprovals, homeStoreId: parties.homeStoreId })
      .from(creditApprovals)
      .innerJoin(parties, eq(parties.id, creditApprovals.partyId))
      .where(eq(creditApprovals.id, id))
      .for('update', { of: creditApprovals });
    if (!row || !canSeeParty(auth, row)) throw new NotFoundException('Credit approval not found');
    return row.approval;
  }

  /** Where the sale stands now: the order or draft invoice checked again. */
  private async checkNow(
    tx: Transaction,
    auth: AuthContext,
    row: ApprovalRow,
  ): Promise<SaleCreditView | null> {
    // A sale's order or invoice outlives its approvals (they go with a discarded draft).
    if (row.salesOrderId !== null) {
      const [order] = (await tx
        .select()
        .from(salesOrders)
        .where(eq(salesOrders.id, row.salesOrderId))) as [typeof salesOrders.$inferSelect];
      return orderCredit(tx, auth.organization.id, order);
    }
    const [document] = (await tx
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.id, String(row.taxDocumentId)))) as [typeof taxDocuments.$inferSelect];
    // Still a draft on credit after go-live: approvals were only taken for those.
    const [subject] = [
      await invoiceCreditSubject(tx, document, row.amountPaise, { allocateAdvances: false }),
    ] as [SaleSubject];
    return saleCredit(tx, auth.organization.id, subject, true);
  }

  // Views -------------------------------------------------------------------

  private rows(tx: Transaction) {
    return tx
      .select({
        approval: creditApprovals,
        party: { id: parties.id, name: parties.displayName, homeStoreId: parties.homeStoreId },
        projectName: projects.name,
        storeName: stores.name,
        orderNumber: salesOrders.number,
        invoiceNumber: taxDocuments.number,
        requesterName: requesterUsers.fullName,
        deciderName: deciderUsers.fullName,
      })
      .from(creditApprovals)
      .innerJoin(parties, eq(parties.id, creditApprovals.partyId))
      .leftJoin(projects, eq(projects.id, creditApprovals.projectId))
      .leftJoin(stores, eq(stores.id, creditApprovals.storeId))
      .leftJoin(salesOrders, eq(salesOrders.id, creditApprovals.salesOrderId))
      .leftJoin(taxDocuments, eq(taxDocuments.id, creditApprovals.taxDocumentId))
      .innerJoin(requesters, eq(requesters.id, creditApprovals.requestedByMemberId))
      .innerJoin(requesterUsers, eq(requesterUsers.id, requesters.userId))
      .leftJoin(deciders, eq(deciders.id, creditApprovals.decidedByMemberId))
      .leftJoin(deciderUsers, eq(deciderUsers.id, deciders.userId))
      .$dynamic();
  }

  private async view(tx: Transaction, auth: AuthContext, id: string): Promise<CreditApprovalView> {
    const [row] = await this.rows(tx).where(eq(creditApprovals.id, id));
    if (!row || !canSeeParty(auth, row.party))
      throw new NotFoundException('Credit approval not found');
    return toView(auth, row);
  }
}

type Row = Awaited<ReturnType<ReturnType<CreditApprovalsService['rows']>['execute']>>[number];

/**
 * Whether the member may decide the approval by role and store (spec §4.3): a
 * release needs credit:approve, a sale the level's approver at its store.
 * Never their own request (the callers check that).
 */
function mayDecide(auth: AuthContext, approval: ApprovalRow): boolean {
  if (approval.kind === 'release') return can(auth, 'credit:approve');
  return canApproveSale(
    levelOf(approval),
    { ...auth, roleKey: auth.role.key },
    String(approval.storeId),
  );
}

function toView(auth: AuthContext, row: Row): CreditApprovalView {
  const { approval } = row;
  const canDecide =
    approval.status === 'pending' &&
    approval.requestedByMemberId !== auth.memberId &&
    mayDecide(auth, approval);
  return {
    id: approval.id,
    number: approval.number,
    kind: approval.kind,
    status: approval.status,
    level: approval.level,
    party: { id: row.party.id, name: row.party.name },
    site:
      approval.projectId === null
        ? null
        : { projectId: approval.projectId, name: String(row.projectName) },
    store: approval.storeId === null ? null : { id: approval.storeId, name: String(row.storeName) },
    subject:
      approval.salesOrderId !== null
        ? { type: 'sales_order', id: approval.salesOrderId, number: row.orderNumber }
        : approval.taxDocumentId !== null
          ? { type: 'tax_document', id: approval.taxDocumentId, number: row.invoiceNumber }
          : null,
    amountPaise: approval.amountPaise,
    reason: approval.reason,
    checkAtRequest: approval.check as unknown as SaleCreditView | null,
    requestedBy: { memberId: approval.requestedByMemberId, name: row.requesterName },
    createdAt: approval.createdAt.toISOString(),
    decidedBy:
      approval.decidedByMemberId === null
        ? null
        : { memberId: approval.decidedByMemberId, name: String(row.deciderName) },
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decisionReason: approval.decisionReason,
    waiveOverdueUntil: approval.waiveOverdueUntil,
    usedAt: approval.usedAt?.toISOString() ?? null,
    canDecide,
  };
}
