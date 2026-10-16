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

/** How long a link lives unless PAYMENT_LINK_EXPIRY_DAYS says otherwise ([PO-41]). */
export const DEFAULT_PAYMENT_LINK_DAYS = 7;

/** The most one link may ask for: ₹10,00,000 ([PO-42]: UPI limits are the gateway's). */
export const MAX_PAYMENT_LINK_PAISE = 100_000_000;

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
}

const sum = (targets: readonly LinkTarget[]) =>
  targets.reduce((total, target) => total + target.outstandingPaise, 0);

/**
 * What a link asks for (rules PL-2, PL-3): its documents and its amount. A link never
 * asks for more than the party owes net of its advance, so a statement's balance and
 * its link agree; a custom amount may be lower, or anything when it is an advance.
 */
export function planPaymentLink(input: LinkPlanInput): LinkPlan {
  const requested = input.amountPaise;
  if (requested !== undefined && requested > MAX_PAYMENT_LINK_PAISE) {
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
  const duePaise = Math.min(owed, balance);
  if (duePaise <= 0) return { ok: false, problem: 'covered_by_advance' };
  if (requested !== undefined && requested > duePaise) return { ok: false, problem: 'over_due' };
  return { ok: true, targets, amountPaise: requested ?? duePaise, duePaise };
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
