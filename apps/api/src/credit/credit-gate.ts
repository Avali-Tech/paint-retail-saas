import { ConflictException } from '@nestjs/common';
import { nextDocumentNumber, schema, type Transaction } from '@paint/db';
import {
  approvalCovers,
  canApproveSale,
  checkCredit,
  creditApprovalFor,
  formatDocumentNumber,
  formatINR,
  levelCovers,
  stricterCheck,
  type CreditApprovalLevel,
  type CreditApprovalRefusal,
  type CreditApprovalSummary,
  type CreditCheck,
  type SaleCreditView,
  type SiteCreditPosition,
} from '@paint/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import type { Notice, Notifier } from '../notifications/notifier.js';
import {
  NO_CREDIT,
  creditRulesOf,
  exposureOf,
  positionOf,
  siteExposureOf,
} from './credit-lookups.js';

const {
  creditApprovals,
  creditProfiles,
  organizationMembers,
  projects,
  siteCreditAccounts,
  users,
} = schema;

/** Where the approval queue lives in the web app. */
export const APPROVAL_PATH = '/credit/approvals';

/** A sale checked against the credit rules (MVP 3 spec §4.2). */
export interface SaleSubject {
  readonly type: 'sales_order' | 'tax_document';
  readonly id: string;
  readonly partyId: string;
  readonly projectId: string | null;
  readonly storeId: string;
  /** What the sale adds to the party's exposure. */
  readonly amountPaise: number;
  /** The order being confirmed, left out of the open orders. */
  readonly excludeOrderId: string | null;
}

const SITE_STATUS = { active: 'active', on_hold: 'on_hold', closed: 'none' } as const;

/**
 * Where the party (and the site, when the sale is on one with a site account)
 * stands for this sale. Without `required` (a prepaid order, a bill paid in
 * full) only the position is given.
 */
export async function saleCredit(
  tx: Transaction,
  organizationId: string,
  subject: SaleSubject,
  required: boolean,
): Promise<SaleCreditView> {
  const [row] = await tx
    .select()
    .from(creditProfiles)
    .where(eq(creditProfiles.partyId, subject.partyId));
  const profile = row ?? NO_CREDIT;
  const exposure = await exposureOf(tx, subject.partyId, profile, subject.excludeOrderId);
  const position = positionOf(profile, exposure);
  const base = { exposureSource: exposure.source, position };
  if (!required) return { ...base, required: false, check: null, site: null, approval: 'none' };
  const rules = await creditRulesOf(tx, organizationId);
  const check = checkCredit(rules, position, subject.amountPaise);
  let site: SiteCreditPosition | null = null;
  if (subject.projectId !== null) {
    const [account] = await tx
      .select({ account: siteCreditAccounts, projectName: projects.name })
      .from(siteCreditAccounts)
      .innerJoin(projects, eq(projects.id, siteCreditAccounts.projectId))
      .where(
        and(
          eq(siteCreditAccounts.partyId, subject.partyId),
          eq(siteCreditAccounts.projectId, subject.projectId),
        ),
      );
    if (account) {
      const owed = await siteExposureOf(
        tx,
        subject.partyId,
        subject.projectId,
        subject.excludeOrderId,
      );
      site = {
        siteAccountId: account.account.id,
        projectId: subject.projectId,
        projectName: account.projectName,
        status: account.account.status,
        limitPaise: account.account.limitPaise,
        exposurePaise: owed.exposurePaise,
        check: checkCredit(
          rules,
          {
            ...position,
            status: SITE_STATUS[account.account.status],
            limitPaise: account.account.limitPaise,
            exposurePaise: owed.exposurePaise,
          },
          subject.amountPaise,
        ),
      };
    }
  }
  const stricter = site === null ? check : stricterCheck(check, site.check);
  return { ...base, required: true, check, site, approval: creditApprovalFor(stricter.decision) };
}

type ApprovalRow = typeof creditApprovals.$inferSelect;

const subjectColumn = (subject: Pick<SaleSubject, 'type'>) =>
  subject.type === 'sales_order' ? creditApprovals.salesOrderId : creditApprovals.taxDocumentId;

