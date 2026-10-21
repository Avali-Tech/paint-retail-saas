import { schema, type Transaction } from '@paint/db';
import type { Discount } from '@paint/shared';
import { inArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { fieldError } from '../tax/tax-lookups.js';

const { productVariants } = schema;

/** What a bill, quotation or order asks for, as far as prices go. */
export interface PriceRequest {
  readonly billDiscount?: Discount | null | undefined;
  readonly lines: readonly {
    readonly variantId: string;
    readonly unitPricePaise?: number | undefined;
    readonly discount?: Discount | null | undefined;
  }[];
}

const gives = (discount: Discount | null | undefined) =>
  discount !== null &&
  discount !== undefined &&
  (discount.kind === 'percent' ? discount.basisPoints : discount.paise) > 0;

/**
 * Discounts and prices other than the catalogue's need billing:discount. Checked
 * where a person enters them (saving a draft bill, quotation or order), not when
 * a quotation becomes an order or an order is billed, so someone without it can
 * still carry on a sale priced by someone with it. A product with no catalogue
 * price takes the price typed in.
 */
export async function assertMayDiscount(
  tx: Transaction,
  auth: AuthContext,
  request: PriceRequest,
): Promise<void> {
  if (auth.permissions.has('billing:discount')) return;
  if (gives(request.billDiscount)) {
    throw fieldError('billDiscount', 'You cannot give discounts');
  }
  const discounted = request.lines.findIndex((line) => gives(line.discount));
  if (discounted !== -1) {
    throw fieldError(`lines.${String(discounted)}.discount`, 'You cannot give discounts');
  }
  const priced = request.lines.filter((line) => line.unitPricePaise !== undefined);
  if (priced.length === 0) return;
  const catalogue = await tx
    .select({ id: productVariants.id, price: productVariants.sellingPricePaise })
    .from(productVariants)
    .where(
      inArray(
        productVariants.id,
        priced.map((line) => line.variantId),
      ),
    );
  const changed = request.lines.findIndex((line) => {
    const price = catalogue.find((variant) => variant.id === line.variantId)?.price;
    // An unknown product is refused by the save itself.
    return (
      line.unitPricePaise !== undefined &&
      price !== undefined &&
      price !== null &&
      price !== line.unitPricePaise
    );
  });
  if (changed !== -1) {
    throw fieldError(`lines.${String(changed)}.unitPricePaise`, 'You cannot change the price');
  }
}
