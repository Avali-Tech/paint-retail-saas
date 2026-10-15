/**
 * Credit enforcement (MVP 3 round 1a, P2-M09; docs/mvp-3/credit-and-receivables.md
 * §3.2–§4.4, §5.1): the shapes the API answers and the screens read, and the
 * approval rules both apply. Amounts are integer paise, dates India-time
 * `YYYY-MM-DD`, instants ISO timestamps.
 */
import type {
  AgeingBucket,
  CreditApprovalLevel,
  CreditCheck,
  CreditRules,
  CreditStatus,
} from './credit.js';
import { levelCovers } from './credit.js';
import type { ListPageInfo } from './list-page.js';
import type { CreditApproval, OrderCreditView } from './orders-api.js';
import type { Permission } from './permissions.js';

export type { CreditApprovalLevel } from './credit.js';

export const CREDIT_APPROVAL_KINDS = ['sale', 'release'] as const;
export type CreditApprovalKind = (typeof CREDIT_APPROVAL_KINDS)[number];

export const CREDIT_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'used',
] as const;
export type CreditApprovalStatus = (typeof CREDIT_APPROVAL_STATUSES)[number];

export const SITE_ACCOUNT_STATUSES = ['active', 'on_hold', 'closed'] as const;
export type SiteAccountStatus = (typeof SITE_ACCOUNT_STATUSES)[number];

export type CreditHoldKind = 'manual' | 'auto';

/** Who approves the release of a hold (and changes site limits). */
export const CREDIT_RELEASE_PERMISSION: Permission = 'credit:approve';

/** A release may waive the overdue block for at most this many days ([PO-11]). */
export const MAX_OVERDUE_WAIVER_DAYS = 90;

/** Where a party, or a site, stands for a sale on credit (a check at confirm or issue). */
export type SaleCreditView = OrderCreditView;

/** A site account's position for a sale: its own limit and exposure (spec §3.3). */
export interface SiteCreditPosition {
  readonly siteAccountId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly status: SiteAccountStatus;
  readonly limitPaise: number;
  /** The site's outstanding documents and open postpaid orders, without the sale checked. */
  readonly exposurePaise: number;
  /** checkCredit against the site's limit and status, with the party's overdue days. */
  readonly check: CreditCheck;
}

export interface CreditPerson {
  readonly memberId: string;
  readonly name: string;
}

/** An approval as orders, invoices and refusals mention it. */
export interface CreditApprovalSummary {
  readonly id: string;
  /** e.g. `AP-000004`. */
  readonly number: string;
  readonly status: CreditApprovalStatus;
  readonly level: CreditApprovalLevel | null;
  readonly requestedBy: CreditPerson;
  readonly createdAt: string;
}

/** What an approval is about. */
export interface CreditApprovalSubject {
  readonly type: 'sales_order' | 'tax_document';
  readonly id: string;
  /** The order number, or the invoice's once issued (null for a draft invoice). */
  readonly number: string | null;
}

export interface CreditApprovalView extends CreditApprovalSummary {
  readonly kind: CreditApprovalKind;
  readonly party: { readonly id: string; readonly name: string };
  readonly site: { readonly projectId: string; readonly name: string } | null;
  readonly store: { readonly id: string; readonly name: string } | null;
  readonly subject: CreditApprovalSubject | null;
  readonly amountPaise: number;
  readonly reason: string;
  /** The credit position when it was asked (sales only). */
  readonly checkAtRequest: SaleCreditView | null;
  readonly decidedBy: CreditPerson | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly waiveOverdueUntil: string | null;
  readonly usedAt: string | null;
  /** Whether the member reading it may approve or reject it now. */
  readonly canDecide: boolean;
}

/** GET /credit-approvals/:id: also where the sale stands now, while it is open. */
export interface CreditApprovalDetail extends CreditApprovalView {
  readonly checkNow: SaleCreditView | null;
}

/** GET /credit-approvals?status&kind&partyId&mine&limit&offset: pending oldest first, others newest first. */
export interface CreditApprovalPage extends ListPageInfo {
  readonly items: readonly CreditApprovalView[];
}

/**
 * POST /credit-approvals: approval for a sale (an order to confirm or a draft
 * invoice to issue on credit, `amountPaise` defaulting to the invoice total)
 * or for releasing a party's hold.
 */
export type CreateCreditApprovalRequest =
  | {
      readonly salesOrderId: string;
      readonly reason: string;
    }
  | {
      readonly invoiceId: string;
      /** What stays unpaid at issue; defaults to the draft's total. */
      readonly amountPaise?: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'release';
      readonly partyId: string;
      readonly reason: string;
    };

/** POST /credit-approvals/:id/approve. */
export interface ApproveCreditRequest {
  readonly reason?: string;
  /** Release only: waive the overdue block until this date (at most 90 days ahead). */
  readonly waiveOverdueUntil?: string;
}

/** POST /credit-approvals/:id/reject. */
export interface RejectCreditRequest {
  readonly reason: string;
}

/** POST /parties/:id/credit/release by an approver. */
export interface ReleaseCreditRequest {
  readonly reason?: string;
  readonly waiveOverdueUntil?: string;
}

/** What a party owes for the credit rules, after go-live (spec §4.1). */
export interface ExposureBreakdown {
  /** party_balances.balance_paise: open documents less unallocated money. */
  readonly balancePaise: number;
  /** Unbilled value of open postpaid orders. */
  readonly openOrdersPaise: number;
  /** Unallocated money (already netted in the balance). */
  readonly advancePaise: number;
}

