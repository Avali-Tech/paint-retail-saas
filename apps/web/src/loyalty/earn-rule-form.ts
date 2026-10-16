import type { EarnBasis, EarnRuleInput, EarnRuleView } from '@paint/shared';
import { parseRupees, rupeesInput } from '../lib/inputs.js';

/** The earn rule dialog's fields, as typed. */
export interface EarnRuleValues {
  readonly name: string;
  readonly basis: EarnBasis;
  readonly points: string;
  /** Rupees for the value basis, litres for the litre basis. */
  readonly per: string;
  /** '' for every brand. */
  readonly brandId: string;
  /** ×, e.g. "2" or "1.5". */
  readonly multiplier: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly isActive: boolean;
}

export type EarnRuleProblem =
  | 'earnRules.invalid.name'
  | 'earnRules.invalid.points'
  | 'earnRules.invalid.perRupees'
  | 'earnRules.invalid.perLitres'
  | 'earnRules.invalid.multiplier'
  | 'earnRules.invalid.dates';

/** 1 point for every ₹100, every brand, ×1, always. */
export const NEW_RULE: EarnRuleValues = {
  name: '',
  basis: 'value',
  points: '1',
  per: '100',
  brandId: '',
  multiplier: '1',
  validFrom: '',
  validUntil: '',
  isActive: true,
};

const WHOLE = /^\d+$/;
const DECIMAL = /^\d+(?:\.\d{1,3})?$/;

/** Basis points of a multiplier typed like "1.5" (×0.1 to ×10, to 4 places); null if not one. */
export function parseMultiplier(text: string): number | null {
  const value = text.trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(value)) return null;
  const bps = Math.round(Number(value) * 10_000);
  return bps >= 1_000 && bps <= 100_000 ? bps : null;
}

/** Millilitres of litres typed like "1" or "0.5" (100 ml to 1,000 litres); null if not. */
export function parseLitres(text: string): number | null {
  const value = text.trim();
  if (!DECIMAL.test(value)) return null;
  const millilitres = Math.round(Number(value) * 1000);
  return millilitres >= 100 && millilitres <= 1_000_000 ? millilitres : null;
}

/** The fields, checked, as the API takes them; or the first problem. */
export function readEarnRule(
  values: EarnRuleValues,
): { readonly input: EarnRuleInput } | { readonly problem: EarnRuleProblem } {
  const name = values.name.trim();
  if (name.length === 0 || name.length > 100) return { problem: 'earnRules.invalid.name' };
  const points = values.points.trim();
  if (!WHOLE.test(points) || Number(points) < 1 || Number(points) > 1000) {
    return { problem: 'earnRules.invalid.points' };
  }
  let perPaise: number | null = null;
  let perMillilitres: number | null = null;
  if (values.basis === 'value') {
    perPaise = parseRupees(values.per);
    if (perPaise === null || perPaise < 100 || perPaise > 10_000_000) {
      return { problem: 'earnRules.invalid.perRupees' };
    }
  } else {
    perMillilitres = parseLitres(values.per);
    if (perMillilitres === null) return { problem: 'earnRules.invalid.perLitres' };
  }
  const multiplierBps = parseMultiplier(values.multiplier);
  if (multiplierBps === null) return { problem: 'earnRules.invalid.multiplier' };
  const validFrom = values.validFrom === '' ? null : values.validFrom;
  const validUntil = values.validUntil === '' ? null : values.validUntil;
  if (validFrom !== null && validUntil !== null && validFrom > validUntil) {
    return { problem: 'earnRules.invalid.dates' };
  }
  return {
    input: {
      name,
      basis: values.basis,
      points: Number(points),
      perPaise,
      perMillilitres,
      brandId: values.brandId === '' ? null : values.brandId,
      multiplierBps,
      validFrom,
      validUntil,
      isActive: values.isActive,
    },
  };
}

/** A stored rule as the dialog's fields. */
export function earnRuleValues(rule: EarnRuleView): EarnRuleValues {
  return {
    name: rule.name,
    basis: rule.basis,
    points: String(rule.points),
    per:
      rule.basis === 'value'
        ? rupeesInput(rule.perPaise).replace(/\.00$/, '')
        : String(Number(rule.perMillilitres) / 1000),
    brandId: rule.brand?.id ?? '',
    multiplier: String(rule.multiplierBps / 10_000),
    validFrom: rule.validFrom ?? '',
    validUntil: rule.validUntil ?? '',
    isActive: rule.isActive,
  };
}
