import { schema, type Transaction } from '@paint/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { PaymentMode } from '../payments/posting.js';

const { paymentModes, stores } = schema;

// How link money enters the books: the UPI link mode, the link's store, the India date.

/**
 * The business's UPI link payment mode, made the first time a link is paid (a
 * migration cannot make it: the kind is new in the same migration). Kept even when
 * switched off, since the money came anyway.
 */
export async function upiLinkMode(tx: Transaction, organizationId: string): Promise<PaymentMode> {
  const find = async () => {
    const [mode] = await tx
      .select({ id: paymentModes.id, kind: paymentModes.kind, name: paymentModes.name })
      .from(paymentModes)
      .where(
        and(eq(paymentModes.organizationId, organizationId), eq(paymentModes.kind, 'upi_link')),
      )
      .orderBy(desc(paymentModes.isActive), asc(paymentModes.createdAt), asc(paymentModes.id))
      .limit(1);
    return mode;
  };
  // "UPI link", or, when the business already named another mode so, a name of its own.
  for (const name of ['UPI link', 'UPI payment link (gateway)']) {
    const found = await find();
    if (found) return found;
    await tx
      .insert(paymentModes)
      .values({ organizationId, kind: 'upi_link', name })
      .onConflictDoNothing();
  }
  return (await find()) as PaymentMode;
}

/** The link's store as payments need it: GSTIN only when registered (vouchers). */
export async function linkStore(
  tx: Transaction,
  storeId: string,
): Promise<{ id: string; code: string; gstin: string | null }> {
  const [store] = (await tx
    .select({
      id: stores.id,
      code: stores.code,
      gstin: sql<
        string | null
      >`case when ${stores.registrationType} <> 'unregistered' then ${stores.gstin} end`,
    })
    .from(stores)
    .where(eq(stores.id, storeId))) as [{ id: string; code: string; gstin: string | null }];
  return store;
}

/** India date of a gateway's payment time, never after today. */
export async function receivedOnOf(tx: Transaction, paidAt: Date): Promise<string> {
  const [row] = (
    await tx.execute<{ day: string }>(sql`
    select least((${paidAt.toISOString()}::timestamptz at time zone 'Asia/Kolkata')::date,
      (now() at time zone 'Asia/Kolkata')::date)::text as day`)
  ).rows as [{ day: string }];
  return row.day;
}
