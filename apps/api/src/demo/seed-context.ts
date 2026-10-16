import type { DemoApi, MemberApi } from './api-client.js';
import type { ProductPlan, VariantPlan } from './catalogue.js';
import type { HistoryClock } from './history-clock.js';
import type { DemoPlan, PartyPlan, StoreKey } from './plan.js';
import type { Random } from './random.js';

/** The value, or an error naming what was missing (a bug in the seed, never the data). */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Demo seed: no ${what}`);
  return value;
}

export interface SeededVariant extends VariantPlan {
  readonly id: string;
  readonly product: ProductPlan;
}

export interface SeededParty extends PartyPlan {
  readonly id: string;
}

/**
 * Everything the seed has created so far, filled in as the days are played
 * (events read it when they run, not when they are scheduled).
 */
export class SeedContext {
  readonly tokens = new Map<string, string>();
  readonly memberIds = new Map<string, string>();
  readonly storeIds = new Map<StoreKey, string>();
  readonly brandIds = new Map<string, string>();
  readonly categoryIds = new Map<string, string>();
  /** The business's tax categories, by key (paints, putty…). */
  readonly taxCategoryIds = new Map<string, string>();
  readonly variants: SeededVariant[] = [];
  readonly parties = new Map<string, SeededParty>();
  /** What the seed expects on hand, per store and variant id, to keep every movement possible. */
  readonly stock = new Map<string, number>();
  /** Products kept at or below their reorder level per store, so low stock shows. */
  readonly lowStock = new Map<StoreKey, Set<string>>();
  /** Counters for the summary, by what was created. */
  readonly created = new Map<string, number>();
  /**
   * Sends the messages to parties queued so far (the worker's outbox job), so a
   * simulated day's messages go out that day; set by the seed.
   */
  sendMessages: () => Promise<unknown> = () => Promise.resolve();

  constructor(
    readonly plan: DemoPlan,
    readonly random: Random,
    readonly api: DemoApi,
    readonly clock: HistoryClock,
  ) {}

  /** API calls as a team member, by plan key. */
  as(memberKey: string): MemberApi {
    return this.api.as(this.required(this.tokens, memberKey, 'session'));
  }

  memberId(memberKey: string): string {
    return this.required(this.memberIds, memberKey, 'member');
  }

  storeId(store: StoreKey): string {
    return this.required(this.storeIds, store, 'store');
  }

  taxCategoryId(key: string): string {
    return this.required(this.taxCategoryIds, key, 'tax category');
  }

  party(key: string): SeededParty {
    return this.required(this.parties, key, 'party');
  }

  partiesOf(segment: PartyPlan['segment']): SeededParty[] {
    return [...this.parties.values()].filter(
      (party) => party.segment === segment && party.duplicateOf === null,
    );
  }

  /** The branch manager of a store. */
  managerOf(store: StoreKey): string {
    return `manager${store.charAt(0)}${store.slice(1).toLowerCase()}`;
  }

  /** The sales executive covering a store. */
  salesOf(store: StoreKey): string {
    return store === 'SEC' ? 'salesSec' : 'salesAmp';
  }

  /** A day `fraction` of the way back through the history (1 = the first day). */
  daysAgo(fraction: number): number {
    return Math.max(1, Math.round(this.plan.historyDays * fraction));
  }

  onHand(store: StoreKey, variantId: string): number {
    return this.stock.get(`${store}:${variantId}`) ?? 0;
  }

  /** Records a movement the seed made through the API. */
  move(store: StoreKey, variantId: string, quantity: number): void {
    const key = `${store}:${variantId}`;
    this.stock.set(key, Math.round(((this.stock.get(key) ?? 0) + quantity) * 1000) / 1000);
  }

  isLow(store: StoreKey, variantId: string): boolean {
    return this.lowStock.get(store)?.has(variantId) ?? false;
  }

  count(what: string, by = 1): void {
    this.created.set(what, (this.created.get(what) ?? 0) + by);
  }

  private required<K, V>(map: Map<K, V>, key: K, what: string): V {
    return must(map.get(key), `${what} for ${String(key)}`);
  }
}

/** Something to do on a simulated day. */
interface Scheduled {
  readonly daysAgo: number;
  readonly order: number;
  readonly run: () => Promise<void>;
}

/**
 * The demo's story, day by day. Events are scheduled up front and played in
 * date order (and the order they were added within a day); days in the past
 * go through the history clock, today's events happen now.
 */
export class Timeline {
  private readonly events: Scheduled[] = [];

  at(daysAgo: number, run: () => Promise<void>): void {
    this.events.push({ daysAgo, order: this.events.length, run });
  }

  async play(clock: HistoryClock): Promise<void> {
    const sorted = [...this.events].sort((a, b) => b.daysAgo - a.daysAgo || a.order - b.order);
    const days = [...new Set(sorted.map((event) => event.daysAgo))];
    for (const daysAgo of days) {
      const work = async () => {
        for (const event of sorted.filter((entry) => entry.daysAgo === daysAgo)) await event.run();
      };
      if (daysAgo > 0) await clock.day(daysAgo, work);
      else await work();
    }
  }
}
