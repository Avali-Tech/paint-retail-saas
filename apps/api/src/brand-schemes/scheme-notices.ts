import { schema, withTenant, type Database, type Transaction } from '@paint/db';
import { formatINR, type SlabMeasure } from '@paint/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Notifier } from '../notifications/notifier.js';
import { evaluateSchemes, loadSchemes } from './scheme-data.js';

const { brandSchemes, emailOutbox, notifications } = schema;

/** A slab is "within reach" in a scheme's last week… */
export const SLAB_NEAR_DAYS = 7;
/** …when at most this share of its target (basis points, 20 %) is still to buy. */
export const SLAB_NEAR_SHARE_BPS = 2_000;

const NOTICES_LOCK = sql`hashtext('paint:scheme-notices')`;

const amount = (measure: SlabMeasure, value: number) =>
  measure === 'value' ? formatINR(value) : `${String(value / 1000)} L`;

/**
 * Brand scheme notices for one business as of a day (P2-M33), in its tenant
 * transaction, to everyone who manages schemes:
 * - `scheme_slab_near`: an active scheme in its last {@link SLAB_NEAR_DAYS} days is
 *   within {@link SLAB_NEAR_SHARE_BPS} of its next slab;
 * - `scheme_claim_overdue`: an active scheme's claim is open past its due date.
 * Each is told once per scheme (an earlier notification or email with the same title
 * counts). Returns how many notices went out; 0 when another server holds the lock.
 */
export async function noticeSchemes(
  tx: Transaction,
  notifier: Notifier,
  organizationId: string,
  asOf: string,
): Promise<number> {
  const [lock] = (
    await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${NOTICES_LOCK}, hashtext(${organizationId})) as locked`,
    )
  ).rows;
  if (!lock?.locked) return 0;
  const records = await loadSchemes(
    tx,
    and(eq(brandSchemes.organizationId, organizationId), eq(brandSchemes.status, 'active')),
  );
  let sent = 0;
  const tell = async (
    event: 'scheme_slab_near' | 'scheme_claim_overdue',
    schemeId: string,
    title: string,
    body: string,
  ) => {
    const link = `/brand-schemes/${schemeId}`;
    const [told] = await tx
      .select({ one: sql`1` })
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, organizationId),
          eq(notifications.event, event),
          eq(notifications.link, link),
        ),
      )
      .unionAll(
        tx
          .select({ one: sql`1` })
          .from(emailOutbox)
          .where(
            and(
              eq(emailOutbox.organizationId, organizationId),
              eq(emailOutbox.event, event),
              eq(emailOutbox.subject, title),
            ),
          ),
      )
      .limit(1);
    if (told) return;
    await notifier.notify(tx, {
      organizationId,
      event,
      to: { storeId: null, permission: 'schemes:manage' },
      title,
      body,
      link,
    });
    sent += 1;
  };
  for (const { record, progress, claim } of await evaluateSchemes(tx, records, asOf)) {
    const { id, name, brand, measure } = record.view;
    const { next, remainingDays } = progress;
    if (
      next !== null &&
      remainingDays > 0 &&
      remainingDays <= SLAB_NEAR_DAYS &&
      next.distance * 10_000 <= next.target * SLAB_NEAR_SHARE_BPS
    ) {
      await tell(
        'scheme_slab_near',
        id,
        `Next slab within reach: ${brand.name} · ${name}`,
        `${amount(measure, next.distance)} more to slab ${String(next.index + 1)} in ${String(remainingDays)} days` +
          ` (${amount(measure, Number(next.perDayNeeded))} a day)`,
      );
    }
    if (claim.status === 'open' && claim.daysPastDue > 0) {
      await tell(
        'scheme_claim_overdue',
        id,
        `Scheme claim overdue: ${brand.name} · ${name}`,
        `${formatINR(Math.max(claim.money.outstandingPaise, 0))} still owed, due ${claim.dueOn}`,
      );
    }
  }
  return sent;
}

/** The notices for every business with an active scheme, one transaction each. */
export async function noticeSchemesForBusinesses(
  db: Database,
  notifier: Notifier,
  asOf: string,
): Promise<number> {
  const businesses = await db
    .selectDistinct({ organizationId: brandSchemes.organizationId })
    .from(brandSchemes)
    .where(eq(brandSchemes.status, 'active'));
  let sent = 0;
  for (const { organizationId } of businesses) {
    sent += await withTenant(db, organizationId, (tx) =>
      noticeSchemes(tx, notifier, organizationId, asOf),
    );
  }
  return sent;
}
