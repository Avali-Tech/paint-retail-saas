import { isValidGstin } from '../tax-ids.js';
import { GstError } from './errors.js';

/**
 * How the state half of an intra-state supply is named. States and the UTs
 * with a legislature (Delhi, Puducherry, Jammu and Kashmir) levy SGST; the
 * other UTs levy UTGST at the same rate.
 */
export type StateKind = 'state' | 'ut_with_legislature' | 'ut';

export interface GstState {
  /** Two-digit GST state code, the first two characters of a GSTIN. */
  readonly code: string;
  readonly name: string;
  readonly kind: StateKind;
  /** A code no longer issued (merged or split states); kept to read old GSTINs and invoices. */
  readonly legacy: boolean;
}

const state = (
  code: string,
  name: string,
  kind: StateKind = 'state',
  legacy = false,
): GstState => ({
  code,
  name,
  kind,
  legacy,
});

/** GST state and UT codes 01–38 and 97, as used in GSTINs and the place of supply. */
export const GST_STATES: readonly GstState[] = [
  state('01', 'Jammu and Kashmir', 'ut_with_legislature'),
  state('02', 'Himachal Pradesh'),
  state('03', 'Punjab'),
  state('04', 'Chandigarh', 'ut'),
  state('05', 'Uttarakhand'),
  state('06', 'Haryana'),
  state('07', 'Delhi', 'ut_with_legislature'),
  state('08', 'Rajasthan'),
  state('09', 'Uttar Pradesh'),
  state('10', 'Bihar'),
  state('11', 'Sikkim'),
  state('12', 'Arunachal Pradesh'),
  state('13', 'Nagaland'),
  state('14', 'Manipur'),
  state('15', 'Mizoram'),
  state('16', 'Tripura'),
  state('17', 'Meghalaya'),
  state('18', 'Assam'),
  state('19', 'West Bengal'),
  state('20', 'Jharkhand'),
  state('21', 'Odisha'),
  state('22', 'Chhattisgarh'),
  state('23', 'Madhya Pradesh'),
  state('24', 'Gujarat'),
  state('25', 'Daman and Diu', 'ut', true),
  state('26', 'Dadra and Nagar Haveli and Daman and Diu', 'ut'),
  state('27', 'Maharashtra'),
  state('28', 'Andhra Pradesh (before division)', 'state', true),
  state('29', 'Karnataka'),
  state('30', 'Goa'),
  state('31', 'Lakshadweep', 'ut'),
  state('32', 'Kerala'),
  state('33', 'Tamil Nadu'),
  state('34', 'Puducherry', 'ut_with_legislature'),
  state('35', 'Andaman and Nicobar Islands', 'ut'),
  state('36', 'Telangana'),
  state('37', 'Andhra Pradesh'),
  state('38', 'Ladakh', 'ut'),
  state('97', 'Other Territory', 'ut'),
];

const BY_CODE = new Map(GST_STATES.map((entry) => [entry.code, entry]));

/** The state or UT for a two-digit code; throws for an unknown code. */
export function gstState(code: string): GstState {
  const found = BY_CODE.get(code);
  if (!found) throw new GstError('invalid_state_code', `Unknown GST state code "${code}"`);
  return found;
}

export function isGstStateCode(code: string): boolean {
  return BY_CODE.has(code);
}

/** The state code of a valid GSTIN (its first two digits); throws for an invalid GSTIN. */
export function stateCodeFromGstin(gstin: string): string {
  if (!isValidGstin(gstin)) throw new GstError('invalid_gstin', `Invalid GSTIN "${gstin}"`);
  return gstState(gstin.slice(0, 2)).code;
}

/** "SGST" or "UTGST": the label for the state half of an intra-state supply. */
export function stateTaxLabel(code: string): 'SGST' | 'UTGST' {
  return gstState(code).kind === 'ut' ? 'UTGST' : 'SGST';
}
