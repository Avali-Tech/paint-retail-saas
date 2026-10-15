import type { MessageChannel } from '../messaging/templates.js';
import type { Permission } from '../permissions.js';
import type { AgeingBucket } from '../receivables/ageing.js';

// The collections API (roadmap P2-M11, spec §6.1). Amounts in paise, dates India dates.

/** Recording and cancelling promises, acknowledging escalations: who chases credit. */
export const COLLECTIONS_MANAGE_PERMISSION = 'credit:manage' as const satisfies Permission;
/** Setting when reminders go out: who sets the credit rules. */
export const REMINDER_SETTINGS_PERMISSION = 'credit:approve' as const satisfies Permission;

export const PROMISE_STATUSES = ['open', 'kept', 'broken', 'cancelled'] as const;
export type PromiseStatus = (typeof PROMISE_STATUSES)[number];

/** What to do next about a party on the worklist, most urgent first. */
export const NEXT_STEPS = [
  'acknowledge_escalation',
  'follow_up_promise',
  'await_promise',
  'contact',
] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export interface PromiseView {
  readonly id: string;
  readonly partyId: string;
  readonly amountPaise: number;
  readonly promisedOn: string;
  readonly madeOn: string;
  readonly status: PromiseStatus;
  readonly note: string | null;
  /** Payments received since it was made (cheques not bounced); settled ones keep the count. */
  readonly paidPaise: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly cancelReason: string | null;
}

export interface CreatePromiseBody {
  readonly amountPaise: number;
  readonly promisedOn: string;
  readonly note?: string;
}

export interface WorklistRow {
  readonly partyId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly salesperson: { readonly id: string; readonly name: string } | null;
  /** Everything owed on bills, and the part past its due date. */
  readonly outstandingPaise: number;
  readonly overduePaise: number;
  readonly maxDaysPastDue: number;
  readonly oldestBucket: AgeingBucket;
  readonly lastActivity: {
    readonly type: string;
    readonly subject: string;
    readonly at: string;
  } | null;
  readonly openPromise: PromiseView | null;
  readonly openEscalationId: string | null;
  readonly nextStep: NextStep;
}

/** GET /collections/worklist. */
export interface WorklistQuery {
  /** Only customers this member looks after ("none": nobody does; "me": the caller). */
  readonly salespersonId?: string;
  readonly storeId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorklistPage {
  readonly asOf: string;
  readonly rows: readonly WorklistRow[];
  readonly total: number;
  readonly overduePaise: number;
}

export interface EscalationView {
  readonly id: string;
  readonly party: { readonly id: string; readonly name: string };
  readonly promise: PromiseView;
  readonly raisedOn: string;
  readonly notifiedCount: number;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgeNote: string | null;
}

export interface ReminderScheduleView {
  readonly id: string;
  /** Days from a bill's due date: negative before it, 0 on the day. */
  readonly offsetDays: number;
  readonly channels: readonly MessageChannel[];
  readonly isActive: boolean;
}

export interface ReminderScheduleInput {
  readonly offsetDays: number;
  readonly channels: readonly MessageChannel[];
  readonly isActive: boolean;
}
