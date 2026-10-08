import { ForbiddenException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import {
  GST_STATES,
  canAccessStore,
  type Discount,
  type PriceMode,
  type ShipToRequest,
} from '@paint/shared';
import { and, eq } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import {
  INFLUENCER_ROLES,
  requireSaleParty,
  requireSaleSite,
  type SaleParty,
} from '../billing/sale-parties.js';
import { fieldError } from '../tax/tax-lookups.js';
import { priceSale, type PricedSale, type SaleLineInput } from './sale-pricing.js';

const { salesSettings, stores } = schema;

/** What a quotation or order request names: store, bill-to, influencer, site, ship-to. */
export interface SaleHeaderInput {
  readonly storeId: string;
  readonly billToPartyId: string;
  readonly influencerPartyId?: string | null;
  readonly projectId?: string | null;
  readonly shipTo?: ShipToRequest | null;
  readonly priceMode?: PriceMode | null;
  readonly billDiscount?: Discount | null;
  readonly note?: string | null;
}

/** The header columns a quotation or order stores, checked and priced. */
export interface SaleHeader {
  readonly storeId: string;
  readonly billToPartyId: string;
  readonly influencerPartyId: string | null;
  readonly projectId: string | null;
  readonly shipToName: string | null;
  readonly shipToAddress: string | null;
  readonly shipToStateCode: string | null;
  readonly priceMode: PriceMode;
  readonly note: string | null;
}

/** A GST state code from a state's name as typed on a site ("telangana" → "36"). */
export function stateCodeByName(name: string | null): string | null {
  const wanted = name?.trim().toLowerCase();
  return (
    GST_STATES.find((state) => !state.legacy && state.name.toLowerCase() === wanted)?.code ?? null
  );
}

/**
 * Checks every reference of a quotation or order and resolves its ship-to:
 * the one given, else the site's address (spec §6.4: the site pre-fills the
 * ship-to and so the place of supply).
 */
export async function saleHeader(
  tx: Transaction,
  auth: AuthContext,
  input: SaleHeaderInput,
): Promise<{ header: SaleHeader; billTo: SaleParty }> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, input.storeId), eq(stores.isActive, true)));
  if (!store) throw fieldError('storeId', 'Unknown store');
  if (!canAccessStore(auth, input.storeId)) {
    throw new ForbiddenException('You can sell only at a store you work at');
  }
  const billTo = await requireSaleParty(tx, input.billToPartyId, 'billToPartyId');
  if (input.influencerPartyId) {
    await requireSaleParty(tx, input.influencerPartyId, 'influencerPartyId', INFLUENCER_ROLES);
  }
  const site = input.projectId ? await requireSaleSite(tx, input.projectId) : null;
  const shipTo =
    input.shipTo ??
    (site === null
      ? null
      : { name: site.name, address: site.address, stateCode: stateCodeByName(site.state) });
  const [settings] = await tx
    .select({ priceMode: salesSettings.defaultPriceMode })
    .from(salesSettings);
  return {
    billTo,
    header: {
      storeId: input.storeId,
      billToPartyId: billTo.id,
      influencerPartyId: input.influencerPartyId ?? null,
      projectId: site?.id ?? null,
      shipToName: shipTo?.name ?? null,
      shipToAddress: shipTo?.address ?? null,
      shipToStateCode: shipTo?.stateCode ?? null,
      priceMode: input.priceMode ?? settings?.priceMode ?? 'inclusive',
      note: input.note ?? null,
    },
  };
}

/** The header columns of a stored quotation or order, to price or copy it again. */
export function storedHeader(row: SaleHeader): SaleHeader {
  return {
    storeId: row.storeId,
    billToPartyId: row.billToPartyId,
    influencerPartyId: row.influencerPartyId,
    projectId: row.projectId,
    shipToName: row.shipToName,
    shipToAddress: row.shipToAddress,
    shipToStateCode: row.shipToStateCode,
    priceMode: row.priceMode,
    note: row.note,
  };
}

/** Prices a checked header's lines on `on` (spec §3.3). */
export function priceHeader(
  tx: Transaction,
  header: SaleHeader,
  billTo: SaleParty,
  billDiscount: Discount | null,
  lines: readonly SaleLineInput[],
  on: string,
): Promise<PricedSale> {
  return priceSale(tx, {
    storeId: header.storeId,
    buyerGstin: billTo.gstin,
    deliveryStateCode: header.shipToStateCode ?? billTo.placeOfSupply,
    priceMode: header.priceMode,
    billDiscount,
    lines,
    on,
  });
}

/** The columns a priced header writes (header, then the engine's figures, without lines). */
export function pricedColumns(header: SaleHeader, priced: PricedSale) {
  const { lines, ...figures } = priced;
  return { ...header, ...figures };
}
