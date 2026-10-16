import type {
  SchemeDateBasis,
  SchemeInput,
  SchemeView,
  SlabBenefit,
  SlabMeasure,
  SlabMode,
} from '@paint/shared';
import { optional, parseRupees, rupeesInput } from '../lib/inputs.js';

// The scheme editor's fields as typed, and what the API takes (P2-M33).

export type BenefitKind = SlabBenefit['kind'];

/** One benefit as typed: only the fields of its kind are read. */
export interface BenefitValues {
  readonly kind: BenefitKind;
  /** Rebate: percent of value, e.g. "1.5". */
  readonly percent: string;
  /** Per litre: rupees a litre, e.g. "2.50". */
  readonly rupeesPerLitre: string;
  /** Free goods: the pack and how many. */
  readonly variantId: string;
  readonly units: string;
  /** Free goods: for every this many litres; empty for once on reaching the slab. */
  readonly perLitres: string;
  /** Points: what for (e.g. "Goa trip") and how many. */
  readonly label: string;
  readonly points: string;
}

export interface SlabValues {
  /** Rupees for a value scheme, litres for a litres one. */
  readonly target: string;
  readonly benefits: readonly BenefitValues[];
}

export interface SchemeValues {
  readonly brandId: string;
  readonly name: string;
  readonly brandReference: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly measure: SlabMeasure;
  readonly mode: SlabMode;
  /** Empty for 45 days. */
  readonly settlementDays: string;
  readonly dateBasis: SchemeDateBasis;
  readonly note: string;
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly slabs: readonly SlabValues[];
}

export type SchemeProblem =
  | 'schemes.invalid.brand'
  | 'schemes.invalid.name'
  | 'schemes.invalid.dates'
  | 'schemes.invalid.settlement'
  | 'schemes.invalid.target'
  | 'schemes.invalid.rising'
  | 'schemes.invalid.noBenefit'
  | 'schemes.invalid.percent'
  | 'schemes.invalid.rupeesPerLitre'
  | 'schemes.invalid.variant'
  | 'schemes.invalid.units'
  | 'schemes.invalid.perLitres'
  | 'schemes.invalid.label'
  | 'schemes.invalid.points';

export const NEW_BENEFIT: BenefitValues = {
  kind: 'rebate',
  percent: '',
  rupeesPerLitre: '',
  variantId: '',
  units: '1',
  perLitres: '',
  label: '',
  points: '1',
};

export const NEW_SLAB: SlabValues = { target: '', benefits: [NEW_BENEFIT] };

export const NEW_SCHEME: SchemeValues = {
  brandId: '',
  name: '',
  brandReference: '',
  startsOn: '',
  endsOn: '',
  measure: 'value',
  mode: 'retro',
  settlementDays: '',
  dateBasis: 'grn_date',
  note: '',
  productIds: [],
  categoryIds: [],
  slabs: [NEW_SLAB],
};

const WHOLE = /^\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Basis points of a percent typed like "1.5" (0.01 % to 100 %); null if not one. */
export function parsePercent(text: string): number | null {
  const value = text.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const bps = Math.round(Number(value) * 100);
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

/** Millilitres of litres typed like "250" or "0.5" (more than 0); null if not. */
export function parseLitres(text: string): number | null {
  const value = text.trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) return null;
  const millilitres = Math.round(Number(value) * 1000);
  return millilitres > 0 ? millilitres : null;
}

