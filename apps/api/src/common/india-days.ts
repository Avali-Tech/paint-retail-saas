import { and, sql, type AnyColumn, type SQL } from 'drizzle-orm';

/** A moment (column or expression) within India-time calendar days, inclusive at both ends. */
export function withinIndiaDays(
  moment: AnyColumn | SQL,
  from?: string,
  to?: string,
): SQL | undefined {
  return and(
    from ? sql`${moment} >= (${from}::date)::timestamp at time zone 'Asia/Kolkata'` : undefined,
    to ? sql`${moment} < (${to}::date + 1)::timestamp at time zone 'Asia/Kolkata'` : undefined,
  );
}
