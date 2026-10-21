import { isValidGstin, type Discount, type PriceMode, type TaxDocumentKind } from '@paint/shared';
import { lineTint, withTint, type LineTint, type TintChoice } from '../tint/tint.js';
import type { ChosenParty } from '../orders/sales-doc.js';
import type { DraftInput } from './pos-api.js';

// The bill on the counter, as a pure reducer: what is on it, who it is for, and
// which server draft holds it. The screen saves it as a draft after every change.

/** What the counter shows for a pack size, fixed when it is added. */
export interface BillItem {
  readonly variantId: string;
  readonly sku: string;
  /** e.g. "Asian Paints Apex Ultima 20 l". */
  readonly name: string;
  /** The product's tax category (the engine's category code); null when it has none. */
  readonly taxCategoryId: string | null;
  readonly unitPricePaise: number;
  /** The product's packs are bases tinted at the counter; undefined when not known. */
  readonly tintable?: boolean;
}

export interface BillLine extends BillItem {
  readonly quantity: number;
  readonly discount: Discount | null;
  /** The shade it is tinted to (its unit price includes the tinting charge). */
  readonly tint?: LineTint | null;
}

/** Who the bill is for: walk-in by default (no party), with what is typed on the bill. */
export interface Buyer {
  readonly partyId: string | null;
  /** The party's name and mobile, for the screen. */
  readonly partyName: string | null;
  readonly phone: string | null;
  /** Typed on the bill (overrides the party's); "" when not given. */
  readonly name: string;
  readonly gstin: string;
  readonly address: string;
  readonly stateCode: string;
}

export const WALK_IN: Buyer = {
  partyId: null,
  partyName: null,
  phone: null,
  name: '',
  gstin: '',
  address: '',
  stateCode: '',
};

export interface Bill {
  /** A new key per bill: the draft's idempotency key. */
  readonly key: string;
  readonly draftId: string | null;
  readonly lines: readonly BillLine[];
  readonly buyer: Buyer;
  /**
   * The painter, contractor or architect who brought the sale: they earn its
   * points (P2-M36). Kept apart from the buyer, who is often a walk-in.
   */
  readonly painter: ChosenParty | null;
  /** The line the keyboard acts on (+, −, Delete); the last one added by default. */
  readonly selected: number | null;
  /** Bumped on every change the server must hear about. */
  readonly version: number;
  /** From the saved draft: a composition store issues a bill of supply. */
  readonly kind: TaxDocumentKind | null;
  readonly priceMode: PriceMode | null;
}

export const newBill = (key: string): Bill => ({
  key,
  draftId: null,
  lines: [],
  buyer: WALK_IN,
  painter: null,
  selected: null,
  version: 0,
  kind: null,
  priceMode: null,
});

export type BillAction =
  | { readonly type: 'add'; readonly item: BillItem; readonly quantity: number }
  | { readonly type: 'quantity'; readonly index: number; readonly quantity: number }
  | { readonly type: 'step'; readonly index: number; readonly by: 1 | -1 }
  | { readonly type: 'discount'; readonly index: number; readonly discount: Discount | null }
  | { readonly type: 'tint'; readonly index: number; readonly tint: TintChoice | null }
  | { readonly type: 'remove'; readonly index: number }
  | { readonly type: 'select'; readonly index: number }
  | { readonly type: 'buyer'; readonly buyer: Partial<Buyer> }
  | { readonly type: 'painter'; readonly painter: ChosenParty | null }
  | {
      readonly type: 'saved';
      readonly key: string;
      readonly draftId: string | null;
      readonly kind?: TaxDocumentKind;
      readonly priceMode?: PriceMode;
    }
  | { readonly type: 'load'; readonly bill: Bill }
  | { readonly type: 'reset'; readonly key: string };

const changed = (bill: Bill, next: Partial<Bill>): Bill => ({
  ...bill,
  ...next,
  version: bill.version + 1,
});

/** Quantities keep at most 3 decimals, as the API stores them. */
const roundQuantity = (quantity: number) => Math.round(quantity * 1000) / 1000;

function withLine(bill: Bill, index: number, change: (line: BillLine) => BillLine): Bill {
  const lines = bill.lines.map((line, at) => (at === index ? change(line) : line));
  return changed(bill, { lines, selected: index });
}

export function billReducer(bill: Bill, action: BillAction): Bill {
  switch (action.type) {
    case 'add': {
      // The same pack scanned again adds to its line, as a cashier expects (a tinted
      // line keeps its shade: the new packs get a line of their own).
      const index = bill.lines.findIndex(
        (line) => line.variantId === action.item.variantId && !line.tint,
      );
      if (index !== -1) {
        return withLine(bill, index, (line) => ({
          ...line,
          quantity: roundQuantity(line.quantity + action.quantity),
        }));
      }
      const lines = [...bill.lines, { ...action.item, quantity: action.quantity, discount: null }];
      return changed(bill, { lines, selected: lines.length - 1 });
    }
    case 'quantity':
      return withLine(bill, action.index, (line) => ({ ...line, quantity: action.quantity }));
    case 'step':
      return withLine(bill, action.index, (line) => ({
        ...line,
        // Never below one unit by the − key; Delete removes the line.
        quantity: Math.max(1, roundQuantity(line.quantity + action.by)),
      }));
    case 'discount':
      return withLine(bill, action.index, (line) => ({ ...line, discount: action.discount }));
    case 'tint':
      return withLine(bill, action.index, (line) => withTint(line, action.tint));
    case 'remove': {
      const lines = bill.lines.filter((_, at) => at !== action.index);
      return changed(bill, {
        lines,
        selected: lines.length === 0 ? null : Math.min(action.index, lines.length - 1),
      });
    }
    case 'select':
      return { ...bill, selected: action.index };
    case 'buyer':
      return changed(bill, { buyer: { ...bill.buyer, ...action.buyer } });
    case 'painter':
      return changed(bill, { painter: action.painter });
    case 'saved':
      // An answer for a bill that has since been finished or swapped is ignored.
      if (action.key !== bill.key) return bill;
      return {
        ...bill,
        draftId: action.draftId,
        kind: action.kind ?? bill.kind,
        priceMode: action.priceMode ?? bill.priceMode,
      };
    case 'load':
      return action.bill;
    case 'reset':
      return newBill(action.key);
  }
}

const text = (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** The buyer's GSTIN when one is typed in full and valid, else null (a B2C sale). */
export function buyerGstin(buyer: Buyer): string | null {
  const gstin = buyer.gstin.trim().toUpperCase();
  return isValidGstin(gstin) ? gstin : null;
}

/** The draft the API keeps for this bill. A GSTIN still being typed is left out. */
export function draftInput(bill: Bill, storeId: string): DraftInput {
  const { buyer } = bill;
  const typed = {
    name: text(buyer.name),
    gstin: buyerGstin(buyer) ?? undefined,
    address: text(buyer.address),
    stateCode: text(buyer.stateCode),
  };
  return {
    storeId,
    ...(buyer.partyId === null ? {} : { partyId: buyer.partyId }),
    ...(bill.painter === null ? {} : { influencerPartyId: bill.painter.id }),
    buyer: Object.fromEntries(Object.entries(typed).filter(([, value]) => value !== undefined)),
    lines: bill.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      ...(line.discount === null ? {} : { discount: line.discount }),
      ...(line.tint ? { tint: lineTint(line.tint) } : {}),
    })),
  };
}
