import {
  COLORANT_MAX_LENGTH,
  COLORANT_UNITS,
  MAX_FORMULA_COMPONENTS,
  SHADE_NAME_MAX_LENGTH,
  TINT_MACHINE_MAX_LENGTH,
  normalizeShadeCode,
  type ColorantUnit,
  type TintFormulaComponent,
  type LineTintRequest,
  type LineTintView,
} from '@paint/shared';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { parsePositiveQuantity } from '../lib/quantity.js';
import type { BillLine } from '../pos/bill.js';

// A line's tint (spec §6.3) while it is on the bill: the shade, its formula and the
// machine. It travels inline with the line on every draft save and is read back with it.

/** A product from the catalog API whose packs are tint bases (`isTintable`, round 5a). */
export const isTintableProduct = (product: object): boolean =>
  'isTintable' in product && product.isTintable === true;

/** The shade a line's base is tinted to, as chosen on the screen. */
export interface TintChoice {
  readonly shadeCode: string;
  readonly shadeName: string | null;
  /** The shade card's brand when it came from a past record; null for the base's brand. */
  readonly brandId: string | null;
  readonly machine: string | null;
  readonly formula: readonly TintFormulaComponent[];
  /** Per pack, billed in the line's unit price. */
  readonly tintChargePaise: number;
  /** Per pack, kept for margin only. */
  readonly colorantCostPaise: number | null;
  /** A note read with the tint; not edited here, sent back unchanged. */
  readonly note: string | null;
}

export interface LineTint extends TintChoice {
  /** The line's unit price before the tinting charge. */
  readonly basePricePaise: number;
}

/** The line with this tint (or none): its unit price is the base price plus the charge. */
export function withTint(line: BillLine, choice: TintChoice | null): BillLine {
  const basePricePaise = line.tint?.basePricePaise ?? line.unitPricePaise;
  if (choice === null) return { ...line, tint: null, unitPricePaise: basePricePaise };
  return {
    ...line,
    tint: { ...choice, basePricePaise },
    unitPricePaise: basePricePaise + choice.tintChargePaise,
  };
}

/** A tint read back (a line's own, or a past record) as a choice for a line. */
export const choiceFromRecord = (record: LineTintView): TintChoice => ({
  shadeCode: record.shadeCode,
  shadeName: record.shadeName,
  brandId: record.brand.id,
  machine: record.machine,
  formula: record.formula,
  tintChargePaise: record.tintChargePaise,
  colorantCostPaise: record.colorantCostPaise,
  note: record.note,
});

/**
 * The tint sent with the line (POST/PUT of a draft). The packs tinted are left to
 * the server: all of the line's, whatever its quantity is now.
 */
export function lineTint(tint: TintChoice): LineTintRequest {
  return {
    shadeCode: tint.shadeCode,
    tintChargePaise: tint.tintChargePaise,
    formula: tint.formula,
    ...(tint.shadeName === null ? {} : { shadeName: tint.shadeName }),
    ...(tint.brandId === null ? {} : { brandId: tint.brandId }),
    ...(tint.machine === null ? {} : { machine: tint.machine }),
    ...(tint.colorantCostPaise === null ? {} : { colorantCostPaise: tint.colorantCostPaise }),
    ...(tint.note === null ? {} : { note: tint.note }),
  };
}

/** A saved line with the tint read with it (its saved price includes the charge). */
export function withViewTint(line: BillLine, view: LineTintView | undefined): BillLine {
  // The server's word wins over anything this device remembered.
  const plain = { ...line, tint: null };
  if (view === undefined) return plain;
  const base = { ...plain, unitPricePaise: line.unitPricePaise - view.tintChargePaise };
  return { ...withTint(base, choiceFromRecord(view)), tintable: true };
}

/** "X 132 · Ivory": the shade as the line shows it. */
export const shadeLabel = (tint: Pick<TintChoice, 'shadeCode' | 'shadeName'>) =>
  tint.shadeName === null ? tint.shadeCode : `${tint.shadeCode} · ${tint.shadeName}`;

// The tint form -------------------------------------------------------------------

