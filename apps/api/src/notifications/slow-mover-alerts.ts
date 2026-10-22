import { schema, type Database } from '@paint/db';
import { variantName } from '@paint/shared';
import { sql } from 'drizzle-orm';
import type { Notifier } from './notifier.js';

const { slowMoverAlerts } = schema;

const SLOW_MOVER_LOCK = sql`hashtext('paint:slow-mover-check')`;
/** A business without settings saved alerts after this many days, as the column's default. */
export const DEFAULT_SLOW_MOVER_DAYS = 90;
/** Lines in one notice; the rest are counted, and the screen lists them all. */
export const SLOW_MOVER_NOTICE_LINES = 20;

interface SlowRow extends Record<string, unknown> {
  readonly organization_id: string;
  readonly store_id: string;
  readonly store_name: string;
  readonly variant_id: string;
  readonly sku: string;
  readonly product_name: string;
  readonly pack_size: string;
  readonly unit: string;
  readonly label: string | null;
  readonly on_hand: string;
  readonly days_idle: number;
  readonly alert_days: number;
}

/**
 * Announces stock that has not sold or left by transfer for the business's
 * slow-mover days (Settings → Stock alerts; 90 unless set, none when off),
 * once per idle stretch: one notice per store, to its stock managers. Sale,
 * transfer out or running out re-arms a product. Every business in one pass,
 * by one server at a time. No money in the notice: the value is at cost, and
 * not everyone told may see costs.
 */
export function alertSlowMovers(db: Database, notifier: Notifier): Promise<number> {
  return db.transaction(async (tx) => {
    const [lock] = (
      await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${SLOW_MOVER_LOCK}) as locked`,
      )
    ).rows;
    // Another server is checking right now.
    if (!lock?.locked) return 0;

    // Forget products that moved or ran out, so their next idle stretch is announced.
    await tx.execute(sql`
      delete from slow_mover_alerts a
      where not exists (
          select 1 from stock_balances b
          where b.store_id = a.store_id and b.variant_id = a.variant_id and b.on_hand > 0
        )
        or exists (
          select 1 from stock_ledger l
          where l.store_id = a.store_id and l.variant_id = a.variant_id
            and l.movement_type in ('sale', 'transfer_out') and l.created_at > a.alerted_at
        )`);

    const rows = (
      await tx.execute<SlowRow>(sql`
        with businesses as (
          select o.id as organization_id,
            case when s.organization_id is null then ${DEFAULT_SLOW_MOVER_DAYS}
              else s.slow_mover_alert_days end as alert_days
          from organizations o
          left join sales_settings s on s.organization_id = o.id
          where o.suspended_at is null
        ),
        idle as (
          select b.organization_id, b.store_id, b.variant_id, b.on_hand, biz.alert_days,
            floor(extract(epoch from now() - coalesce(
              (select max(l.created_at) from stock_ledger l
                where l.store_id = b.store_id and l.variant_id = b.variant_id
                  and l.movement_type in ('sale', 'transfer_out')),
              (select min(l.created_at) from stock_ledger l
                where l.store_id = b.store_id and l.variant_id = b.variant_id and l.quantity > 0)
            )) / 86400)::int as days_idle
          from stock_balances b
          join businesses biz on biz.organization_id = b.organization_id
          where biz.alert_days is not null and b.on_hand > 0
            and not exists (
              select 1 from slow_mover_alerts a
              where a.store_id = b.store_id and a.variant_id = b.variant_id
            )
        )
        select i.organization_id, i.store_id, st.name as store_name, i.variant_id,
          v.sku, p.name as product_name, v.pack_size, v.unit::text as unit, v.label,
          i.on_hand, i.days_idle, i.alert_days
        from idle i
        join stores st on st.id = i.store_id and st.is_active
        join product_variants v on v.id = i.variant_id and v.is_active
        join products p on p.id = v.product_id and p.is_active
        where i.days_idle >= i.alert_days
        order by st.name, i.days_idle desc, v.sku`)
    ).rows;

    const byStore = new Map<string, SlowRow[]>();
    for (const row of rows) byStore.set(row.store_id, [...(byStore.get(row.store_id) ?? []), row]);
    for (const [storeId, items] of byStore) {
      const [first] = items as [SlowRow];
      await tx.insert(slowMoverAlerts).values(
        items.map((item) => ({
          organizationId: item.organization_id,
          storeId,
          variantId: item.variant_id,
        })),
      );
      const lines = items.slice(0, SLOW_MOVER_NOTICE_LINES).map((item) => {
        const pack = { packSize: Number(item.pack_size), unit: item.unit, label: item.label };
        return `${item.sku} ${item.product_name} ${variantName(pack)}: ${String(Number(item.on_hand))} on hand, not moved for ${String(item.days_idle)} days`;
      });
      const more = items.length - lines.length;
      await notifier.notify(tx, {
        organizationId: first.organization_id,
        event: 'slow_movers',
        to: { storeId, permission: 'inventory:manage' },
        title: `Slow movers at ${first.store_name}: ${String(items.length)} product(s) not moved in ${String(first.alert_days)} days`,
        body: [...lines, ...(more > 0 ? [`…and ${String(more)} more`] : [])].join('\n'),
        link: `/stock/slow-movers?store=${storeId}&days=${String(first.alert_days)}`,
      });
    }
    return rows.length;
  });
}
