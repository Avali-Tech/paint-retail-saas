import type { AllocationRequest, OpenDocumentView } from '@paint/shared';
import { parseRupees, rupeesInput } from '../lib/inputs.js';

// Putting a payment against a customer's open bills (spec §4.4): oldest first by default,
// as the API does when it is given no list, and editable bill by bill; whatever is not
// put against a bill stays with the customer as an advance.

/** A bill's key: its document, or its ledger entry (an opening balance or a charge). */
export const billKey = (bill: OpenDocumentView): string =>
  String(bill.documentId ?? bill.partyLedgerId);

/** The amounts typed against each bill, in rupees, by bill key. */
export type AllocationTexts = Readonly<Record<string, string>>;

/** Fills the bills oldest first (the list comes oldest first) until the money runs out. */
export function oldestFirst(
  bills: readonly OpenDocumentView[],
  availablePaise: number,
): AllocationTexts {
  let left = availablePaise;
  const texts: Record<string, string> = {};
  for (const bill of bills) {
    const take = Math.max(0, Math.min(left, bill.outstandingPaise));
    texts[billKey(bill)] = take === 0 ? '' : rupeesInput(take);
    left -= take;
  }
  return texts;
}

/** Why an amount against a bill cannot be taken. */
export type AllocationProblem = 'invalid' | 'tooMuch';

export interface AllocationCheck {
  /** The rows to send: bills with an amount above zero, oldest first. */
  readonly allocations: AllocationRequest[];
  readonly allocatedPaise: number;
  /** What stays as an advance; negative when more is allocated than there is. */
  readonly advancePaise: number;
  readonly problems: Readonly<Record<string, AllocationProblem>>;
  readonly ok: boolean;
}

/** Checks the typed amounts: each a rupee amount up to what the bill still owes, all within the money. */
export function checkAllocations(
  bills: readonly OpenDocumentView[],
  texts: AllocationTexts,
  availablePaise: number,
): AllocationCheck {
  const allocations: AllocationRequest[] = [];
  const problems: Record<string, AllocationProblem> = {};
  for (const bill of bills) {
    const key = billKey(bill);
    const text = (texts[key] ?? '').trim();
    if (text === '') continue;
    const paise = parseRupees(text);
    if (paise === null || paise < 0) {
      problems[key] = 'invalid';
    } else if (paise > bill.outstandingPaise) {
      problems[key] = 'tooMuch';
    } else if (paise > 0) {
      allocations.push({
        ...(bill.documentId === null
          ? { partyLedgerId: String(bill.partyLedgerId) }
          : { documentId: bill.documentId }),
        amountPaise: paise,
      });
    }
  }
  const allocatedPaise = allocations.reduce((sum, row) => sum + row.amountPaise, 0);
  const advancePaise = availablePaise - allocatedPaise;
  return {
    allocations,
    allocatedPaise,
    advancePaise,
    problems,
    ok: Object.keys(problems).length === 0 && advancePaise >= 0,
  };
}
