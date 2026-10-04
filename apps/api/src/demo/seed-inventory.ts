import { indiaDate } from './history-clock.js';
import { STORE_KEYS, type StoreKey } from './plan.js';
import {
  openingQuantity,
  purchaseQuantity,
  reorderLevels,
  schemeFreeQuantity,
} from './quantities.js';
import { must, type SeedContext, type SeededVariant, type Timeline } from './seed-context.js';

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );

/** What each store carries, decided once at opening. */
const carried = new WeakMap<SeedContext, Map<StoreKey, SeededVariant[]>>();

function carriedAt(context: SeedContext, store: StoreKey): SeededVariant[] {
  return must(carried.get(context)?.get(store), `catalogue at ${store}`);
}

/** Products at a store with at least `minimum` on hand that are not kept low on purpose. */
function available(context: SeedContext, store: StoreKey, minimum: number): SeededVariant[] {
  return carriedAt(context, store).filter(
    (variant) => !context.isLow(store, variant.id) && context.onHand(store, variant.id) >= minimum,
  );
}

/**
 * Opening stock and reorder levels on the first day of the history; most
 * products at each store, a few kept at or below their reorder level.
 */
export function scheduleOpeningStock(context: SeedContext, timeline: Timeline): void {
  const { random, plan } = context;
  timeline.at(plan.historyDays, async () => {
    const inventory = context.as('inventory');
    const byStore = new Map<StoreKey, SeededVariant[]>();
    carried.set(context, byStore);
    for (const store of STORE_KEYS) {
      const kept = context.variants.filter(() => random.chance(0.85));
      byStore.set(store, kept);
      const low = new Set(
        random.sample(kept, Math.max(3, Math.round(kept.length * 0.06))).map((v) => v.id),
      );
      context.lowStock.set(store, low);
      const rules: object[] = [];
      const lines: { variantId: string; quantity: number; unitCostPaise: number }[] = [];
      for (const variant of kept) {
        const usual = openingQuantity(random, variant);
        const levels = reorderLevels(usual);
        const isLow = low.has(variant.id);
        if (isLow || random.chance(0.6)) {
          rules.push({ storeId: context.storeId(store), variantId: variant.id, ...levels });
        }
        const quantity = isLow ? random.int(0, levels.reorderLevel) : usual;
        if (quantity > 0) {
          lines.push({ variantId: variant.id, quantity, unitCostPaise: variant.costPaise });
          context.move(store, variant.id, quantity);
        }
      }
      for (const batch of chunks(lines, 200)) {
        await inventory.post('/stock/movements', {
          storeId: context.storeId(store),
          type: 'opening',
          lines: batch,
        });
      }
      for (const batch of chunks(rules, 500))
        await inventory.put('/reorder-rules', { rules: batch });
      context.count('opening stock lines', lines.length);
      context.count('reorder rules', rules.length);
    }
  });
}

type Outcome = 'full' | 'free' | 'partial' | 'cancel' | 'close';
const PO_OUTCOMES: readonly Outcome[] = [
  'free',
  'full',
  'partial',
  'free',
  'cancel',
  'full',
  'close',
];

/**
 * Distributor orders through the history: received in full (often with
 * scheme units free), partly, short-closed or cancelled; the latest still on
 * their way. Plus one receipt straight against an invoice and a quick reorder
 * of what is low.
 */
