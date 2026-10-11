import type { SupplyType, TaxNature } from '../gst/types.js';
import type { TallyParty, TallyPaymentMode } from './types.js';

/**
 * Which Tally ledger each amount posts to (spec §6.1, the `ledger_mappings`
 * table of round 3a). Every need has a default name; a business overrides any
 * of them with rules. Bank transfers and "other" modes have no default, since
 * only the business knows its bank, so they must be mapped.
 */
export type TallyLedgerPurpose =
  | 'sales'
  | 'composition_sales'
  | 'output_cgst'
  | 'output_sgst'
  | 'output_igst'
  | 'output_cess'
  | 'round_off'
  | 'party'
  | 'walk_in'
  | 'payment_mode'
  | 'bounce_charges';

/** The Tally group a ledger is created under in the masters file. */
export type TallyGroup =
  | 'Sales Accounts'
  | 'Duties & Taxes'
  | 'Indirect Expenses'
  | 'Indirect Incomes'
  | 'Sundry Debtors'
  | 'Cash-in-Hand'
  | 'Bank Accounts'
  | 'Current Assets';

/** The facts a mapping rule can match on; a need sets only the ones that apply to it. */
export interface TallyLedgerMatch {
  /** The rate in the ledger's own terms: the full rate for sales, the head's rate for tax. */
  readonly rateBasisPoints?: number;
  readonly nature?: TaxNature;
  readonly supplyType?: SupplyType;
  readonly storeCode?: string;
  readonly modeKind?: TallyPaymentMode['kind'];
  readonly modeName?: string;
  readonly partyId?: string;
}

/**
 * One override (a `ledger_mappings` row). It applies to a need of its purpose
 * when every match key it sets equals the need's fact; the rule setting the
 * most keys wins, the earlier rule winning a tie.
 */
export interface TallyLedgerRule extends TallyLedgerMatch {
  readonly purpose: TallyLedgerPurpose;
  readonly ledgerName: string;
  /** The group to create the ledger under, when not the purpose's usual one. */
  readonly group?: TallyGroup;
}

/** The tax head of a duty ledger. */
export type TallyDutyHead = 'CGST' | 'SGST' | 'UTGST' | 'IGST' | 'Cess';

/** A ledger master as the masters file creates it. */
export interface TallyLedger {
  readonly name: string;
  readonly purpose: TallyLedgerPurpose;
  readonly group: TallyGroup;
  /** Party ledgers: keep bills (New Ref / Agst Ref). The walk-in ledger does not. */
  readonly billWise: boolean;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  /** Duty ledgers: the tax head and its own rate (9% CGST is 900). */
  readonly duty: { readonly head: TallyDutyHead; readonly rateBasisPoints: number } | null;
}

/** Something a voucher needs a ledger for. */
export interface TallyLedgerNeed {
  readonly purpose: TallyLedgerPurpose;
  readonly match: TallyLedgerMatch;
  /** The name used when no rule matches; null when it must be mapped. */
  readonly defaultName: string | null;
  /** Says what the ledger is for, in an error message. */
  readonly description: string;
  /** The master to create, given the resolved name. */
  readonly master: Omit<TallyLedger, 'name'>;
  /** Two needs may share a ledger only if their keys are equal (one party per ledger). */
  readonly identity: string;
}

const MATCH_KEYS = [
  'rateBasisPoints',
  'nature',
  'supplyType',
  'storeCode',
  'modeKind',
  'modeName',
  'partyId',
] as const satisfies readonly (keyof TallyLedgerMatch)[];

/**
 * 1800 → "18", 250 → "2.5", 12.5 (a CGST half of 0.25%) → "0.125". A label
 * only: dividing a whole or half basis point by 100 prints exactly in JS.
 */
export function percentLabel(basisPoints: number): string {
  return String(basisPoints / 100);
}

const NATURE_LABEL: Record<TaxNature, string> = {
  taxable: 'GST',
  exempt: 'Exempt',
  nil_rated: 'Nil Rated',
  non_gst: 'Non-GST',
};

const SUPPLY_LABEL: Record<SupplyType, string> = {
  intra_state: 'Local',
  inter_state: 'Interstate',
};

const MODE_DEFAULTS: Record<TallyPaymentMode['kind'], { name: string | null; group: TallyGroup }> =
  {
    cash: { name: 'Cash', group: 'Cash-in-Hand' },
    upi: { name: 'UPI Clearing', group: 'Current Assets' },
    card: { name: 'Card Clearing', group: 'Current Assets' },
    cheque: { name: 'Cheques in Hand', group: 'Current Assets' },
    bank_transfer: { name: null, group: 'Bank Accounts' },
    other: { name: null, group: 'Current Assets' },
  };

const plain = (purpose: TallyLedgerPurpose, group: TallyGroup): Omit<TallyLedger, 'name'> => ({
  purpose,
  group,
  billWise: false,
  gstin: null,
  stateCode: null,
  duty: null,
});

