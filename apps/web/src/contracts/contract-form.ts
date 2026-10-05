import { z } from 'zod';
import {
  CONTRACT_TYPES,
  type Contract,
  type ContractChange,
  type NewContract,
} from '../api/contracts.js';
import type { I18n } from '../i18n/i18n.js';
import { isDate } from '../lib/india-time.js';
import { optional, parseRupees, rupeesInput } from '../lib/inputs.js';

/** The contract form's checks, mirroring the API's (contracts.schemas.ts). */
export function contractSchema(t: I18n['t']) {
  const date = z.string().refine(isDate, t('contracts.form.dateInvalid'));
  return z
    .object({
      type: z.enum(CONTRACT_TYPES),
      title: z.string().trim().min(1, t('contracts.form.titleInvalid')).max(160),
      storeId: z.string(),
      startDate: date,
      endDate: date,
      renewalDate: z.string().refine((value) => value === '' || isDate(value), {
        message: t('contracts.form.dateInvalid'),
      }),
      value: z.string().refine((value) => {
        if (value.trim() === '') return true;
        const paise = parseRupees(value);
        return paise !== null && paise >= 0;
      }, t('contracts.form.valueInvalid')),
      terms: z.string().max(8000),
      creditTerms: z.string().max(2000),
      discountTerms: z.string().max(2000),
      notes: z.string().max(4000),
      assignedMemberId: z.string(),
    })
    .refine((values) => values.endDate >= values.startDate, {
      path: ['endDate'],
      message: t('contracts.form.endBeforeStart'),
    })
    .refine((values) => values.renewalDate === '' || values.renewalDate <= values.endDate, {
      path: ['renewalDate'],
      message: t('contracts.form.renewalAfterEnd'),
    });
}

export type ContractValues = z.output<ReturnType<typeof contractSchema>>;

/** The form's starting values: a new contract, or the one being edited. */
export function contractValues(contract: Contract | null): ContractValues {
  return {
    type: contract?.type ?? 'contractor_agreement',
    title: contract?.title ?? '',
    storeId: contract?.store?.id ?? '',
    startDate: contract?.startDate ?? '',
    endDate: contract?.endDate ?? '',
    renewalDate: contract?.renewalDate ?? '',
    value: rupeesInput(contract?.valuePaise ?? null),
    terms: contract?.terms ?? '',
    creditTerms: contract?.creditTerms ?? '',
    discountTerms: contract?.discountTerms ?? '',
    notes: contract?.notes ?? '',
    assignedMemberId: contract?.assignedTo.memberId ?? '',
  };
}

/** Rupees typed in the form as paise; null when left empty. */
const paiseOf = (value: string) => (value.trim() === '' ? null : parseRupees(value));

/** POST /contracts: empty fields are left out so the API's defaults apply. */
export function toNewContract(values: ContractValues, partyId: string): NewContract {
  const text = (value: string) => optional(value) ?? undefined;
  const value = paiseOf(values.value);
  const entries = {
    storeId: text(values.storeId),
    renewalDate: text(values.renewalDate),
    valuePaise: value ?? undefined,
    terms: text(values.terms),
    creditTerms: text(values.creditTerms),
    discountTerms: text(values.discountTerms),
    notes: text(values.notes),
    assignedMemberId: text(values.assignedMemberId),
  };
  return {
    type: values.type,
    title: values.title.trim(),
    partyId,
    startDate: values.startDate,
    endDate: values.endDate,
    ...Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry !== undefined)),
  };
}

/**
 * PATCH /contracts/:id: every field, null clearing an emptied one. An empty
 * renewal date is left out, so moving the dates resets it to the default.
 */
export function toContractChange(values: ContractValues): ContractChange {
  return {
    type: values.type,
    title: values.title.trim(),
    startDate: values.startDate,
    endDate: values.endDate,
    ...(values.renewalDate === '' ? {} : { renewalDate: values.renewalDate }),
    valuePaise: paiseOf(values.value),
    terms: optional(values.terms),
    creditTerms: optional(values.creditTerms),
    discountTerms: optional(values.discountTerms),
    notes: optional(values.notes),
    ...(values.assignedMemberId === '' ? {} : { assignedMemberId: values.assignedMemberId }),
  };
}
