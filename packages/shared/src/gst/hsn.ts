import { isValidHsn } from '../catalog.js';
import { checkPaise } from './arith.js';
import type { BuyerType } from './types.js';

/**
 * How many HSN digits an invoice must show, by the seller's aggregate annual
 * turnover (AATO) in the previous financial year. 0 means the code is optional.
 */
export interface HsnDigitBand {
  /** The band covers turnover up to and including this; null for the top band. */
  readonly upToTurnoverPaise: number | null;
  readonly b2bDigits: 0 | 4 | 6 | 8;
  readonly b2cDigits: 0 | 4 | 6 | 8;
}

/**
 * Notification 78/2020-Central Tax, from 1 April 2021: AATO up to ₹5 crore, 4
 * digits on B2B invoices and optional on B2C; above ₹5 crore, 6 digits on all
 * invoices. Pass your own bands when the law changes.
 */
export const DEFAULT_HSN_DIGIT_BANDS: readonly HsnDigitBand[] = [
  { upToTurnoverPaise: 5_00_00_000_00, b2bDigits: 4, b2cDigits: 0 },
  { upToTurnoverPaise: null, b2bDigits: 6, b2cDigits: 6 },
];

/** The HSN digits required on an invoice for this turnover and kind of buyer. */
export function requiredHsnDigits(
  turnoverPaise: number,
  buyerType: BuyerType,
  bands: readonly HsnDigitBand[] = DEFAULT_HSN_DIGIT_BANDS,
): number {
  const turnover = checkPaise(turnoverPaise, 'Turnover');
  const band = bands.find(
    ({ upToTurnoverPaise }) => upToTurnoverPaise === null || turnover <= BigInt(upToTurnoverPaise),
  );
  if (!band) throw new RangeError('HSN digit bands must end with an open top band');
  return buyerType === 'b2b' ? band.b2bDigits : band.b2cDigits;
}

/**
 * True when `hsn` satisfies a requirement of `digits`: a valid 4, 6 or 8-digit
 * code at least that long, or anything (even empty) when the code is optional.
 */
export function hsnMeetsRequirement(hsn: string, digits: number): boolean {
  if (digits === 0) return hsn === '' || isValidHsn(hsn);
  return isValidHsn(hsn) && hsn.length >= digits;
}
