import type { EarnBasis, EarnRule } from './earn.js';

/**
 * Earn rules as the API answers and the rules screen reads them (P2-M36,
 * GET /loyalty-earn-rules). Dates are India-time `YYYY-MM-DD`.
 */
export interface EarnRuleView {
  readonly id: string;
  readonly name: string;
  readonly basis: EarnBasis;
  readonly points: number;
  /** Value basis: points per this many paise of taxable value (10,000 = per ₹100). */
  readonly perPaise: number | null;
  /** Litre basis: points per this many millilitres (1,000 = per litre). */
  readonly perMillilitres: number | null;
  /** Only lines of this brand; null for every brand. */
  readonly brand: { readonly id: string; readonly name: string } | null;
  /** 10,000 = ×1. */
  readonly multiplierBps: number;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly isActive: boolean;
  readonly updatedAt: string;
}

/** POST /loyalty-earn-rules and PUT /loyalty-earn-rules/:id. */
export interface EarnRuleInput {
  readonly name: string;
  readonly basis: EarnBasis;
  readonly points: number;
  /** Value basis only. */
  readonly perPaise: number | null;
  /** Litre basis only. */
  readonly perMillilitres: number | null;
  readonly brandId: string | null;
  readonly multiplierBps: number;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly isActive: boolean;
}

/** A stored rule, as the engine applies it. */
export function toEarnRule(rule: {
  readonly id: string;
  readonly basis: EarnBasis;
  readonly points: number;
  readonly perPaise: number | null;
  readonly perMillilitres: number | null;
  readonly brandId: string | null;
  readonly multiplierBps: number;
}): EarnRule {
  return {
    id: rule.id,
    basis: rule.basis,
    points: rule.points,
    per: Number(rule.basis === 'value' ? rule.perPaise : rule.perMillilitres),
    brandId: rule.brandId,
    multiplierBps: rule.multiplierBps,
  };
}

/** Whether a rule applies to an invoice issued on `day` (YYYY-MM-DD). */
export function ruleInForce(
  rule: {
    readonly isActive: boolean;
    readonly validFrom: string | null;
    readonly validUntil: string | null;
  },
  day: string,
): boolean {
  return (
    rule.isActive &&
    (rule.validFrom === null || rule.validFrom <= day) &&
    (rule.validUntil === null || day <= rule.validUntil)
  );
}