/** The sale's newest pending or approved approval, locked. */
export async function openApprovalOf(
  tx: Transaction,
  subject: Pick<SaleSubject, 'type' | 'id'>,
): Promise<ApprovalRow | null> {
  const [row] = await tx
    .select()
    .from(creditApprovals)
    .where(
      and(
        eq(subjectColumn(subject), subject.id),
        inArray(creditApprovals.status, ['pending', 'approved']),
      ),
    )
    .orderBy(desc(creditApprovals.createdAt), desc(creditApprovals.number))
    .limit(1)
    .for('update');
  return row ?? null;
}

/** An approval as orders, invoices and refusals mention it. */
export async function approvalSummary(
  tx: Transaction,
  row: ApprovalRow,
): Promise<CreditApprovalSummary> {
  const [requester] = (await tx
    .select({ name: users.fullName })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.id, row.requestedByMemberId))) as [{ name: string }];
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    level: row.level,
    requestedBy: { memberId: row.requestedByMemberId, name: requester.name },
    createdAt: row.createdAt.toISOString(),
  };
}

/** The sale's newest approval of any status, for its view; null when it never needed one. */
export async function latestApprovalOf(
  tx: Transaction,
  subject: Pick<SaleSubject, 'type' | 'id'>,
): Promise<CreditApprovalSummary | null> {
  const [row] = await tx
    .select()
    .from(creditApprovals)
    .where(eq(subjectColumn(subject), subject.id))
    .orderBy(desc(creditApprovals.createdAt), desc(creditApprovals.number))
    .limit(1);
  return row ? approvalSummary(tx, row) : null;
}

const NOUN = { sales_order: 'order', tax_document: 'bill' } as const;
const WHO = { manager: 'a manager', owner: 'the owner' } as const;

/** An approval's level: every sale approval has one (credit_approvals_subject). */
export const levelOf = (row: { readonly level: CreditApprovalLevel | null }) =>
  ([row.level] as [CreditApprovalLevel])[0];

/** Why a sale needs approval, or is blocked, in words (the stricter check speaks). */
function explain(subject: SaleSubject, credit: SaleCreditView): string {
  // A sale on credit always has its check.
  const [party] = [credit.check] as [CreditCheck];
  const site =
    credit.site !== null && stricterCheck(party, credit.site.check) !== party ? credit.site : null;
  const check = site === null ? party : site.check;
  if (check.decision === 'blocked') {
    const reason = String(check.blockedBecause).replaceAll('_', ' ');
    return site === null
      ? `Credit is blocked for this customer (${reason})`
      : `Credit is blocked on the site ${site.projectName} (${reason})`;
  }
  const who = WHO[credit.approval as CreditApprovalLevel];
  const percent = String(check.utilizationPercent);
  return site === null
    ? `This ${NOUN[subject.type]} takes the customer to ${percent}% of their limit: ${who} must approve`
    : `This ${NOUN[subject.type]} takes the site ${site.projectName} to ${percent}% of its limit: ${who} must approve`;
}

/** Inserts an approval with the next AP number; returns its row. */
export async function insertApproval(
  tx: Transaction,
  auth: AuthContext,
  values: Omit<
    PgInsertValue<typeof creditApprovals>,
    'organizationId' | 'number' | 'requestedByMemberId'
  >,
): Promise<ApprovalRow> {
  const organizationId = auth.organization.id;
  const number = formatDocumentNumber(
    'AP',
    await nextDocumentNumber(tx, organizationId, 'credit_approval'),
  );
  const [row] = (await tx
    .insert(creditApprovals)
    .values({ ...values, organizationId, number, requestedByMemberId: auth.memberId })
    .returning()) as [ApprovalRow];
  return row;
}

/** Marks an approved approval as used by the sale. */
async function markUsed(tx: Transaction, id: string): Promise<void> {
  await tx
    .update(creditApprovals)
    .set({ status: 'used', usedAt: sql`now()` })
    .where(eq(creditApprovals.id, id));
}

/** Closes what is still open on a sale that went ahead without needing it. */
async function cancelOpen(
  tx: Transaction,
  auth: AuthContext,
  subject: Pick<SaleSubject, 'type' | 'id'>,
): Promise<void> {
  await tx
    .update(creditApprovals)
    .set({ status: 'cancelled', decidedByMemberId: auth.memberId, decidedAt: sql`now()` })
    .where(and(eq(subjectColumn(subject), subject.id), eq(creditApprovals.status, 'pending')));
  await tx
    .update(creditApprovals)
    .set({ status: 'cancelled' })
    .where(and(eq(subjectColumn(subject), subject.id), eq(creditApprovals.status, 'approved')));
}

