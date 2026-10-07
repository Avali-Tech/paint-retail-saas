import { gstState, stateCodeFromGstin } from './states.js';
import type { BuyerType, SupplyType } from './types.js';

export interface Parties {
  /** The selling GSTIN's state code. */
  readonly supplierStateCode: string;
  /** The buyer's GSTIN for a B2B sale; null for a B2C sale (walk-in or unregistered). */
  readonly buyerGstin: string | null;
  /** B2C only: the state goods are delivered to, or null when taken away at the counter. */
  readonly deliveryStateCode: string | null;
  /** B2C only: the selling store's state, the place of supply for a counter sale. */
  readonly storeStateCode: string;
}

export interface PlaceOfSupply {
  readonly buyerType: BuyerType;
  readonly placeOfSupply: string;
  readonly supplyType: SupplyType;
}

/**
 * Where the supply is made, and so which taxes apply (IGST Act s.10): for B2B,
 * the buyer's GSTIN state (even when shipped elsewhere on the buyer's
 * instruction); for B2C, the delivery state, or the store's state for a counter
 * sale. Same state as the supplier: CGST + SGST; otherwise IGST.
 */
export function placeOfSupply(parties: Parties): PlaceOfSupply {
  const supplier = parties.supplierStateCode;
  if (parties.buyerGstin !== null) {
    const place = stateCodeFromGstin(parties.buyerGstin);
    return { buyerType: 'b2b', placeOfSupply: place, supplyType: supplyTypeFor(supplier, place) };
  }
  const place = gstState(parties.deliveryStateCode ?? parties.storeStateCode).code;
  return { buyerType: 'b2c', placeOfSupply: place, supplyType: supplyTypeFor(supplier, place) };
}

/** Intra-state when the supplier's state and the place of supply are the same. */
export function supplyTypeFor(supplierStateCode: string, placeOfSupplyCode: string): SupplyType {
  const same = gstState(supplierStateCode).code === gstState(placeOfSupplyCode).code;
  return same ? 'intra_state' : 'inter_state';
}