/** A whole number from `min` to `max` typed by a person; null if not one. */
function whole(text: string, min: number, max: number): number | null {
  const value = text.trim();
  if (!WHOLE.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

const litresText = (millilitres: number) => String(millilitres / 1000);

/** A target as typed for the scheme's measure: paise or millilitres; null if not one. */
export function parseTarget(text: string, measure: SlabMeasure): number | null {
  const amount = measure === 'value' ? parseRupees(text) : parseLitres(text);
  return amount !== null && amount > 0 ? amount : null;
}

function readBenefit(values: BenefitValues): SlabBenefit | SchemeProblem {
  switch (values.kind) {
    case 'rebate': {
      const basisPoints = parsePercent(values.percent);
      return basisPoints === null ? 'schemes.invalid.percent' : { kind: 'rebate', basisPoints };
    }
    case 'per_litre': {
      const paisePerLitre = parseRupees(values.rupeesPerLitre);
      return paisePerLitre === null || paisePerLitre <= 0
        ? 'schemes.invalid.rupeesPerLitre'
        : { kind: 'per_litre', paisePerLitre };
    }
    case 'free_goods': {
      if (values.variantId === '') return 'schemes.invalid.variant';
      const units = whole(values.units, 1, 1_000_000);
      if (units === null) return 'schemes.invalid.units';
      const perMillilitres = values.perLitres.trim() === '' ? null : parseLitres(values.perLitres);
      if (perMillilitres === null && values.perLitres.trim() !== '') {
        return 'schemes.invalid.perLitres';
      }
      return { kind: 'free_goods', variantId: values.variantId, units, perMillilitres };
    }
    case 'points': {
      const label = values.label.trim();
      if (label === '' || label.length > 60) return 'schemes.invalid.label';
      const points = whole(values.points, 1, 100_000_000);
      return points === null ? 'schemes.invalid.points' : { kind: 'points', label, points };
    }
  }
}

/** The fields, checked, as the API takes them; or the first problem. */
export function readScheme(
  values: SchemeValues,
): { readonly input: SchemeInput } | { readonly problem: SchemeProblem } {
  if (values.brandId === '') return { problem: 'schemes.invalid.brand' };
  const name = values.name.trim();
  if (name === '' || name.length > 120) return { problem: 'schemes.invalid.name' };
  if (!DATE.test(values.startsOn) || !DATE.test(values.endsOn) || values.endsOn < values.startsOn) {
    return { problem: 'schemes.invalid.dates' };
  }
  const settlementDays =
    values.settlementDays.trim() === '' ? null : whole(values.settlementDays, 0, 365);
  if (settlementDays === null && values.settlementDays.trim() !== '') {
    return { problem: 'schemes.invalid.settlement' };
  }
  const slabs: { target: number; benefits: SlabBenefit[] }[] = [];
  for (const slab of values.slabs) {
    const target = parseTarget(slab.target, values.measure);
    if (target === null) return { problem: 'schemes.invalid.target' };
    const previous = slabs.at(-1);
    if (previous !== undefined && target <= previous.target) {
      return { problem: 'schemes.invalid.rising' };
    }
    if (slab.benefits.length === 0) return { problem: 'schemes.invalid.noBenefit' };
    const benefits: SlabBenefit[] = [];
    for (const benefit of slab.benefits) {
      const read = readBenefit(benefit);
      if (typeof read === 'string') return { problem: read };
      benefits.push(read);
    }
    slabs.push({ target, benefits });
  }
  return {
    input: {
      brandId: values.brandId,
      name,
      brandReference: optional(values.brandReference),
      startsOn: values.startsOn,
      endsOn: values.endsOn,
      measure: values.measure,
      mode: values.mode,
      settlementDays,
      dateBasis: values.dateBasis,
      note: optional(values.note),
      productIds: values.productIds,
      categoryIds: values.categoryIds,
      slabs,
    },
  };
}

function benefitValues(benefit: SlabBenefit): BenefitValues {
  switch (benefit.kind) {
    case 'rebate':
      return { ...NEW_BENEFIT, kind: 'rebate', percent: String(benefit.basisPoints / 100) };
    case 'per_litre':
      return {
        ...NEW_BENEFIT,
        kind: 'per_litre',
        rupeesPerLitre: rupeesInput(benefit.paisePerLitre),
      };
    case 'free_goods':
      return {
        ...NEW_BENEFIT,
        kind: 'free_goods',
        variantId: benefit.variantId,
        units: String(benefit.units),
        perLitres: benefit.perMillilitres === null ? '' : litresText(benefit.perMillilitres),
      };
    case 'points':
      return {
        ...NEW_BENEFIT,
        kind: 'points',
        label: benefit.label,
        points: String(benefit.points),
      };
  }
}

/** A stored scheme's fields, to change it. */
export function schemeValues(scheme: SchemeView): SchemeValues {
  return {
    brandId: scheme.brand.id,
    name: scheme.name,
    brandReference: scheme.brandReference ?? '',
    startsOn: scheme.startsOn,
    endsOn: scheme.endsOn,
    measure: scheme.measure,
    mode: scheme.mode,
    settlementDays: scheme.settlementDays === null ? '' : String(scheme.settlementDays),
    dateBasis: scheme.dateBasis,
    note: scheme.note ?? '',
    productIds: scheme.products.map((product) => product.id),
    categoryIds: scheme.categories.map((category) => category.id),
    slabs: scheme.slabs.map((slab) => ({
      target: scheme.measure === 'value' ? rupeesInput(slab.target) : litresText(slab.target),
      benefits: slab.benefits.map(benefitValues),
    })),
  };
}
