/**
 * Collections (roadmap P2-M11): promises to pay, the worklist, escalations and
 * reminder schedules. Pure rules and API shapes; the API runs them on the books.
 */
export {
  COLLECTIONS_MANAGE_PERMISSION,
  NEXT_STEPS,
  PROMISE_STATUSES,
  REMINDER_SETTINGS_PERMISSION,
  type CreatePromiseBody,
  type EscalationView,
  type NextStep,
  type PromiseStatus,
  type PromiseView,
  type ReminderScheduleInput,
  type ReminderScheduleView,
  type WorklistPage,
  type WorklistQuery,
  type WorklistRow,
} from './api.js';
export {
  DEFAULT_REMINDER_OFFSETS,
  PROMISE_MAX_DAYS,
  QUIET_HOURS,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  compareWorklist,
  isMessagingHour,
  nextStep,
  promiseKept,
  reminderTemplate,
} from './rules.js';