export interface FormulaRow {
  readonly colorant: string;
  readonly amount: string;
  readonly unit: ColorantUnit;
}

export interface TintForm {
  readonly shadeCode: string;
  readonly shadeName: string;
  readonly brandId: string | null;
  readonly machine: string;
  readonly charge: string;
  readonly cost: string;
  readonly formula: readonly FormulaRow[];
  /** Carried unedited from the tint being changed. */
  readonly note: string | null;
}

export const EMPTY_ROW: FormulaRow = { colorant: '', amount: '', unit: COLORANT_UNITS[0] };

/** The form filled from a tint (or empty, with one formula row). */
export function formOf(tint: TintChoice | null): TintForm {
  if (tint === null) {
    return {
      shadeCode: '',
      shadeName: '',
      brandId: null,
      machine: '',
      charge: '',
      cost: '',
      formula: [EMPTY_ROW],
      note: null,
    };
  }
  return {
    shadeCode: tint.shadeCode,
    shadeName: tint.shadeName ?? '',
    brandId: tint.brandId,
    machine: tint.machine ?? '',
    charge: tint.tintChargePaise === 0 ? '' : rupeesInput(tint.tintChargePaise),
    cost: rupeesInput(tint.colorantCostPaise),
    formula:
      tint.formula.length === 0
        ? [EMPTY_ROW]
        : tint.formula.map((part) => ({
            colorant: part.colorant,
            amount: String(part.amount),
            unit: part.unit,
          })),
    note: tint.note,
  };
}

export type TintField = 'shadeCode' | 'shadeName' | 'machine' | 'charge' | 'cost' | 'formula';
export type TintProblem = 'shadeCode' | 'tooLong' | 'amount' | 'formulaRow' | 'tooManyColorants';
export type TintProblems = Partial<Record<TintField, TintProblem>>;

const optionalText = (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** A rupee amount, 0 or more; "" is `empty`. Null when it is not one. */
function money(text: string, empty: number | null): number | null | undefined {
  if (text.trim() === '') return empty;
  const paise = parseRupees(text);
  return paise === null || paise < 0 ? undefined : paise;
}

function formulaOf(rows: readonly FormulaRow[]): TintFormulaComponent[] | TintProblem {
  const filled = rows.filter((row) => row.colorant.trim() !== '' || row.amount.trim() !== '');
  if (filled.length > MAX_FORMULA_COMPONENTS) return 'tooManyColorants';
  const formula: TintFormulaComponent[] = [];
  for (const row of filled) {
    const colorant = row.colorant.trim();
    const amount = parsePositiveQuantity(row.amount);
    if (colorant === '' || colorant.length > COLORANT_MAX_LENGTH || amount === null) {
      return 'formulaRow';
    }
    formula.push({ colorant, amount, unit: row.unit });
  }
  return formula;
}

/** The form checked: the tint to apply, or what is wrong with it. */
export function parseTintForm(
  form: TintForm,
): { ok: true; tint: TintChoice } | { ok: false; problems: TintProblems } {
  const problems: TintProblems = {};
  const shadeCode = normalizeShadeCode(form.shadeCode);
  if (shadeCode === null) problems.shadeCode = 'shadeCode';
  const shadeName = optionalText(form.shadeName);
  if (shadeName !== null && shadeName.length > SHADE_NAME_MAX_LENGTH)
    problems.shadeName = 'tooLong';
  const machine = optionalText(form.machine);
  if (machine !== null && machine.length > TINT_MACHINE_MAX_LENGTH) problems.machine = 'tooLong';
  const charge = money(form.charge, 0);
  if (charge === undefined) problems.charge = 'amount';
  const cost = money(form.cost, null);
  if (cost === undefined) problems.cost = 'amount';
  const formula = formulaOf(form.formula);
  if (typeof formula === 'string') problems.formula = formula;
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return {
    ok: true,
    tint: {
      shadeCode: String(shadeCode),
      shadeName,
      brandId: form.brandId,
      machine,
      formula: formula as TintFormulaComponent[],
      tintChargePaise: Number(charge),
      colorantCostPaise: cost ?? null,
      note: form.note,
    },
  };
}
