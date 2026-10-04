import type { MessageKey } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';
import { parseQuantity as parseSignedQuantity } from '../lib/quantity.js';

// The lines of a purchase order or goods receipt as typed, and their checks.

/** A quantity of 0 or more with at most 3 decimals (as the API allows); null otherwise. */
export function parseQuantity(text: string): number | null {
  const value = parseSignedQuantity(text);
  return value === null || value < 0 ? null : value;
}

/** A typed cost per unit: null when left blank, undefined when it is not a rupee amount. */
export function parseCost(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const paise = parseRupees(text);
  return paise === null || paise < 0 ? undefined : paise;
}

/** quantity × cost in paise; null when the cost is not known. */
export function lineValue(quantity: number, costPaise: number | null): number | null {
  return costPaise === null ? null : Math.round(quantity * costPaise);
}

export interface OrderLineDraft {
  readonly variantId: string;
  readonly sku: string;
  readonly name: string;
  quantity: string;
  unitCost: string;
}

export type Problems = Record<string, MessageKey>;

/** Problems with an order's lines, by field ("lines", "qty-<id>", "cost-<id>"). */
export function checkOrderLines(lines: readonly OrderLineDraft[]): Problems {
  const problems: Problems = {};
  if (lines.length === 0) problems.lines = 'workflow.noLines';
  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);
    if (quantity === null || quantity === 0) {
      problems[`qty-${line.variantId}`] = 'purchasing.line.orderQuantityInvalid';
    }
    if (parseCost(line.unitCost) === undefined) {
      problems[`cost-${line.variantId}`] = 'purchasing.line.costInvalid';
    }
  }
  return problems;
}

export interface ReceiptLineDraft {
  readonly variantId: string;
  readonly sku: string;
  readonly name: string;
  /** Still due on the order; null when receiving without one. */
  readonly pending: number | null;
  /** The order's cost, used when no cost is typed. */
  readonly orderCostPaise: number | null;
  quantity: string;
  free: string;
  unitCost: string;
}

/** Problems with a receipt's lines, by field ("lines", "qty-<id>", "free-<id>", "cost-<id>"). */
export function checkReceiptLines(lines: readonly ReceiptLineDraft[]): Problems {
  const problems: Problems = {};
  if (lines.length === 0) problems.lines = 'workflow.noLines';
  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);
    const free = parseQuantity(line.free);
    if (quantity === null) problems[`qty-${line.variantId}`] = 'purchasing.line.quantityInvalid';
    else if (line.pending !== null && quantity > line.pending) {
      problems[`qty-${line.variantId}`] = 'purchasing.line.tooMany';
    }
    if (free === null) problems[`free-${line.variantId}`] = 'purchasing.line.quantityInvalid';
    if (quantity !== null && free !== null && quantity + free === 0) {
      problems[`qty-${line.variantId}`] = 'purchasing.line.nothing';
    }
    if (parseCost(line.unitCost) === undefined) {
      problems[`cost-${line.variantId}`] = 'purchasing.line.costInvalid';
    }
  }
  return problems;
}

/** The cost a line will be valued at: what was typed, else the fallback (order or last cost). */
export function effectiveCost(typed: string, fallback: number | null): number | null {
  return parseCost(typed) ?? fallback;
}
