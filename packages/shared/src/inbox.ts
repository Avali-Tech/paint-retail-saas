// The "Needs action" inbox (docs/mvp-3/navigation-ux.md §6, step 2): everything
// waiting on one member, from the queues that already exist, in one place.

/** The kinds of item, in the order the inbox shows its groups. */
export const INBOX_KINDS = [
  'credit_approval',
  'credit_request',
  'transfer',
  'stock_count',
  'escalation',
  'follow_up',
  'low_stock',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** What an item asks of the member, within its kind. */
export const INBOX_STEPS = [
  // credit_approval
  'approve_sale',
  'approve_release',
  // credit_request
  'decide_request',
  // transfer
  'approve_transfer',
  'dispatch_transfer',
  'receive_transfer',
  // stock_count
  'approve_count',
  // escalation
  'acknowledge_escalation',
  // follow_up
  'follow_up_overdue',
  'follow_up_today',
  // low_stock
  'out_of_stock',
  'below_minimum',
  'reorder',
] as const;
export type InboxStep = (typeof INBOX_STEPS)[number];

export const INBOX_PRIORITIES = ['high', 'normal', 'low'] as const;
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];

/** An action the inbox can take on an item without opening it, through an existing endpoint. */
export type InboxActionKey = 'approve' | 'reject' | 'acknowledge' | 'complete';

export interface InboxAction {
  readonly key: InboxActionKey;
  /** The existing endpoint it posts to, e.g. /credit-approvals/{id}/approve. */
  readonly endpoint: string;
  /** What the member gives first: nothing, an optional note, or a reason (required). */
  readonly input: 'none' | 'note' | 'reason';
}

export interface InboxItem {
  readonly kind: InboxKind;
  readonly id: string;
  readonly step: InboxStep;
  /** The record's number (AP-000012, TR-000003…), a SKU, or null. */
  readonly reference: string | null;
  /** What it is about: a customer, two stores, a product, a follow-up's subject. */
  readonly title: string;
  /** Who asked for it or sent it, when someone did. */
  readonly requestedBy: string | null;
  readonly store: { readonly id: string; readonly name: string } | null;
  readonly amountPaise: number | null;
  /** Since when it waits (an ISO time or date); null when it has no start (low stock). */
  readonly since: string | null;
  /** When it is or was due (an ISO time or date), or null. */
  readonly due: string | null;
  /** For low stock: what is available, the reorder level and the quantity to order. */
  readonly quantity: {
    readonly available: number;
    readonly reorderLevel: number;
    readonly suggested: number;
    readonly unit: string;
  } | null;
  readonly priority: InboxPriority;
  /** The full record, in the web app. */
  readonly link: string;
  /** What the member may do from the inbox; the rest is done on the record. */
  readonly actions: readonly InboxAction[];
}

export interface InboxGroup {
  readonly kind: InboxKind;
  /** Every such item waiting, of which `items` are the first. */
  readonly total: number;
  readonly items: readonly InboxItem[];
}

/** GET /inbox. */
export interface InboxView {
  /** The kinds this member can be asked about, in order (each a possible filter). */
  readonly kinds: readonly InboxKind[];
  /** The groups with something waiting, in the order of INBOX_KINDS. */
  readonly groups: readonly InboxGroup[];
  readonly total: number;
}

/** GET /inbox/count: for the badge. */
export interface InboxCount {
  readonly total: number;
}

/** GET /inbox query. */
export interface InboxQuery {
  readonly kind?: InboxKind;
  readonly storeId?: string;
}

/** How many items of a kind the inbox shows before "see all". */
export const INBOX_GROUP_LIMIT = 20;
