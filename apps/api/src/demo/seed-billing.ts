import type {
  IssuedInvoiceView,
  LatestReconciliation,
  PaymentModeView,
  TaxDocumentView,
} from '@paint/shared';
import type { StoreKey } from './plan.js';
import { must, type SeedContext, type SeededParty } from './seed-context.js';

/** How a bill is paid at the counter (cash needs the store's register open). */
export type PayBy = 'cash' | 'upi' | 'card';

/** Packs left on the shelf after a sale, so other events still find stock to move. */
const SHELF_BUFFER = 3;
/** Lines on one bill at most. */
const MAX_LINES = 10;

export interface BasketLine {
  readonly variantId: string;
  readonly quantity: number;
}

const modes = new WeakMap<SeedContext, Map<string, string>>();

/** The business's payment modes by kind (cash, upi, card, bank_transfer, cheque). */
export async function paymentMode(context: SeedContext, kind: string): Promise<string> {
  let byKind = modes.get(context);
  if (byKind === undefined) {
    const list = await context.as('owner').get<PaymentModeView[]>('/payment-modes');
    byKind = new Map(list.map((mode) => [mode.kind, mode.id]));
    modes.set(context, byKind);
  }
  return must(byKind.get(kind), `${kind} payment mode`);
}

/**
 * Packs worth about `targetPaise` at a store, picked from what the seed knows
 * is on its shelves: never products kept low on purpose, never the last few
 * packs, never putty at Secunderabad (its count is being reconciled).
 */
export function basket(context: SeedContext, store: StoreKey, targetPaise: number): BasketLine[] {
  const { random } = context;
  const candidates = random.shuffle(
    context.variants.filter(
      (variant) =>
        !context.isLow(store, variant.id) &&
        context.onHand(store, variant.id) > SHELF_BUFFER &&
        !(store === 'SEC' && variant.product.category === 'putty'),
    ),
  );
  const lines: BasketLine[] = [];
  let total = 0;
  for (const variant of candidates) {
    const spare = context.onHand(store, variant.id) - SHELF_BUFFER;
    const quantity = Math.min(
      spare,
      Math.max(1, Math.ceil((targetPaise - total) / variant.sellingPricePaise)),
      random.int(1, 6),
    );
    lines.push({ variantId: variant.id, quantity });
    total += quantity * variant.sellingPricePaise;
    if (total >= targetPaise || lines.length === MAX_LINES) break;
  }
  return lines;
}

/** What a basket comes to: prices include GST and are whole rupees, so the bill's total. */
export function basketTotal(context: SeedContext, lines: readonly BasketLine[]): number {
  return lines.reduce(
    (sum, line) =>
      sum +
      line.quantity *
        must(
          context.variants.find((variant) => variant.id === line.variantId),
          'variant',
        ).sellingPricePaise,
    0,
  );
}

export interface SaleOptions {
  /** Who rings it up (a plan key); the store's branch manager by default. */
  readonly by?: string;
  /** The customer; a walk-in sale when left out. */
  readonly party?: SeededParty;
  /** Paid in full at the counter, or left on account (credit customers). */
  readonly payBy: PayBy | 'credit';
  /** Days a bill on account gives the customer to pay. */
  readonly creditDays?: number;
  readonly lines: readonly BasketLine[];
}

/**
 * A bill through the API, as the counter makes one: a draft, then issued with
 * its payment in the same request. Stock the seed tracks goes down with it.
 */
export async function sell(
  context: SeedContext,
  store: StoreKey,
  options: SaleOptions,
): Promise<IssuedInvoiceView> {
  const api = context.as(options.by ?? context.managerOf(store));
  const draft = await api.post<TaxDocumentView>('/invoices', {
    storeId: context.storeId(store),
    ...(options.party === undefined ? {} : { partyId: options.party.id }),
    ...(options.creditDays === undefined
      ? {}
      : { dueOn: await context.clock.today(options.creditDays) }),
    lines: options.lines,
  });
  const payments =
    options.payBy === 'credit'
      ? []
      : [
          {
            modeId: await paymentMode(context, options.payBy),
            amountPaise: basketTotal(context, options.lines),
          },
        ];
  const issued = await api.post<IssuedInvoiceView>(`/invoices/${draft.id}/issue`, { payments });
  for (const line of options.lines) context.move(store, line.variantId, -line.quantity);
  context.count('invoices');
  return issued;
}

/** Throws unless the latest reconciliation found the books in balance. */
export function assertReconciled({ run }: LatestReconciliation): void {
  const findings = must(run, 'reconciliation').findings;
  if (findings.length > 0) {
    throw new Error(`Demo seed: the books do not reconcile: ${JSON.stringify(findings)}`);
  }
}
