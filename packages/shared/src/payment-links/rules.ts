/**
 * UPI payment links (roadmap P2-M32, MVP 3 round 4a; spec §6.2 rules PL-1 – PL-12):
 * what a link asks for, where the money goes when it is paid, and how its status moves
 * whatever order a gateway's events arrive in. Pure: the API loads the rows and calls
 * these. Money is integer paise.
 */

/** What a link asks the party to pay (`payment_links.purpose`). */
export const PAYMENT_LINK_PURPOSES = [
  'invoice',
  'overdue',
  'outstanding',
  'bills',
  'advance',
] as const;
export type PaymentLinkPurpose = (typeof PAYMENT_LINK_PURPOSES)[number];

/** What a member may ask for; `bills` is the reminder run's (the bills a reminder named). */
export const STAFF_LINK_PURPOSES = ['invoice', 'overdue', 'outstanding', 'advance'] as const;
export type StaffLinkPurpose = (typeof STAFF_LINK_PURPOSES)[number];

/** Who made a link. */
export const PAYMENT_LINK_ORIGINS = ['staff', 'reminder', 'statement'] as const;
export type PaymentLinkOrigin = (typeof PAYMENT_LINK_ORIGINS)[number];

/** As stored: `expired` is written when the gateway says so; a view also reads the clock. */
export const PAYMENT_LINK_STATUSES = ['created', 'paid', 'expired', 'cancelled'] as const;
export type PaymentLinkStatus = (typeof PAYMENT_LINK_STATUSES)[number];

/** Minutes a link stays payable unless the business sets otherwise ([PO-41]: decided 10). */
export const DEFAULT_LINK_VALIDITY_MINUTES = 10;
/** The shortest and longest validity a business may set: 5 minutes to 30 days. */
export const MIN_LINK_VALIDITY_MINUTES = 5;
export const MAX_LINK_VALIDITY_MINUTES = 43_200;
/**
 * Minutes a link sent in a message stays payable unless the business sets otherwise
 * ([PO-61]: decided, a day): messages wait in the outbox and are read later.
 */
export const DEFAULT_MESSAGE_LINK_VALIDITY_MINUTES = 1_440;
/** Razorpay refuses a link that expires sooner than 15 minutes ahead ([PO-60]: decided). */
export const RAZORPAY_MIN_LINK_VALIDITY_MINUTES = 15;

/** Which validity a link takes: a counter (or manual) link's, or a message's ([PO-61]). */
export const LINK_VALIDITY_KINDS = ['counter', 'message'] as const;
export type LinkValidityKind = (typeof LINK_VALIDITY_KINDS)[number];

/** The shortest validity a business may set with this gateway ([PO-60]). */
export function minLinkValidityMinutes(gateway: 'log' | 'razorpay' | null): number {
  return gateway === 'razorpay' ? RAZORPAY_MIN_LINK_VALIDITY_MINUTES : MIN_LINK_VALIDITY_MINUTES;
}

/**
 * Minutes a link of this kind stays payable: the business's validity for counter links
 * or for links in messages, never below what the gateway accepts ([PO-60], [PO-61]).
 */
export function linkValidityMinutes(
  kind: LinkValidityKind,
  rules: { readonly validityMinutes: number; readonly messageValidityMinutes: number },
  gateway: 'log' | 'razorpay' | null,
): number {
  const minutes = kind === 'message' ? rules.messageValidityMinutes : rules.validityMinutes;
  return Math.max(minutes, minLinkValidityMinutes(gateway));
}

/** The most one link asks for unless the business sets otherwise ([PO-42]: ₹1,00,000). */
export const DEFAULT_LINK_CAP_PAISE = 10_000_000;
/** Razorpay's smallest payment (₹1) and UPI's highest per-payment limit (₹5,00,000). */
export const MIN_LINK_CAP_PAISE = 100;
export const MAX_LINK_CAP_PAISE = 50_000_000;

/**
 * What a link asks for ([PO-43]): `net` of the party's advance (the default: a
 * statement's balance and its link agree) or the bills' `full` outstanding.
 */
export const LINK_AMOUNT_BASES = ['net', 'full'] as const;
export type LinkAmountBasis = (typeof LINK_AMOUNT_BASES)[number];

