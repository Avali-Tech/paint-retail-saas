/** How long before the end of a contract its assignee is reminded, unless they choose a date. */
export const RENEWAL_NOTICE_DAYS = 30;

/** A calendar date (YYYY-MM-DD) moved by a number of days. */
export function addDays(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

/**
 * The default day to act on renewal: 30 days before the end, but never before
 * the contract starts (a short contract is reminded on its first day).
 */
export function defaultRenewalDate(startDate: string, endDate: string): string {
  const notice = addDays(endDate, -RENEWAL_NOTICE_DAYS);
  return notice < startDate ? startDate : notice;
}

/** Today's date in India (YYYY-MM-DD), whatever the server's time zone. */
export function todayInIndia(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