export function schedulePurchasing(context: SeedContext, timeline: Timeline): void {
  const { random, plan } = context;
  const suppliers = plan.parties.filter((party) => party.segment === 'supplier');
  const orders = plan.size === 'full' ? 20 : 6;
  const invoiceNumbers = new Map<string, number>();
  const nextInvoice = (supplierKey: string) => {
    const next = (invoiceNumbers.get(supplierKey) ?? 100) + random.int(3, 40);
    invoiceNumbers.set(supplierKey, next);
    return `${supplierKey.toUpperCase().replace('SUPPLIER-', 'INV')}/26-27/${String(next)}`;
  };

  for (let index = 0; index < orders; index++) {
    const supplierPlan = must(suppliers[index % suppliers.length], 'supplier');
    const store = must(STORE_KEYS[index % STORE_KEYS.length], 'store');
    const outcome = must(PO_OUTCOMES[index % PO_OUTCOMES.length], 'outcome');
    // Spread from just after opening to yesterday.
    const placed = Math.max(
      1,
      Math.round(plan.historyDays - 2 - (index * (plan.historyDays - 2)) / orders),
    );
    const arrives = placed - random.int(2, 5);
    let order: { id: string; lines: { variantId: string; quantity: number }[] } | null = null;

    timeline.at(placed, async () => {
      const supplier = context.party(supplierPlan.key);
      const choices = carriedAt(context, store).filter(
        (variant) => variant.product.brand === supplier.brand && !context.isLow(store, variant.id),
      );
      const lines = random.sample(choices, random.int(3, 8)).map((variant) => ({
        variantId: variant.id,
        quantity: purchaseQuantity(random, variant),
        unitCostPaise: variant.costPaise,
      }));
      const created = await context.as('inventory').post('/purchase-orders', {
        supplierId: supplier.id,
        storeId: context.storeId(store),
        expectedDate: indiaDate(arrives),
        note: `Monthly stock for ${
          must(
            plan.stores.find((s) => s.key === store),
            store,
          ).name
        }`,
        lines,
      });
      order = { id: created.id, lines };
      context.count('purchase orders');
    });

    if (outcome === 'cancel') {
      timeline.at(Math.max(1, placed - 1), async () => {
        order = must(order, 'purchase order');
        await context.as('inventory').post(`/purchase-orders/${order.id}/cancel`, {
          reason: 'Distributor out of stock on most items; reordered elsewhere',
        });
      });
      continue;
    }
    if (arrives < 1) continue; // Still on its way.
    timeline.at(arrives, async () => {
      order = must(order, 'purchase order');
      const partial = outcome === 'partial' || outcome === 'close';
      const lines = order.lines.map((line, position) => {
        const quantity =
          partial && position % 2 === 0 ? Math.ceil(line.quantity / 2) : line.quantity;
        const freeQuantity =
          outcome === 'free' ? Math.max(position === 0 ? 1 : 0, schemeFreeQuantity(quantity)) : 0;
        context.move(store, line.variantId, quantity + freeQuantity);
        return { variantId: line.variantId, quantity, freeQuantity };
      });
      await context.as('inventory').post('/goods-receipts', {
        purchaseOrderId: order.id,
        supplierInvoiceNumber: nextInvoice(supplierPlan.key),
        supplierInvoiceDate: indiaDate(arrives),
        lines,
      });
      context.count('goods receipts');
    });
    if (outcome === 'close' && arrives > 1) {
      timeline.at(arrives - 1, async () => {
        order = must(order, 'purchase order');
        await context.as('inventory').post(`/purchase-orders/${order.id}/close`, {
          reason: 'Balance not available this month; distributor will bill on the next order',
        });
      });
    }
  }

  // A delivery taken straight against the distributor's invoice, without an order.
  timeline.at(Math.round(plan.historyDays / 2), async () => {
    const supplier = context.party(must(suppliers[0], 'supplier').key);
    const store: StoreKey = 'KPL';
    const lines = random
      .sample(
        carriedAt(context, store).filter(
          (variant) =>
            variant.product.brand === supplier.brand && !context.isLow(store, variant.id),
        ),
        3,
      )
      .map((variant) => {
        const quantity = purchaseQuantity(random, variant);
        context.move(store, variant.id, quantity);
        return { variantId: variant.id, quantity, unitCostPaise: variant.costPaise };
      });
    await context.as('inventory').post('/goods-receipts', {
      storeId: context.storeId(store),
      supplierId: supplier.id,
      supplierInvoiceNumber: nextInvoice(supplier.key),
      supplierInvoiceDate: indiaDate(Math.round(plan.historyDays / 2)),
      note: 'Urgent delivery for a contractor order',
      lines,
    });
    context.count('goods receipts');
  });

  // Quick reorder: everything low at Ameerpet that one distributor supplies.
  timeline.at(1, async () => {
    const lowId = must([...must(context.lowStock.get('AMP'), 'low stock')][0], 'low product');
    const brand = must(
      context.variants.find((variant) => variant.id === lowId),
      'variant',
    ).product.brand;
    const supplier = must(
      context.partiesOf('supplier').find((party) => party.brand === brand),
      brand,
    );
    await context.as('inventory').post('/purchase-orders/from-low-stock', {
      supplierId: supplier.id,
      storeId: context.storeId('AMP'),
      expectedDate: indiaDate(-3),
      note: 'Quick reorder from the low stock list',
    });
    context.count('purchase orders');
  });
}