/** Something the party owes, oldest first, as the API's `openTargets` gives it. */
export interface LinkTarget {
  readonly documentId: string | null;
  readonly partyLedgerId: string | null;
  readonly number: string | null;
  readonly dueOn: string | null;
  readonly outstandingPaise: number;
}

export type LinkPlanProblem =
  /** The invoice (or a reminded bill) has nothing left to pay. */
  | 'not_open'
  /** Nothing of this kind is owed (no overdue bills, a zero balance). */
  | 'nothing_due'
  /** The party's advance already covers what is owed: allocate it instead. */
  | 'covered_by_advance'
  /** A custom amount above what is owed, not marked as an advance. */
  | 'over_due'
  /** An advance needs an amount. */
  | 'amount_required'
  | 'over_limit';

export type LinkPlan =
  | {
      readonly ok: true;
      /** The documents the link pays, oldest first. */
      readonly targets: readonly LinkTarget[];
      /** What it asks for. */
      readonly amountPaise: number;
      /** The most it could ask for (the cap of a custom amount). */
      readonly duePaise: number;
    }
  | { readonly ok: false; readonly problem: LinkPlanProblem };

export interface LinkPlanInput {
  readonly purpose: PaymentLinkPurpose;
  /** The party's open documents, oldest first. */
  readonly open: readonly LinkTarget[];
  /** The party's unallocated money. */
  readonly advancePaise: number;
  /** India date: a bill is overdue once its due date is before it. */
  readonly today: string;
  /** `invoice`: the invoice; `bills`: the reminded bills. */
  readonly documentIds?: readonly string[];
  /** A custom amount; required for an advance. */
  readonly amountPaise?: number;
  /** The most the link may ask for (the business's cap; default ₹1,00,000). */
  readonly capPaise?: number;
  /** Net of the advance (default) or the bills' full outstanding. */
  readonly basis?: LinkAmountBasis;
}

const sum = (targets: readonly LinkTarget[]) =>
  targets.reduce((total, target) => total + target.outstandingPaise, 0);

/**
 * What a link asks for (rules PL-2, PL-3, PL-13): its documents and its amount. With the
 * `net` basis a link never asks for more than the party owes net of its advance, so a
 * statement's balance and its link agree; with `full` it asks for the bills' whole
 * outstanding. A custom amount may be lower, or anything when it is an advance; nothing
 * above the business's cap.
 */
export function planPaymentLink(input: LinkPlanInput): LinkPlan {
  const requested = input.amountPaise;
  const cap = input.capPaise ?? DEFAULT_LINK_CAP_PAISE;
  if (requested !== undefined && requested > cap) {
    return { ok: false, problem: 'over_limit' };
  }
  if (input.purpose === 'advance') {
    return requested === undefined
      ? { ok: false, problem: 'amount_required' }
      : { ok: true, targets: [], amountPaise: requested, duePaise: requested };
  }
  const wanted = new Set(input.documentIds ?? []);
  const targets = input.open.filter((target) => {
    switch (input.purpose) {
      case 'invoice':
      case 'bills':
        return target.documentId !== null && wanted.has(target.documentId);
      case 'overdue':
        return target.dueOn !== null && target.dueOn < input.today;
      default:
        return true;
    }
  });
  const owed = sum(targets);
  if (owed === 0) {
    return {
      ok: false,
      problem:
        input.purpose === 'invoice' || input.purpose === 'bills' ? 'not_open' : 'nothing_due',
    };
  }
  const balance = sum(input.open) - input.advancePaise;
  const duePaise = input.basis === 'full' ? owed : Math.min(owed, balance);
  if (duePaise <= 0) return { ok: false, problem: 'covered_by_advance' };
  if (requested !== undefined && requested > duePaise) return { ok: false, problem: 'over_due' };
  const amountPaise = requested ?? duePaise;
  if (amountPaise > cap) return { ok: false, problem: 'over_limit' };
  return { ok: true, targets, amountPaise, duePaise };
}

/** One allocation of a link payment. */
export interface LinkAllocation {
  readonly documentId: string | null;
  readonly partyLedgerId: string | null;
  readonly amountPaise: number;
}

