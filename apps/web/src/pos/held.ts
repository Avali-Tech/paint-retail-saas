import type { TaxDocumentView } from '@paint/shared';
import { withViewTint } from '../tint/tint.js';
import { WALK_IN, newBill, type Bill, type BillItem, type BillLine, type Buyer } from './bill.js';

// Held bills are server drafts (spec §5.2). A draft keeps only variant ids, prices and
// quantities, so this device also remembers how each line and the customer looked, to
// show a resumed bill as it was. A draft held on another device still resumes: its
// lines are named on issue, and the server works out its tax.

const billKey = (draftId: string) => `pos.bill.${draftId}`;
const currentKey = (storeId: string) => `pos.current.${storeId}`;
export const STORE_KEY = 'pos.store';

/** What this device remembers about a held bill. */
export interface BillSnapshot {
  /** Each line's pack, and its shade when tinted. */
  readonly items: readonly (BillItem & Pick<BillLine, 'tint'>)[];
  readonly buyer: Buyer;
  /** Absent in snapshots saved before the counter kept the painter. */
  readonly painter?: Bill['painter'];
  readonly payablePaise: number;
}

function read(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function saveSnapshot(storage: Storage, bill: Bill, payablePaise: number): void {
  if (bill.draftId === null) return;
  const snapshot: BillSnapshot = {
    items: bill.lines,
    buyer: bill.buyer,
    painter: bill.painter,
    payablePaise,
  };
  storage.setItem(billKey(bill.draftId), JSON.stringify(snapshot));
}

export const readSnapshot = (storage: Storage, draftId: string) =>
  read(storage, billKey(draftId)) as BillSnapshot | null;

export function forgetDraft(storage: Storage, draftId: string): void {
  storage.removeItem(billKey(draftId));
}

/** The draft on the counter at a store, so a reload picks the bill up again. */
export const currentDraft = (storage: Storage, storeId: string) =>
  storage.getItem(currentKey(storeId));

export function setCurrentDraft(storage: Storage, storeId: string, draftId: string | null): void {
  if (draftId === null) storage.removeItem(currentKey(storeId));
  else storage.setItem(currentKey(storeId), draftId);
}

/**
 * A held draft back on the counter, named from this device's memory where it can be,
 * with the tints read with its lines (a draft held on another device keeps them too).
 */
export function billFromDraft(
  draft: TaxDocumentView,
  snapshot: BillSnapshot | null,
  key: string,
  unknownName: (lineNo: number) => string,
  /** Shown for a painter on a draft this device did not save. */
  unknownPainter = '',
): Bill {
  const remembered = (variantId: string, index: number) => {
    // The same base can be on the bill twice in two shades: the line at the same place first.
    const same = snapshot?.items[index];
    if (same?.variantId === variantId) return same;
    return snapshot?.items.find((known) => known.variantId === variantId);
  };
  const ordered = [...draft.lines].sort((a, b) => a.lineNo - b.lineNo);
  const named = ordered.map((line, index) => {
    const item = remembered(line.variantId, index) ?? {
      variantId: line.variantId,
      sku: '',
      name: unknownName(line.lineNo),
      taxCategoryId: line.taxCategoryId,
      unitPricePaise: line.unitPricePaise,
    };
    const discount =
      line.discountBps !== null
        ? { kind: 'percent' as const, basisPoints: line.discountBps }
        : line.discountPaise !== null
          ? { kind: 'amount' as const, paise: line.discountPaise }
          : null;
    return {
      ...item,
      unitPricePaise: line.unitPricePaise,
      quantity: line.quantity,
      discount,
    };
  });
  const lines = named.map((line, index) => withViewTint(line, ordered[index]?.tint));
  const buyer: Buyer = snapshot?.buyer ?? {
    ...WALK_IN,
    partyId: draft.buyer.partyId,
    name: draft.buyer.name ?? '',
    gstin: draft.buyer.gstin ?? '',
    address: draft.buyer.address ?? '',
    stateCode: draft.buyer.stateCode ?? '',
  };
  return {
    ...newBill(key),
    draftId: draft.id,
    lines,
    buyer,
    painter:
      snapshot?.painter ??
      (draft.influencerPartyId === null
        ? null
        : { id: draft.influencerPartyId, name: unknownPainter }),
    selected: lines.length === 0 ? null : lines.length - 1,
    kind: draft.kind,
    priceMode: draft.priceMode,
  };
}
