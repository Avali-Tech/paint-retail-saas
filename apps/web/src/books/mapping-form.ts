import {
  LEDGER_MATCH_FIELDS,
  type LedgerMappingRequest,
  type LedgerMappingView,
  type PaymentModeKind,
  type SupplyType,
  type TallyGroup,
  type TallyLedgerPurpose,
  type TaxNature,
} from '@paint/shared';
import { parseNumber } from '../lib/inputs.js';

// The ledger-mapping form as typed text, and the request it makes: pure, tested on its own.

export interface MappingForm {
  readonly purpose: TallyLedgerPurpose;
  /** A percentage as typed: "18", "2.5". */
  readonly rate: string;
  readonly nature: TaxNature | '';
  readonly supplyType: SupplyType | '';
  readonly storeId: string;
  readonly modeKind: PaymentModeKind | '';
  readonly modeId: string;
  readonly party: { readonly id: string; readonly name: string } | null;
  readonly ledgerName: string;
  readonly group: TallyGroup | '';
  readonly position: string;
}

export const EMPTY_MAPPING: MappingForm = {
  purpose: 'sales',
  rate: '',
  nature: '',
  supplyType: '',
  storeId: '',
  modeKind: '',
  modeId: '',
  party: null,
  ledgerName: '',
  group: '',
  position: '0',
};

/** A saved mapping back in the form, to edit it. */
export function formOf(mapping: LedgerMappingView): MappingForm {
  return {
    purpose: mapping.purpose,
    rate: mapping.rateBasisPoints === null ? '' : String(mapping.rateBasisPoints / 100),
    nature: mapping.nature ?? '',
    supplyType: mapping.supplyType ?? '',
    storeId: mapping.storeId ?? '',
    modeKind: mapping.modeKind ?? '',
    modeId: mapping.modeId ?? '',
    party:
      mapping.partyId === null
        ? null
        : { id: mapping.partyId, name: mapping.partyName ?? mapping.partyId },
    ledgerName: mapping.ledgerName,
    group: mapping.group ?? '',
    position: String(mapping.position),
  };
}

export type MappingProblem = 'rate' | 'party' | 'ledgerName' | 'position';

/** "18" -> 1800 basis points; null unless a percentage from 0 to 100 in hundredths. */
export function percentToBps(text: string): number | null {
  const value = parseNumber(text);
  if (value === null || value < 0 || value > 100) return null;
  const bps = Math.round(value * 100);
  return Math.abs(bps - value * 100) < 1e-9 ? bps : null;
}

/**
 * The request for the form, sending only the match keys the purpose can use
 * (a value typed under another purpose is dropped), or what is wrong.
 */
export function mappingRequest(
  form: MappingForm,
): { readonly request: LedgerMappingRequest } | { readonly problems: MappingProblem[] } {
  const fields = LEDGER_MATCH_FIELDS[form.purpose];
  const uses = (field: (typeof fields)[number]) => fields.includes(field);
  const problems: MappingProblem[] = [];
  const rate = form.rate.trim() === '' ? undefined : percentToBps(form.rate);
  if (uses('rateBasisPoints') && rate === null) problems.push('rate');
  if (form.purpose === 'party' && form.party === null) problems.push('party');
  if (form.ledgerName.trim() === '') problems.push('ledgerName');
  const position = parseNumber(form.position);
  if (position === null || !Number.isInteger(position) || position < 0 || position > 10_000) {
    problems.push('position');
  }
  if (problems.length > 0) return { problems };
  const set = <T>(field: (typeof fields)[number], value: T | '' | null | undefined) =>
    uses(field) && value !== '' && value !== null && value !== undefined ? { [field]: value } : {};
  return {
    request: {
      purpose: form.purpose,
      ...set('rateBasisPoints', rate),
      ...set('nature', form.nature),
      ...set('supplyType', form.supplyType),
      ...set('storeId', form.storeId),
      ...set('modeKind', form.modeKind),
      ...set('modeId', form.modeId),
      ...set('partyId', form.party?.id),
      ledgerName: form.ledgerName.trim(),
      ...(form.group === '' ? {} : { group: form.group }),
      position: Number(position),
    },
  };
}