/**
 * Lets a sale go ahead past the credit rules only with an approval (MVP 3 spec
 * §4.3): an approved one that still covers it, or the member's own approval in
 * the dialog (`override`) when they may give it. Otherwise refuses with a 409
 * CreditApprovalRefusal. Returns the approval used, or null when none was
 * needed. The caller has locked the party.
 */
export async function gateSale(
  tx: Transaction,
  auth: AuthContext,
  subject: SaleSubject,
  credit: SaleCreditView,
  override?: { readonly reason: string },
): Promise<string | null> {
  const refusalOf = (
    code: CreditApprovalRefusal['code'],
    message: string,
    approval: CreditApprovalSummary | null,
  ) => {
    const refusal: CreditApprovalRefusal = { statusCode: 409, code, message, credit, approval };
    return new ConflictException(refusal);
  };
  // No approval can let a blocked sale through, whatever is open for it.
  if (credit.approval === 'blocked') {
    throw refusalOf('credit_blocked', explain(subject, credit), null);
  }
  if (credit.approval === 'none') {
    await cancelOpen(tx, auth, subject);
    return null;
  }
  const open = await openApprovalOf(tx, subject);
  const summary = open === null ? null : await approvalSummary(tx, open);
  const refuse = (code: CreditApprovalRefusal['code'], message: string) =>
    refusalOf(code, message, summary);
  const level = credit.approval;
  if (
    open?.status === 'approved' &&
    approvalCovers(levelOf(open), open.check as unknown as SaleCreditView, credit)
  ) {
    await markUsed(tx, open.id);
    return open.id;
  }
  if (override !== undefined) {
    if (!canApproveSale(level, { ...auth, roleKey: auth.role.key }, subject.storeId)) {
      throw refuse(
        'credit_override_not_allowed',
        `Only ${WHO[level]} can approve this ${NOUN[subject.type]}`,
      );
    }
    // The member approves in the dialog: a pending request at the level needed
    // is decided by them; anything else open gives way to a new approval.
    if (open?.status === 'pending' && levelCovers(levelOf(open), level)) {
      await tx
        .update(creditApprovals)
        .set({
          status: 'approved',
          decidedByMemberId: auth.memberId,
          decidedAt: sql`now()`,
          decisionReason: override.reason,
        })
        .where(eq(creditApprovals.id, open.id));
      await markUsed(tx, open.id);
      return open.id;
    }
    if (open !== null) await cancelOpen(tx, auth, subject);
    const approval = await insertApproval(tx, auth, {
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
      reason: override.reason,
      status: 'used',
      decidedByMemberId: auth.memberId,
      decidedAt: sql`now()`,
      decisionReason: override.reason,
      usedAt: sql`now()`,
    });
    return approval.id;
  }
  if (open?.status === 'pending') {
    throw refuse(
      'credit_approval_pending',
      `${open.number} is waiting for ${WHO[levelOf(open)]} to approve`,
    );
  }
  if (open !== null) {
    throw refuse(
      'credit_approval_stale',
      `${open.number} no longer covers this ${NOUN[subject.type]}: ask again`,
    );
  }
  throw refuse('credit_approval_required', explain(subject, credit));
}

/** Who is told a sale needs approval: the store's managers, or the owners. */
export function approversOf(level: CreditApprovalLevel, storeId: string): Notice['to'] {
  return level === 'owner' ? { roleKey: 'owner' } : { storeId, permission: 'credit:approve_sale' };
}

/** Tells the approvers about a new pending approval. */
export async function announceApproval(
  tx: Transaction,
  notifier: Notifier,
  auth: AuthContext,
  approval: ApprovalRow,
  partyName: string,
): Promise<void> {
  const what =
    approval.kind === 'release'
      ? 'Release the credit hold'
      : `${formatINR(approval.amountPaise)} on credit`;
  await notifier.notify(tx, {
    organizationId: approval.organizationId,
    event: 'credit_approval_requested',
    to:
      approval.kind === 'release'
        ? { storeId: approval.storeId, permission: 'credit:approve' }
        : approversOf(levelOf(approval), String(approval.storeId)),
    actorMemberId: auth.memberId,
    title: `Credit approval ${approval.number}: ${partyName}`,
    body: `${what} — ${approval.reason}`,
    link: `${APPROVAL_PATH}/${approval.id}`,
  });
}
