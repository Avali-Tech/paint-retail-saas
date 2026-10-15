import { schema, type Transaction } from '@paint/db';
import type { PromiseView } from '@paint/shared';
import { sql, type SQL } from 'drizzle-orm';

const { promisesToPay } = schema;

/**
 * What a party has paid towards a promise (spec §6.1, rule CO-3): money
 * received from the day the promise was made to `until` (its date, or today while
 * it is open), cheques that bounced left out. Payments, not allocations, so money
 * taken as an advance still counts (after draft PR #51 CO-4).
 */
export function paidTowards(
  promise: { readonly partyId: SQL | string; readonly madeOn: SQL | string },
  until: SQL | string,
): SQL<number> {
  return sql<number>`(select coalesce(sum(pm.amount_paise), 0)::bigint from payments pm
    where pm.party_id = ${promise.partyId} and pm.direction = 'in'
      and pm.received_on between ${promise.madeOn}::date and ${until}::date
      and pm.cheque_status is distinct from 'bounced')`.mapWith(Number);
}

/**
 * The promise's own columns, qualified: inside a subquery an unqualified name would
 * bind to the subquery's table (payments has a party_id too).
 */
export const PROMISE = {
  partyId: sql.raw('promises_to_pay.party_id'),
  madeOn: sql.raw('promises_to_pay.made_on'),
} as const;

/** The columns of a promise view, with what has been paid so far for an open one. */
export function promiseColumns(today: SQL | string) {
  return {
    id: promisesToPay.id,
    partyId: promisesToPay.partyId,
    amountPaise: promisesToPay.amountPaise,
    promisedOn: promisesToPay.promisedOn,
    madeOn: promisesToPay.madeOn,
    status: promisesToPay.status,
    note: promisesToPay.note,
    paidPaise: sql<number>`coalesce(${promisesToPay.paidPaise}, ${paidTowards(
      PROMISE,
      sql`least(promises_to_pay.promised_on, ${today}::date)`,
    )})`.mapWith(Number),
    createdBy: sql<string>`(select u.full_name from organization_members m join users u on u.id = m.user_id
      where m.id = promises_to_pay.created_by_member_id)`,
    createdAt: promisesToPay.createdAt,
    closedAt: promisesToPay.closedAt,
    cancelReason: promisesToPay.cancelReason,
  };
}

type PromiseRow = Omit<PromiseView, 'createdAt' | 'closedAt'> & {
  readonly createdAt: Date;
  readonly closedAt: Date | null;
};

export function promiseView(row: PromiseRow): PromiseView {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** The promises of the given rows' query, as views. */
export async function promiseViews(
  tx: Transaction,
  today: string,
  where: SQL,
): Promise<PromiseView[]> {
  const rows = await tx
    .select(promiseColumns(today))
    .from(promisesToPay)
    .where(where)
    .orderBy(sql`${promisesToPay.createdAt} desc`, sql`${promisesToPay.id} desc`);
  return rows.map(promiseView);
}
