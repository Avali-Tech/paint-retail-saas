import type { TemplateKey } from '../messaging/templates.js';
import type { NextStep } from './api.js';

/** A promise is for a date from today up to this many days ahead ([PO-13]). */
export const PROMISE_MAX_DAYS = 60;

/** Reminder offsets a business starts from (after draft PR #51 CO-8): 3 days before to 30 after. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [-3, 0, 7, 15, 30];

/** Reminder offsets allowed: a month before the due date to three months after. */
export const REMINDER_OFFSET_MIN = -30;
export const REMINDER_OFFSET_MAX = 90;

/** Messages to parties go out between 09:00 and 20:00 India time (spec MSG-6). */
export const QUIET_HOURS = { from: 9, until: 20 } as const;

const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** True when `now` is inside the hours parties may be messaged, India time. */
export function isMessagingHour(now: Date): boolean {
  const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MINUTES) % (24 * 60);
  return minutes >= QUIET_HOURS.from * 60 && minutes < QUIET_HOURS.until * 60;
}

/** The reminder for a bill `offsetDays` from its due date: before or on it, or after it. */
export function reminderTemplate(offsetDays: number): TemplateKey {
  return offsetDays <= 0 ? 'payment_reminder_due' : 'payment_reminder_overdue';
}

/** A promise is kept when the payments counted cover its amount. */
export function promiseKept(amountPaise: number, paidPaise: number): boolean {
  return paidPaise >= amountPaise;
}

/**
 * What to do next about a party with something overdue: acknowledge an
 * escalation first; then follow up a promise whose date has come; wait for one
 * not yet due; otherwise contact the party.
 */
export function nextStep(
  today: string,
  openEscalation: boolean,
  openPromise: { readonly promisedOn: string } | null,
): NextStep {
  if (openEscalation) return 'acknowledge_escalation';
  if (openPromise === null) return 'contact';
  return openPromise.promisedOn <= today ? 'follow_up_promise' : 'await_promise';
}

const STEP_ORDER: Readonly<Record<NextStep, number>> = {
  acknowledge_escalation: 0,
  follow_up_promise: 1,
  contact: 2,
  await_promise: 3,
};

/**
 * Worklist order (spec §6.1): escalations and due promises first, then the
 * oldest debt (most days past due), then the largest overdue amount, then name.
 */
export function compareWorklist(
  a: { nextStep: NextStep; maxDaysPastDue: number; overduePaise: number; name: string },
  b: { nextStep: NextStep; maxDaysPastDue: number; overduePaise: number; name: string },
): number {
  return (
    STEP_ORDER[a.nextStep] - STEP_ORDER[b.nextStep] ||
    b.maxDaysPastDue - a.maxDaysPastDue ||
    b.overduePaise - a.overduePaise ||
    a.name.localeCompare(b.name)
  );
}