/** The sales ledger for one rate, nature and supply type: `Sales GST 18% Local`. */
export function salesNeed(
  nature: TaxNature,
  rateBasisPoints: number,
  supplyType: SupplyType,
  storeCode: string,
): TallyLedgerNeed {
  const label =
    nature === 'taxable' ? `GST ${percentLabel(rateBasisPoints)}%` : NATURE_LABEL[nature];
  const name = `Sales ${label} ${SUPPLY_LABEL[supplyType]}`;
  return {
    purpose: 'sales',
    match: { nature, rateBasisPoints, supplyType, storeCode },
    defaultName: name,
    description: `sales at ${label} (${SUPPLY_LABEL[supplyType].toLowerCase()})`,
    master: plain('sales', 'Sales Accounts'),
    identity: 'sales',
  };
}

/** A composition dealer's bill of supply posts to one sales ledger. */
export function compositionSalesNeed(storeCode: string): TallyLedgerNeed {
  return {
    purpose: 'composition_sales',
    match: { storeCode },
    defaultName: 'Sales - Composition',
    description: 'composition sales (bills of supply)',
    master: plain('composition_sales', 'Sales Accounts'),
    identity: 'sales',
  };
}

const DUTY: Record<TallyDutyHead, TallyLedgerPurpose> = {
  CGST: 'output_cgst',
  SGST: 'output_sgst',
  UTGST: 'output_sgst',
  IGST: 'output_igst',
  Cess: 'output_cess',
};

/** An output tax ledger for one head at the head's own rate: `Output CGST 9%`. */
export function taxNeed(
  head: TallyDutyHead,
  rateBasisPoints: number,
  storeCode: string,
): TallyLedgerNeed {
  const name = `Output ${head} ${percentLabel(rateBasisPoints)}%`;
  return {
    purpose: DUTY[head],
    match: { rateBasisPoints, storeCode },
    defaultName: name,
    description: `output ${head} at ${percentLabel(rateBasisPoints)}%`,
    master: {
      ...plain(DUTY[head], 'Duties & Taxes'),
      duty: { head, rateBasisPoints },
    },
    identity: `duty|${head}|${String(rateBasisPoints)}`,
  };
}

export function roundOffNeed(storeCode: string): TallyLedgerNeed {
  return {
    purpose: 'round_off',
    match: { storeCode },
    defaultName: 'Round Off',
    description: 'round-off',
    master: plain('round_off', 'Indirect Expenses'),
    identity: 'round_off',
  };
}

/**
 * The buyer's ledger: the walk-in party posts to "Cash Sales" (no bills kept);
 * anyone else to a bill-wise Sundry Debtors ledger named after them, carrying
 * their GSTIN and state.
 */
export function partyNeed(party: TallyParty, storeCode: string): TallyLedgerNeed {
  if (party.walkIn) {
    return {
      purpose: 'walk_in',
      match: { storeCode },
      defaultName: 'Cash Sales',
      description: 'walk-in sales',
      master: plain('walk_in', 'Sundry Debtors'),
      identity: 'walk_in',
    };
  }
  return {
    purpose: 'party',
    match: { partyId: party.id, storeCode },
    defaultName: party.name.trim(),
    description: `party "${party.name}"`,
    master: {
      ...plain('party', 'Sundry Debtors'),
      billWise: true,
      gstin: party.gstin,
      stateCode: party.stateCode,
    },
    identity: `party|${party.id}`,
  };
}

/** The ledger money lands in for a payment mode. */
export function paymentModeNeed(mode: TallyPaymentMode, storeCode: string): TallyLedgerNeed {
  const fallback = MODE_DEFAULTS[mode.kind];
  return {
    purpose: 'payment_mode',
    match: { modeKind: mode.kind, modeName: mode.name, storeCode },
    defaultName: fallback.name,
    description: `payment mode "${mode.name}" (${mode.kind})`,
    master: plain('payment_mode', fallback.group),
    identity: 'payment_mode',
  };
}

/**
 * What a party pays for a bounced cheque (spec §4.6, a non-GST recovery
 * pending [CA-11]): income, under Indirect Incomes.
 */
export function bounceChargesNeed(storeCode: string): TallyLedgerNeed {
  return {
    purpose: 'bounce_charges',
    match: { storeCode },
    defaultName: 'Cheque Bounce Charges',
    description: 'cheque bounce charges',
    master: plain('bounce_charges', 'Indirect Incomes'),
    identity: 'bounce_charges',
  };
}

const specificity = (rule: TallyLedgerRule) =>
  MATCH_KEYS.filter((key) => rule[key] !== undefined).length;

/**
 * The ledger for a need: the most specific matching rule's name and group, else
 * the default name (null when there is none) under the purpose's usual group.
 */
export function resolveLedger(
  need: TallyLedgerNeed,
  rules: readonly TallyLedgerRule[],
): { readonly name: string | null; readonly group: TallyGroup } {
  let best: TallyLedgerRule | null = null;
  for (const rule of rules) {
    if (rule.purpose !== need.purpose) continue;
    if (!MATCH_KEYS.every((key) => rule[key] === undefined || rule[key] === need.match[key])) {
      continue;
    }
    if (best === null || specificity(rule) > specificity(best)) best = rule;
  }
  if (best === null) return { name: need.defaultName, group: need.master.group };
  return { name: best.ledgerName, group: best.group ?? need.master.group };
}
