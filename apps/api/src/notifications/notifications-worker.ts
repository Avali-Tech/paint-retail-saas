import 'reflect-metadata';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { schema, type DatabaseConnection } from '@paint/db';
import { and, asc, eq, lte, notExists, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import type { EmailSender } from './email-sender.js';
import { Notifier } from './notifier.js';

const {
  emailOutbox,
  lowStockAlerts,
  productVariants,
  products,
  reorderRules,
  stockBalances,
  stores,
} = schema;

export const WORKER_SETTINGS = Symbol('WORKER_SETTINGS');
export interface WorkerSettings {
  /** 0 = never run by itself (tests call runOnce). */
  readonly intervalMs: number;
  /** Null when email is off: queued emails then wait. */
  readonly sender: EmailSender | null;
}

/** Give up on an email after this many failed attempts. */
export const MAX_EMAIL_ATTEMPTS = 5;
const EMAIL_BATCH = 50;
const LOW_STOCK_LOCK = sql`hashtext('paint:low-stock-check')`;

export interface WorkerRun {
  /** Products newly reported as low. */
  readonly lowStock: number;
  readonly emailsSent: number;
  readonly emailsFailed: number;
}

/**
 * Background work for notifications, across every business: announces stock
 * that has fallen to its reorder level, and sends queued emails with retries.
 * Safe to run on several servers at once.
 */
@Injectable()
export class NotificationsWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('NotificationsWorker');
  private timer: NodeJS.Timeout | undefined;
  /** Runs queue up behind each other, so they never overlap. */
  private running: Promise<void> = Promise.resolve();

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.intervalMs > 0) {
      this.timer = setInterval(() => {
        // runOnce never throws: each job logs its own failure.
        this.running = this.running.then(() => this.runOnce()).then(() => undefined);
      }, this.settings.intervalMs);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
    this.settings.sender?.close();
  }

  /** Runs every job once; one failing does not stop the others. */
  async runOnce(): Promise<WorkerRun> {
    const lowStock = await this.attempt('Low stock check', () => this.checkLowStock(), 0);
    const { sent, failed } = await this.attempt('Sending email', () => this.sendDueEmails(), {
      sent: 0,
      failed: 0,
    });
    return { lowStock, emailsSent: sent, emailsFailed: failed };
  }

  private async attempt<T>(name: string, job: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await job();
    } catch (error) {
      this.logger.error(`${name} failed: ${String(error)}`);
      return fallback;
    }
  }

  /**
   * Announces each product that has fallen to or below its reorder level,
   * once per dip: one notification per store, to its stock managers.
   */
  checkLowStock(): Promise<number> {
    return this.connection.db.transaction(async (tx) => {
      const [lock] = (
        await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(${LOW_STOCK_LOCK}) as locked`,
        )
      ).rows;
      // Another server is checking right now.
      if (!lock?.locked) return 0;

      const available = sql`coalesce(${stockBalances.onHand}, 0) - coalesce(${stockBalances.reserved}, 0)`;
      // Forget products that have recovered, so their next dip is announced.
      await tx.execute(sql`
        delete from ${lowStockAlerts} a
        where not exists (
          select 1 from ${reorderRules} r
          left join ${stockBalances} b
            on b.store_id = r.store_id and b.variant_id = r.variant_id
          where r.store_id = a.store_id and r.variant_id = a.variant_id
            and coalesce(b.on_hand, 0) - coalesce(b.reserved, 0) <= r.reorder_level
        )`);

      const low = await tx
        .select({
          organizationId: reorderRules.organizationId,
          storeId: reorderRules.storeId,
          storeName: stores.name,
          variantId: reorderRules.variantId,
          sku: productVariants.sku,
          productName: products.name,
          available: sql<string>`${available}`,
          reorderLevel: reorderRules.reorderLevel,
        })
        .from(reorderRules)
        .innerJoin(stores, eq(stores.id, reorderRules.storeId))
        .innerJoin(productVariants, eq(productVariants.id, reorderRules.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .leftJoin(
          stockBalances,
          and(
            eq(stockBalances.storeId, reorderRules.storeId),
            eq(stockBalances.variantId, reorderRules.variantId),
          ),
        )
        .where(
          and(
            eq(stores.isActive, true),
            eq(productVariants.isActive, true),
            eq(products.isActive, true),
            sql`${available} <= ${reorderRules.reorderLevel}`,
            notExists(
              tx
                .select({ one: sql`1` })
                .from(lowStockAlerts)
                .where(
                  and(
                    eq(lowStockAlerts.storeId, reorderRules.storeId),
                    eq(lowStockAlerts.variantId, reorderRules.variantId),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(stores.name), asc(productVariants.sku));

      const byStore = new Map<
        string,
        { organizationId: string; storeName: string; items: typeof low }
      >();
      for (const item of low) {
        const group = byStore.get(item.storeId) ?? {
          organizationId: item.organizationId,
          storeName: item.storeName,
          items: [],
        };
        group.items.push(item);
        byStore.set(item.storeId, group);
      }
      for (const [storeId, { organizationId, storeName, items }] of byStore) {
        await tx
          .insert(lowStockAlerts)
          .values(items.map(({ variantId }) => ({ organizationId, storeId, variantId })));
        await this.notifier.notify(tx, {
          organizationId,
          event: 'low_stock',
          storeId,
          permission: 'inventory:manage',
          title: `Low stock at ${storeName}: ${String(items.length)} product(s)`,
          body: items
            .map(
              (item) =>
                `${item.sku} ${item.productName}: ${String(Number(item.available))} left (reorder at ${String(item.reorderLevel)})`,
            )
            .join('\n'),
          link: `/stock/low?storeId=${storeId}`,
        });
      }
      return low.length;
    });
  }

  /** Sends emails that are due; failures are retried later with growing gaps. */
  async sendDueEmails(): Promise<{ sent: number; failed: number }> {
    const { sender } = this.settings;
    if (!sender) return { sent: 0, failed: 0 };
    return this.connection.db.transaction(async (tx) => {
      // SKIP LOCKED lets several servers share the queue without sending twice.
      const due = await tx
        .select()
        .from(emailOutbox)
        .where(and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.nextAttemptAt, sql`now()`)))
        .orderBy(asc(emailOutbox.nextAttemptAt))
        .limit(EMAIL_BATCH)
        .for('update', { skipLocked: true });
      let sent = 0;
      for (const email of due) {
        const attempts = email.attempts + 1;
        try {
          await sender.send({ to: email.toAddress, subject: email.subject, text: email.textBody });
          await tx
            .update(emailOutbox)
            .set({ status: 'sent', sentAt: sql`now()`, attempts, lastError: null })
            .where(eq(emailOutbox.id, email.id));
          sent += 1;
        } catch (error) {
          await tx
            .update(emailOutbox)
            .set({
              attempts,
              lastError: String(error).slice(0, 500),
              status: attempts >= MAX_EMAIL_ATTEMPTS ? 'failed' : 'pending',
              // 2, 4, 8, 16 minutes.
              nextAttemptAt: sql`now() + make_interval(mins => ${2 ** attempts})`,
            })
            .where(eq(emailOutbox.id, email.id));
        }
      }
      return { sent, failed: due.length - sent };
    });
  }
}
