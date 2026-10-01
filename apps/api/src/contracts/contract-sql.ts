import { schema } from '@paint/db';
import { inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import type { ContractStatus } from './contracts.schemas.js';

const { contracts } = schema;

/** Today's date in India. */
export const todayIst = sql`(now() at time zone 'Asia/Kolkata')::date`;

/** The status as shown: an active contract past its end date is "expired". */
export const contractStatusSql = sql<ContractStatus>`(case when ${contracts.status} = 'active' and ${contracts.endDate} < ${todayIst} then 'expired' else ${contracts.status}::text end)`;

/** Active and its renewal date has come. */
export const renewalDueSql = sql<boolean>`(${contracts.status} = 'active' and ${contracts.renewalDate} <= ${todayIst})`;

/** Days from today to the end date; negative once it has passed. */
export const daysToEndSql = sql<number>`(${contracts.endDate} - ${todayIst})`;

/** Business-wide contracts, and those of the member's stores. */
export function visibleContracts(auth: AuthContext): SQL | undefined {
  return auth.allStores
    ? undefined
    : or(isNull(contracts.storeId), inArray(contracts.storeId, [...auth.storeIds]));
}