/**
 * Where a link payment goes (rules PL-6, PL-7): its documents in order, each up to what
 * is owed on it now (something else may have paid it meanwhile), and the rest is an
 * advance: an overpayment, or money for a bill already settled.
 */
export function allocateLinkPayment(
  targets: readonly LinkTarget[],
  amountPaise: number,
): { readonly allocations: readonly LinkAllocation[]; readonly advancePaise: number } {
  const allocations: LinkAllocation[] = [];
  let left = amountPaise;
  for (const target of targets) {
    const amount = Math.min(left, target.outstandingPaise);
    if (amount <= 0) continue;
    allocations.push({
      documentId: target.documentId,
      partyLedgerId: target.partyLedgerId,
      amountPaise: amount,
    });
    left -= amount;
  }
  return { allocations, advancePaise: left };
}

/** What a gateway said happened to a link. */
export type LinkEventKind = 'paid' | 'expired' | 'cancelled';

export interface LinkState {
  readonly status: PaymentLinkStatus;
  readonly amountPaise: number;
  readonly paidPaise: number;
}

/**
 * A link after an event (rule PL-9). Money is always counted: a payment after expiry
 * or cancellation still makes the link paid once it covers the amount; a part payment
 * leaves it as it was. An expiry or cancellation only ends a link still open, so a late
 * `expired` never undoes a payment, whatever order the events came in.
 */
export function nextLinkState(
  link: LinkState,
  event: LinkEventKind,
  paidPaise = 0,
): { readonly status: PaymentLinkStatus; readonly paidPaise: number } {
  if (event === 'paid') {
    const paid = link.paidPaise + paidPaise;
    return { status: paid >= link.amountPaise ? 'paid' : link.status, paidPaise: paid };
  }
  return {
    status: link.status === 'created' ? event : link.status,
    paidPaise: link.paidPaise,
  };
}

/** The status to show: an open link past its expiry is expired, whatever the gateway said. */
export function linkStatusAt(
  status: PaymentLinkStatus,
  expiresAt: string,
  now: Date,
): PaymentLinkStatus {
  return status === 'created' && Date.parse(expiresAt) <= now.getTime() ? 'expired' : status;
}

/** Why money a link took goes back through the gateway ([PO-44]). */
export type LinkRefundReason = 'settled' | 'overpaid';

/**
 * What of a link payment goes back through the gateway (rule PL-15, [PO-44]): for a
 * link that pays bills, whatever its bills no longer owed (they were settled some other
 * way, or more came than they owed). An advance link's money is all wanted. Null when
 * nothing goes back.
 */
export function linkRefundOf(input: {
  readonly purpose: PaymentLinkPurpose;
  readonly amountPaise: number;
  readonly advancePaise: number;
}): { readonly amountPaise: number; readonly reason: LinkRefundReason } | null {
  if (input.purpose === 'advance' || input.advancePaise <= 0) return null;
  return {
    amountPaise: input.advancePaise,
    reason: input.advancePaise === input.amountPaise ? 'settled' : 'overpaid',
  };
}

/** Status of a refund through the gateway (`payment_link_refunds.status`). */
export const LINK_REFUND_STATUSES = [
  'pending',
  'refunded',
  'failed',
  'dropped',
  'returned',
] as const;
export type LinkRefundStatus = (typeof LINK_REFUND_STATUSES)[number];

/** Minutes before each try after a failed one: 1 minute, then up to a day. */
const REFUND_RETRY_MINUTES = [1, 5, 30, 120, 720] as const;
/** Tries before a refund is given up and the money stays an advance (rule PL-16). */
export const MAX_REFUND_ATTEMPTS = REFUND_RETRY_MINUTES.length + 1;

/**
 * When to try a refund again after `attempts` failed tries (rule PL-16): sooner at first,
 * then up to half a day apart; null once the tries are used up.
 */
export function refundRetryMinutes(attempts: number): number | null {
  return attempts >= 1 && attempts < MAX_REFUND_ATTEMPTS
    ? (REFUND_RETRY_MINUTES[attempts - 1] as number)
    : null;
}