type TransferOutcome =
  'received' | 'damaged' | 'in_transit' | 'approved' | 'requested' | 'rejected' | 'cancelled';

/** Stock moving between branches, in every state a transfer can be in. */
export function scheduleTransfers(context: SeedContext, timeline: Timeline): void {
  const { random, plan } = context;
  const story: [StoreKey, StoreKey, TransferOutcome, number][] =
    plan.size === 'full'
      ? [
          ['AMP', 'KPL', 'received', 0.85],
          ['SEC', 'AMP', 'received', 0.7],
          ['KPL', 'SEC', 'damaged', 0.55],
          ['AMP', 'SEC', 'received', 0.4],
          ['KPL', 'AMP', 'rejected', 0.3],
          ['SEC', 'KPL', 'cancelled', 0.25],
          ['AMP', 'KPL', 'received', 0.15],
          ['KPL', 'SEC', 'in_transit', 0.06],
          ['SEC', 'AMP', 'approved', 0.04],
          ['AMP', 'SEC', 'requested', 0.02],
        ]
      : [
          ['AMP', 'KPL', 'damaged', 0.7],
          ['KPL', 'SEC', 'rejected', 0.5],
          ['SEC', 'AMP', 'cancelled', 0.4],
          ['AMP', 'SEC', 'in_transit', 0.15],
          ['KPL', 'AMP', 'approved', 0.1],
          ['SEC', 'KPL', 'requested', 0.05],
        ];
  for (const [from, to, outcome, when] of story) {
    const requested = context.daysAgo(when);
    let transfer: { id: string; lines: { variantId: string; quantity: number }[] } | null = null;
    timeline.at(requested, async () => {
      const lines = random
        .sample(
          available(context, from, 6).filter((variant) => !context.isLow(to, variant.id)),
          random.int(2, 4),
        )
        .map((variant) => ({
          variantId: variant.id,
          quantity: Math.max(1, Math.floor(context.onHand(from, variant.id) * 0.2)),
        }));
      const created = await context.as(context.managerOf(to)).post('/transfers', {
        fromStoreId: context.storeId(from),
        toStoreId: context.storeId(to),
        note: random.pick([
          'Contractor order at our branch',
          'Running low before the weekend',
          'Customer waiting for this shade base',
        ]),
        lines,
      });
      transfer = { id: created.id, lines };
      context.count('transfers');
    });
    const sender = context.managerOf(from);
    const receiver = context.managerOf(to);
    const step = Math.max(1, requested - 1);
    timeline.at(step, async () => {
      transfer = must(transfer, 'transfer');
      const url = `/transfers/${transfer.id}`;
      if (outcome === 'requested') return;
      if (outcome === 'rejected') {
        await context
          .as(sender)
          .post(`${url}/reject`, { reason: 'Needed for a site delivery here' });
        return;
      }
      if (outcome === 'cancelled') {
        await context
          .as(receiver)
          .post(`${url}/cancel`, { reason: 'Customer postponed the order' });
        return;
      }
      await context.as(sender).post(`${url}/approve`);
      if (outcome === 'approved') return;
      await context.as(sender).post(`${url}/dispatch`);
      for (const line of transfer.lines) context.move(from, line.variantId, -line.quantity);
    });
    if (outcome === 'received' || outcome === 'damaged') {
      timeline.at(Math.max(1, step - 1), async () => {
        transfer = must(transfer, 'transfer');
        const lines = transfer.lines.map((line, position) => {
          const damaged = outcome === 'damaged' && position === 0 ? 1 : 0;
          context.move(to, line.variantId, line.quantity - damaged);
          return { variantId: line.variantId, received: line.quantity - damaged, damaged };
        });
        await context.as(receiver).post(`/transfers/${transfer.id}/receive`, {
          ...(outcome === 'damaged' ? { note: 'One tin dented in the tempo' } : {}),
          lines,
        });
      });
    }
  }
}