/** A party's credit as the customer 360 and the credit screens show it. */
export interface PartyCreditSummary {
  readonly status: CreditStatus;
  readonly limitPaise: number;
  readonly creditDays: number;
  readonly risk: 'low' | 'medium' | 'high';
  /** Entered by hand until billing went live; read-only after. */
  readonly manualExposurePaise: number;
  /** What the party owes: the manual figure before go-live, the ledger's after. */
  readonly exposurePaise: number;
  readonly exposureSource: 'manual' | 'ledger';
  /** The parts of the live exposure; null before go-live. */
  readonly exposure: ExposureBreakdown | null;
  /** Days the oldest open document is past due (or the manual figure before go-live). */
  readonly overdueDays: number;
  readonly holdKind: CreditHoldKind | null;
  /** Overdue days do not block until this date (a release with approval). */
  readonly overdueWaivedUntil: string | null;
  readonly check: CreditCheck;
  readonly pendingRequest: {
    readonly id: string;
    readonly number: string;
    readonly limitPaise: number;
    readonly creditDays: number;
  } | null;
  /** A release waiting for approval. */
  readonly pendingRelease: CreditApprovalSummary | null;
  readonly sites: readonly SiteAccountView[];
}

/** One site account with its figures (spec §3.3). */
export interface SiteAccountView {
  readonly id: string;
  readonly party: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly number: string; readonly name: string };
  readonly limitPaise: number;
  readonly status: SiteAccountStatus;
  readonly hold: { readonly reason: string; readonly at: string; readonly by: CreditPerson } | null;
  readonly notes: string | null;
  /** Outstanding of the party's documents on this site. */
  readonly outstandingPaise: number;
  /** Unbilled value of the party's open postpaid orders on this site. */
  readonly openOrdersPaise: number;
  readonly exposurePaise: number;
  readonly availablePaise: number;
  readonly utilizationPercent: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A line of a site's ledger view: a document, or money set against one. */
export interface SiteLedgerEntry {
  readonly on: string;
  readonly kind:
    'invoice' | 'bill_of_supply' | 'debit_note' | 'payment' | 'credit_note' | 'reversal';
  readonly documentId: string;
  /** The document's number, or the payment's / credit note's. */
  readonly number: string | null;
  /** The document it concerns (for money set against one). */
  readonly againstNumber: string | null;
  /** Positive: the site owes more. */
  readonly amountPaise: number;
  /** Outstanding on the site after this line. */
  readonly runningPaise: number;
}

export interface SiteOpenDocument {
  readonly documentId: string;
  readonly number: string | null;
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly totalPaise: number;
  readonly outstandingPaise: number;
  readonly daysPastDue: number;
  readonly bucket: AgeingBucket;
}

/** GET /site-accounts/:id. */
export interface SiteAccountDetail extends SiteAccountView {
  readonly ledger: readonly SiteLedgerEntry[];
  readonly openDocuments: readonly SiteOpenDocument[];
  readonly ageing: Readonly<Record<AgeingBucket, number>>;
}

/** POST /parties/:id/sites. */
export interface CreateSiteAccountRequest {
  readonly projectId: string;
  readonly limitPaise: number;
  readonly notes?: string;
}

/** PATCH /site-accounts/:id. */
export interface UpdateSiteAccountRequest {
  readonly limitPaise?: number;
  readonly notes?: string | null;
}

/** GET /credit-rules answers these too. */
export type { CreditRules };

// Rules ---------------------------------------------------------------------

/** The approval level a check result needs, or null when none can be given. */
export function approvalLevelOf(approval: CreditApproval): CreditApprovalLevel | null {
  return approval === 'manager' || approval === 'owner' ? approval : null;
}

/**
 * Whether a member may approve a sale at `level` from the store `storeId`:
 * a manager-level sale needs credit:approve_sale at that store, an owner-level
 * one the Owner role (spec §4.3).
 */
export function canApproveSale(
  level: CreditApprovalLevel,
  member: {
    readonly permissions: ReadonlySet<Permission>;
    readonly roleKey: string;
    readonly allStores: boolean;
    readonly storeIds: ReadonlySet<string>;
  },
  storeId: string,
): boolean {
  if (member.roleKey === 'owner') return true;
  if (level === 'owner') return false;
  return (
    member.permissions.has('credit:approve_sale') &&
    (member.allStores || member.storeIds.has(storeId))
  );
}

/** A check not required (prepaid) is never over any approval. */
const projected = (view: SaleCreditView) =>
  view.check?.projectedExposurePaise ?? Number.NEGATIVE_INFINITY;

/**
 * Whether an approval given at `level` for the sale as it stood (`approved`)
 * still covers it now (spec §4.3): the level needed now is no higher, and the
 * party's and the site's projected exposure are no higher than approved.
 */
export function approvalCovers(
  level: CreditApprovalLevel,
  approved: SaleCreditView,
  now: SaleCreditView,
): boolean {
  const needed = approvalLevelOf(now.approval);
  if (needed === null) return now.approval === 'none';
  if (!levelCovers(level, needed)) return false;
  if (projected(now) > projected(approved)) return false;
  if (now.site === null) return true;
  return (
    approved.site?.siteAccountId === now.site.siteAccountId &&
    now.site.check.projectedExposurePaise <= approved.site.check.projectedExposurePaise
  );
}
