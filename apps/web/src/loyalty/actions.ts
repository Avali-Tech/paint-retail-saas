import type { Endpoints } from '../api/endpoints.js';
import type { MessageKey } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';

/** What can be done to a loyalty account from the customer 360. */
export const LOYALTY_ACTIONS = ['purchase', 'award', 'redeem', 'adjust'] as const;
export type LoyaltyAction = (typeof LOYALTY_ACTIONS)[number];

export type ActionField = 'amount' | 'reference' | 'points' | 'campaign' | 'note' | 'reason';

/** The fields each action asks for, in order. */
export const ACTION_FIELDS: Record<LoyaltyAction, readonly ActionField[]> = {
  purchase: ['amount', 'reference', 'note'],
  award: ['points', 'campaign', 'note'],
  redeem: ['points', 'note'],
  adjust: ['points', 'reason'],
};

export type ActionValues = Readonly<Record<ActionField, string>>;

export const EMPTY_VALUES: ActionValues = {
  amount: '',
  reference: '',
  points: '',
  campaign: '',
  note: '',
  reason: '',
};

/** Points in one entry: up to ten million, as the API allows. */
const MAX_POINTS = 10_000_000;

const text = (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

function points(value: string, signed: boolean): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  const ok = signed ? parsed !== 0 : parsed > 0;
  return ok && Math.abs(parsed) <= MAX_POINTS ? parsed : null;
}

type Call = (api: Endpoints['loyalty'], partyId: string) => Promise<unknown>;

/**
 * Checks what was typed for an action: the API call to make, or the message
 * for the first thing that is wrong.
 */
export function prepareAction(
  action: LoyaltyAction,
  values: ActionValues,
): { readonly call: Call } | { readonly problem: MessageKey } {
  const note = text(values.note);
  switch (action) {
    case 'purchase': {
      const amount = parseRupees(values.amount);
      const reference = text(values.reference);
      if (amount === null || amount <= 0) return { problem: 'loyalty.invalid.amount' };
      if (reference === undefined) return { problem: 'loyalty.invalid.reference' };
      return {
        call: (api, partyId) =>
          api.purchase(partyId, { manualPurchasePaise: amount, reference, note }),
      };
    }
    case 'award':
    case 'redeem': {
      const count = points(values.points, false);
      if (count === null) return { problem: 'loyalty.invalid.points' };
      const campaign = text(values.campaign);
      return {
        call: (api, partyId) =>
          action === 'award'
            ? api.award(partyId, { points: count, campaign, note })
            : api.redeem(partyId, { points: count, note }),
      };
    }
    case 'adjust': {
      const count = points(values.points, true);
      const reason = text(values.reason);
      if (count === null) return { problem: 'loyalty.invalid.adjustPoints' };
      if (reason === undefined) return { problem: 'loyalty.invalid.reason' };
      return { call: (api, partyId) => api.adjust(partyId, { points: count, reason }) };
    }
  }
}
