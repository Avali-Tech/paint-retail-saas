import type { Transaction } from '@paint/db';
import type { BrandSchemeMoney } from '@paint/shared';

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

/**
 * No scheme money yet. TODO(P2-M33): replace with the schemes module's
 * `schemeMoneyByBrand` (round 5a) once it lands.
 */
export const NO_SCHEME_MONEY: SchemeMoneySource = {
  counted: false,
  byBrand: () => Promise.resolve([]),
};

/** Where brand profitability reads scheme money from. */
export const schemeMoney: SchemeMoneySource = NO_SCHEME_MONEY;
