import {
  DEFAULT_AMOUNT_TOLERANCE_PAISE,
  DEFAULT_DATE_WINDOW_DAYS,
  MAX_AMOUNT_TOLERANCE_PAISE,
  MAX_DATE_WINDOW_DAYS,
  TYPED_LINE_KINDS,
  type StatementAmountMode,
  type StatementDateFormat,
  type StatementGrnBasis,
  type StatementSignConvention,
  type StatementTemplateInput,
  type StatementTemplateView,
  type StatementTypeRules,
  type TypedLineKind,
} from '@paint/shared';
import { optional, parseRupees, rupeesInput, splitList } from '../lib/inputs.js';

// The statement template editor's form (P2-M34): text as typed, read into the API's
// template, with the problems by field.

export interface TemplateValues {
  readonly name: string;
  readonly supplierPartyId: string;
  /** '' for none. */
  readonly brandId: string;
  readonly headerRowsToSkip: string;
  readonly dateColumn: string;
  readonly documentColumn: string;
  readonly typeColumn: string;
  readonly referenceColumn: string;
  readonly descriptionColumn: string;
  readonly amountMode: StatementAmountMode;
  readonly debitColumn: string;
  readonly creditColumn: string;
  readonly amountColumn: string;
  readonly signConvention: StatementSignConvention;
  readonly dateFormat: StatementDateFormat;
  /** Comma-separated words per kind. */
  readonly words: Readonly<Record<TypedLineKind, string>>;
  readonly dateWindowDays: string;
  /** Rupees. */
  readonly tolerance: string;
  readonly grnAmountBasis: StatementGrnBasis;
  readonly isActive: boolean;
}

export const NEW_TEMPLATE: TemplateValues = {
  name: '',
  supplierPartyId: '',
  brandId: '',
  headerRowsToSkip: '0',
  dateColumn: 'Date',
  documentColumn: 'Document No',
  typeColumn: 'Type',
  referenceColumn: '',
  descriptionColumn: 'Narration',
  amountMode: 'debit_credit',
  debitColumn: 'Debit',
  creditColumn: 'Credit',
  amountColumn: '',
  signConvention: 'debit_positive',
  dateFormat: 'dd-mm-yyyy',
  words: {
    opening: 'Opening',
    invoice: 'Invoice, INV',
    credit_note: 'Credit Note, CN',
    debit_note: 'Debit Note, DN',
    payment: 'Receipt, Payment',
  },
  dateWindowDays: String(DEFAULT_DATE_WINDOW_DAYS),
  tolerance: rupeesInput(DEFAULT_AMOUNT_TOLERANCE_PAISE),
  grnAmountBasis: 'with_gst',
  isActive: true,
};

/** A saved template as the form shows it. */
export function templateValues(template: StatementTemplateView): TemplateValues {
  return {
    name: template.name,
    supplierPartyId: template.supplierPartyId,
    brandId: template.brandId ?? '',
    headerRowsToSkip: String(template.headerRowsToSkip),
    dateColumn: template.dateColumn,
    documentColumn: template.documentColumn,
    typeColumn: template.typeColumn ?? '',
    referenceColumn: template.referenceColumn ?? '',
    descriptionColumn: template.descriptionColumn ?? '',
    amountMode: template.amountMode,
    debitColumn: template.debitColumn ?? '',
    creditColumn: template.creditColumn ?? '',
    amountColumn: template.amountColumn ?? '',
    signConvention: template.signConvention,
    dateFormat: template.dateFormat,
    words: Object.fromEntries(
      TYPED_LINE_KINDS.map((kind) => [kind, (template.typeRules[kind] ?? []).join(', ')]),
    ) as Record<TypedLineKind, string>,
    dateWindowDays: String(template.dateWindowDays),
    tolerance: rupeesInput(template.amountTolerancePaise),
    grnAmountBasis: template.grnAmountBasis,
    isActive: template.isActive,
  };
}

export type TemplateField =
  | 'name'
  | 'supplierPartyId'
  | 'headerRowsToSkip'
  | 'dateColumn'
  | 'documentColumn'
  | 'debitColumn'
  | 'creditColumn'
  | 'amountColumn'
  | 'dateWindowDays'
  | 'tolerance';

/** Why a field is refused: it is needed, or out of its range. */
export type TemplateProblem = 'required' | 'range';

export type TemplateRead =
  | { readonly ok: true; readonly input: StatementTemplateInput }
  | { readonly ok: false; readonly problems: Partial<Record<TemplateField, TemplateProblem>> };

const WHOLE = /^\d+$/;

/** The words typed for each kind, leaving out kinds with none. */
function typeRulesOf(words: TemplateValues['words']): StatementTypeRules {
  const rules: Partial<Record<TypedLineKind, string[]>> = {};
  for (const kind of TYPED_LINE_KINDS) {
    const list = splitList(words[kind]);
    if (list.length > 0) rules[kind] = list;
  }
  return rules;
}

/** The form read as the API checks it. */
export function readTemplate(values: TemplateValues): TemplateRead {
  const problems: Partial<Record<TemplateField, TemplateProblem>> = {};
  const needed = (field: TemplateField, value: string) => {
    if (value.trim() === '') problems[field] = 'required';
  };
  needed('name', values.name);
  needed('supplierPartyId', values.supplierPartyId);
  needed('dateColumn', values.dateColumn);
  needed('documentColumn', values.documentColumn);
  if (values.amountMode === 'debit_credit') {
    needed('debitColumn', values.debitColumn);
    needed('creditColumn', values.creditColumn);
  } else {
    needed('amountColumn', values.amountColumn);
  }
  const whole = (field: TemplateField, text: string, max: number) => {
    const value = text.trim();
    if (!WHOLE.test(value) || Number(value) > max) problems[field] = 'range';
    return Number(value);
  };
  const headerRowsToSkip = whole('headerRowsToSkip', values.headerRowsToSkip, 50);
  const dateWindowDays = whole('dateWindowDays', values.dateWindowDays, MAX_DATE_WINDOW_DAYS);
  const tolerance = parseRupees(values.tolerance.trim());
  if (tolerance === null || tolerance < 0 || tolerance > MAX_AMOUNT_TOLERANCE_PAISE) {
    problems.tolerance = 'range';
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const signed = values.amountMode === 'signed';
  return {
    ok: true,
    input: {
      name: values.name.trim(),
      supplierPartyId: values.supplierPartyId,
      brandId: values.brandId === '' ? null : values.brandId,
      headerRowsToSkip,
      dateColumn: values.dateColumn.trim(),
      documentColumn: values.documentColumn.trim(),
      typeColumn: optional(values.typeColumn),
      referenceColumn: optional(values.referenceColumn),
      descriptionColumn: optional(values.descriptionColumn),
      amountMode: values.amountMode,
      debitColumn: signed ? null : values.debitColumn.trim(),
      creditColumn: signed ? null : values.creditColumn.trim(),
      amountColumn: signed ? values.amountColumn.trim() : null,
      signConvention: values.signConvention,
      dateFormat: values.dateFormat,
      typeRules: typeRulesOf(values.words),
      dateWindowDays,
      amountTolerancePaise: Number(tolerance),
      grnAmountBasis: values.grnAmountBasis,
      isActive: values.isActive,
    },
  };
}
