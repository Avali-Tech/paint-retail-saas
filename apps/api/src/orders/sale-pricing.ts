import type { LineTintInput } from '../paint/paint.schemas.js';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import {
  DEFAULT_GST_OPTIONS,
  computeInvoice,
  variantName,
  type Discount,
  type GstError,
  type Invoice,
  type PriceMode,
} from '@paint/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { gstRatesFor } from '../billing/gst-rates.js';
import { fieldError } from '../tax/tax-lookups.js';

const { productVariants, products, stores } = schema;

/** A line to price: the variant's selling price unless one is given. */
export interface SaleLineInput {
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPricePaise?: number | null;
  readonly discount?: Discount | null;
  /** Written with the line after pricing (round 5a). */
  readonly tint?: LineTintInput;
}

export interface SalePricingInput {
  readonly storeId: string;
  /** The bill-to party's GSTIN: B2B when set. */
  readonly buyerGstin: string | null;
  /** Ship-to state, else the party's place of supply (spec §2.5). */
  readonly deliveryStateCode: string | null;
  readonly priceMode: PriceMode;
  readonly billDiscount: Discount | null;
  readonly lines: readonly SaleLineInput[];
  /** The India date whose rates apply. */
  readonly on: string;
}

/** A line as stored on a quotation or order: the engine's figures plus the product snapshot. */
export interface PricedSaleLine {
  readonly lineNo: number;
  readonly variantId: string;
  readonly description: string;
  readonly hsnCode: string;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly discountBps: number | null;
  readonly discountPaise: number | null;
  readonly taxCategoryId: string;
  readonly rateBps: number | null;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly totalPaise: number;
}

/** The header figures of a priced quotation or order. */
export interface PricedSale {
  readonly pricedOn: string;
  readonly placeOfSupplyCode: string;
  readonly supplyType: 'intra_state' | 'inter_state';
  readonly billDiscountBps: number | null;
  readonly billDiscountPaise: number | null;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly roundOffPaise: number;
  readonly totalPaise: number;
  readonly lines: readonly PricedSaleLine[];
}

const percentOf = (discount: Discount | null | undefined) =>
  discount?.kind === 'percent' ? discount.basisPoints : null;
const amountOf = (discount: Discount | null | undefined) =>
  discount?.kind === 'amount' ? discount.paise : null;

/** A discount stored as basis points or paise, back as the engine's discount. */
export function discountOf(bps: number | null, paise: number | null): Discount | null {
  if (bps !== null) return { kind: 'percent', basisPoints: bps };
  return paise === null ? null : { kind: 'amount', paise };
}

/**
 * Prices a quotation or order with the GST engine (spec §3.3: "totals use the
 * engine at the quote date"), the way an invoice from the same store would be
 * taxed: a composition store's sale is untaxed. The store must be registered.
 */
export async function priceSale(tx: Transaction, input: SalePricingInput): Promise<PricedSale> {
  const [store] = await tx
    .select({
      registrationType: stores.registrationType,
      stateCode: sql<string>`${stores.stateCode}`,
    })
    .from(stores)
    .where(and(eq(stores.id, input.storeId), sql`${stores.registrationType} <> 'unregistered'`));
  if (!store) {
    throw new ConflictException(
      'Register this store for GST (Settings, Tax & GST) before quoting or taking orders',
    );
  }
  const variantIds = [...new Set(input.lines.map((line) => line.variantId))];
  const variants = await tx
    .select({
      id: productVariants.id,
      price: productVariants.sellingPricePaise,
      productName: products.name,
      packSize: productVariants.packSize,
      unit: sql<string>`${productVariants.unit}::text`,
      label: productVariants.label,
      hsnCode: products.hsnCode,
      taxCategoryId: products.taxCategoryId,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(inArray(productVariants.id, variantIds), eq(productVariants.isActive, true)));
  const resolved = input.lines.map((line, index) => {
    const at = `lines.${String(index)}`;
    const variant = variants.find((candidate) => candidate.id === line.variantId);
    if (!variant) throw fieldError(`${at}.variantId`, 'Unknown product');
    const unitPricePaise = line.unitPricePaise ?? variant.price;
    if (unitPricePaise === null) {
      throw fieldError(`${at}.unitPricePaise`, 'This product has no price; enter one');
    }
    if (variant.taxCategoryId === null) {
      throw fieldError(`${at}.variantId`, 'Give this product a tax category before selling it');
    }
    return { line, variant, unitPricePaise, taxCategoryId: variant.taxCategoryId };
  });

  let invoice: Invoice;
  try {
    invoice = computeInvoice({
      invoiceDate: input.on,
      registration: store.registrationType === 'composition' ? 'composition' : 'regular',
      parties: {
        supplierStateCode: store.stateCode,
        buyerGstin: input.buyerGstin,
        deliveryStateCode: input.deliveryStateCode,
        storeStateCode: store.stateCode,
      },
      pricesIncludeTax: input.priceMode === 'inclusive',
      lines: resolved.map((item) => ({
        categoryCode: item.taxCategoryId,
        quantity: item.line.quantity,
        unitPricePaise: item.unitPricePaise,
        discount: item.line.discount ?? null,
      })),
      invoiceDiscount: input.billDiscount,
      rates: await gstRatesFor(tx, [...new Set(resolved.map((item) => item.taxCategoryId))]),
      options: DEFAULT_GST_OPTIONS,
    });
  } catch (error) {
    // The engine refuses bad input only with a GstError, whose code names the rule.
    const refusal = error as GstError;
    throw new UnprocessableEntityException({
      statusCode: 422,
      message: refusal.message,
      code: refusal.code,
    });
  }

  const { totals } = invoice;
  return {
    pricedOn: input.on,
    placeOfSupplyCode: invoice.placeOfSupply,
    supplyType: invoice.supplyType,
    billDiscountBps: percentOf(input.billDiscount),
    billDiscountPaise: amountOf(input.billDiscount),
    taxablePaise: totals.taxablePaise,
    cgstPaise: totals.cgstPaise,
    sgstPaise: totals.sgstPaise,
    igstPaise: totals.igstPaise,
    cessPaise: totals.cessPaise,
    roundOffPaise: totals.roundOffPaise,
    totalPaise: totals.payablePaise,
    lines: invoice.lines.map((computed, index) => {
      // The engine returns one line per input, in order.
      const [{ line, variant, unitPricePaise, taxCategoryId }] = resolved.slice(
        index,
        index + 1,
      ) as [(typeof resolved)[number]];
      return {
        lineNo: index + 1,
        variantId: line.variantId,
        description: `${variant.productName} ${variantName(variant)}`,
        hsnCode: variant.hsnCode,
        quantity: line.quantity,
        unitPricePaise,
        discountBps: percentOf(line.discount),
        discountPaise: amountOf(line.discount),
        taxCategoryId,
        rateBps: computed.rate?.rateBasisPoints ?? null,
        taxablePaise: computed.taxablePaise,
        cgstPaise: computed.cgstPaise,
        sgstPaise: computed.sgstPaise,
        igstPaise: computed.igstPaise,
        cessPaise: computed.cessPaise,
        totalPaise: computed.totalPaise,
      };
    }),
  };
}