/** Damage write-offs and adjustments, each with its reason. */
export function scheduleAdjustments(context: SeedContext, timeline: Timeline): void {
  const { random, plan } = context;
  const events: ['damage' | 'adjustment', number, string][] = [
    ['damage', 1, 'Tin dented while unloading'],
    ['adjustment', 2, 'Found two packs in the back room during cleaning'],
    ['damage', 1, 'Lid left open, paint dried'],
    ['adjustment', -1, 'Sample given to an architect'],
    ['damage', 2, 'Bucket cracked in the rain'],
    ['adjustment', -1, 'Billing mistake corrected after the audit'],
  ];
  const used = plan.size === 'full' ? events : events.slice(0, 2);
  used.forEach(([type, quantity, note], index) => {
    const store = must(STORE_KEYS[index % STORE_KEYS.length], 'store');
    timeline.at(context.daysAgo(0.9 - index * 0.13), async () => {
      const variant = random.pick(available(context, store, 5));
      await context.as(context.managerOf(store)).post('/stock/movements', {
        storeId: context.storeId(store),
        type,
        note,
        lines: [{ variantId: variant.id, quantity }],
      });
      context.move(store, variant.id, type === 'damage' ? -quantity : quantity);
      context.count('stock adjustments');
    });
  });
}

interface CountView {
  readonly id: string;
  readonly lines: readonly { variantId: string; expectedQuantity: number }[];
}

/**
 * A finished putty count at Secunderabad (a few packs off, approved by the
 * owner with reasons) and a Berger count still in progress at Kukatpally.
 */
export function scheduleStockCounts(context: SeedContext, timeline: Timeline): void {
  const started = context.daysAgo(0.3);
  let count: CountView | null = null;
  let variances: { variantId: string; variance: number }[] = [];
  timeline.at(started, async () => {
    const manager = context.as('managerSec');
    const created = await manager.post('/stock-counts', {
      storeId: context.storeId('SEC'),
      scope: 'category',
      scopeId: context.categoryIds.get('putty'),
      note: 'Monthly putty count',
    });
    count = await manager.get<CountView>(`/stock-counts/${created.id}`);
    const offsets = [-2, -1, 1];
    variances = count.lines
      .filter((line) => !context.isLow('SEC', line.variantId) && line.expectedQuantity >= 2)
      .slice(0, offsets.length)
      .map((line, index) => ({
        variantId: line.variantId,
        variance: must(offsets[index], 'offset'),
      }));
    await manager.post(`/stock-counts/${created.id}/counts`, {
      entries: count.lines.map((line) => ({
        variantId: line.variantId,
        mode: 'set',
        quantity:
          line.expectedQuantity +
          (variances.find((entry) => entry.variantId === line.variantId)?.variance ?? 0),
      })),
    });
    await manager.post(`/stock-counts/${created.id}/submit`, { uncountedAsZero: false });
    context.count('stock counts');
  });
  timeline.at(Math.max(1, started - 1), async () => {
    count = must(count, 'stock count');
    const reasons = ['damage', 'counting_error', 'theft'] as const;
    await context.as('owner').post(`/stock-counts/${count.id}/approve`, {
      reasons: variances.map((entry, index) => ({
        variantId: entry.variantId,
        reason: reasons[index % reasons.length],
      })),
    });
    for (const entry of variances) context.move('SEC', entry.variantId, entry.variance);
  });

  timeline.at(1, async () => {
    const manager = context.as('managerKpl');
    const created = await manager.post('/stock-counts', {
      storeId: context.storeId('KPL'),
      scope: 'brand',
      scopeId: context.brandIds.get('Berger'),
      note: 'Berger shelf count before the scheme ends',
    });
    const view = await manager.get<CountView>(`/stock-counts/${created.id}`);
    const half = view.lines.slice(0, Math.ceil(view.lines.length / 2));
    await manager.post(`/stock-counts/${created.id}/counts`, {
      entries: half.map((line) => ({
        variantId: line.variantId,
        mode: 'set',
        quantity: line.expectedQuantity,
      })),
    });
    context.count('stock counts');
  });
}
