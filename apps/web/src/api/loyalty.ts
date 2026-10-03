import type { LoyaltyTier } from '@paint/shared';
import type { ApiClient } from './client.js';
import type { Page } from './parties.js';

// Loyalty accounts, the points ledger and the programme. Shapes mirror apps/api/src/loyalty.

/** A party's points, worked out from its ledger. */
export interface LoyaltySummary {
  /** Null until the party is enrolled. */
  readonly account: {
    readonly id: string;
    readonly status: 'active' | 'closed';
    readonly assignedTo: { readonly memberId: string; readonly name: string } | null;
    readonly createdAt: string;
  } | null;
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalRedeemed: number;
  readonly tier: LoyaltyTier | null;
  readonly nextTier: (LoyaltyTier & { readonly pointsToGo: number }) | null;
  readonly nextExpiry: { readonly points: number; readonly expiresOn: string } | null;
}

export type LedgerKind = 'purchase' | 'award' | 'campaign' | 'redeem' | 'adjust' | 'expire';

export interface LedgerEntry {
  readonly id: string;
  readonly kind: LedgerKind;
  readonly points: number;
  readonly manualPurchasePaise: number | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly expiresOn: string | null;
  /** Null for points the system expired. */
  readonly createdBy: { readonly memberId: string; readonly name: string } | null;
  readonly createdAt: string;
}

/** GET /parties/:id/loyalty, and the answer to every change. */
export interface LoyaltyView extends LoyaltySummary {
  readonly party: { readonly id: string; readonly name: string };
  /** Newest first. */
  readonly ledger: Page<LedgerEntry>;
}

export interface LoyaltySettings {
  readonly earnPoints: number;
  /** Paise of purchases per `earnPoints`, e.g. 10,000 = ₹100. */
  readonly earnPerPaise: number;
  readonly tiers: LoyaltyTier[];
  /** Null: points never expire. */
  readonly expiryDays: number | null;
  readonly minRedemptionPoints: number;
}

export interface PurchaseInput {
  readonly manualPurchasePaise: number;
  readonly reference: string;
  readonly note?: string;
}

export interface AwardInput {
  readonly points: number;
  readonly campaign?: string;
  readonly note?: string;
}

export interface RedeemInput {
  readonly points: number;
  readonly note?: string;
}

export interface AdjustInput {
  readonly points: number;
  readonly reason: string;
}

/** A team member who can look after an account (GET /members, members:read). */
export interface Salesperson {
  readonly id: string;
  readonly user: { readonly fullName: string };
  readonly role: { readonly name: string };
  readonly isActive: boolean;
}

export function loyaltyEndpoints(api: ApiClient) {
  const base = (partyId: string) => `/parties/${partyId}/loyalty`;
  return {
    get: (partyId: string, page: { limit: number; offset: number }, signal?: AbortSignal) =>
      api.get<LoyaltyView>(base(partyId), { query: page, signal }),
    enrol: (partyId: string, assignedMemberId?: string) =>
      api.post<LoyaltyView>(base(partyId), { assignedMemberId }),
    /** People to choose a salesperson from. */
    salespeople: (signal?: AbortSignal) => api.get<Salesperson[]>('/members', { signal }),
    setStatus: (partyId: string, status: 'active' | 'closed') =>
      api.patch<LoyaltyView>(base(partyId), { status }),
    purchase: (partyId: string, input: PurchaseInput) =>
      api.post<LoyaltyView>(`${base(partyId)}/purchases`, input),
    award: (partyId: string, input: AwardInput) =>
      api.post<LoyaltyView>(`${base(partyId)}/awards`, input),
    redeem: (partyId: string, input: RedeemInput) =>
      api.post<LoyaltyView>(`${base(partyId)}/redemptions`, input),
    adjust: (partyId: string, input: AdjustInput) =>
      api.post<LoyaltyView>(`${base(partyId)}/adjustments`, input),
    settings: (signal?: AbortSignal) => api.get<LoyaltySettings>('/loyalty-settings', { signal }),
    setSettings: (settings: LoyaltySettings) =>
      api.put<LoyaltySettings>('/loyalty-settings', settings),
  };
}
