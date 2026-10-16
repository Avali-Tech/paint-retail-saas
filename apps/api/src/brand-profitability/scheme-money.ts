import type { Transaction } from '@paint/db';
import type { BrandSchemeMoney } from '@paint/shared';
import { schemeMoneyByBrand } from '../brand-schemes/scheme-money.js';

/**
 * Each brand's scheme money for a period (P2-M33, spec §6.3): received, and still
 * expected (not below 0). Brand profitability adds it to the contribution, spread
 * over the brand's slices by the margin engine ([PO-35]).
 */
export interface SchemeMoneySource {
  /** False until the schemes module answers: the screen then says schemes are not counted. */
  readonly counted: boolean;
  byBrand(
    tx: Transaction,
    organizationId: string,
    from: string,
    to: string,
  ): Promise<BrandSchemeMoney[]>;
}

/** No scheme money: for a business view without schemes (and tests). */
export const NO_SCHEME_MONEY: SchemeMoneySource = {
  counted: false,
  byBrand: () => Promise.resolve([]),
};

/**
 * Where brand profitability reads scheme money from: the schemes module (round 5a),
 * active and closed schemes overlapping the period, each in proportion to its days
 * inside it, as they stand today.
 */
export const schemeMoney: SchemeMoneySource = { counted: true, byBrand: schemeMoneyByBrand };
