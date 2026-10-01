import { schema } from '@paint/db';
import { z } from 'zod';

const threeDecimals = (value: number) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;
const quantity = z
  .number()
  .min(0)
  .max(1_000_000_000)
  .refine(threeDecimals, 'Use at most 3 decimals');
const positiveQuantity = quantity.refine((value) => value > 0, 'Quantity must be more than zero');
/** Cost per unit in paise (₹1 = 100). */
const unitCostPaise = z.number().int().min(0).max(100_000_000_000);
const days = z.number().int().min(0).max(365);
const note = z.string().trim().min(1).max(500);
const isoDate = z.iso.date();

const uniqueVariants = <T extends { variantId: string }>(
  lines: T[],
  context: z.core.$RefinementCtx<T[]>,
) => {
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    if (seen.has(line.variantId)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'variantId'],
        message: 'Each product can appear only once',
      });
    }
    seen.add(line.variantId);
  });
};

const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

// Suppliers ----------------------------------------------------------------

export const listSuppliersSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  ...page,
});
export type ListSuppliersQuery = z.output<typeof listSuppliersSchema>;

export const supplierProfileSchema = z.object({
  paymentTermsDays: days,
  leadTimeDays: days.nullable().default(null),
});
export type SupplierProfileInput = z.output<typeof supplierProfileSchema>;

/** Products the supplier provides; existing links are updated, others added. */
export const supplierProductsSchema = z.object({
  products: z
    .array(
      z.object({
        variantId: z.uuid(),
        supplierSku: z.string().trim().min(1).max(64).nullable().default(null),
      }),
    )
    .min(1)
    .max(500)
    .superRefine(uniqueVariants),
});
export type SupplierProductsInput = z.output<typeof supplierProductsSchema>;

// Purchase orders ------------------------------------------------------------

export const PURCHASE_ORDER_STATUSES = schema.purchaseOrderStatus.enumValues;

export const createPurchaseOrderSchema = z.object({
  supplierId: z.uuid(),
  storeId: z.uuid(),
  expectedDate: isoDate.optional(),
  note: note.optional(),
  lines: z
    .array(
      z.object({
        variantId: z.uuid(),
        quantity: positiveQuantity,
        /** Omit to use the supplier's last cost. */
        unitCostPaise: unitCostPaise.optional(),
      }),
    )
    .min(1)
    .max(500)
    .superRefine(uniqueVariants),
});
export type CreatePurchaseOrderInput = z.output<typeof createPurchaseOrderSchema>;

/** Orders what is low at a store from one supplier, enough to reach each maximum. */
export const fromLowStockSchema = z.object({
  supplierId: z.uuid(),
  storeId: z.uuid(),
  /** Limit to these products; omit for every low product the supplier provides. */
  variantIds: z
    .array(z.uuid())
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'Each product can appear only once')
    .optional(),
  expectedDate: isoDate.optional(),
  note: note.optional(),
});
export type FromLowStockInput = z.output<typeof fromLowStockSchema>;

export const listPurchaseOrdersSchema = z.object({
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  storeId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  ...page,
});
export type ListPurchaseOrdersQuery = z.output<typeof listPurchaseOrdersSchema>;

export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

// Goods receipts -------------------------------------------------------------

/**
 * Goods received at a store: against a purchase order (store and supplier come
 * from it) or directly against the supplier's invoice.
 */
export const createGoodsReceiptSchema = z
  .object({
    purchaseOrderId: z.uuid().optional(),
    storeId: z.uuid().optional(),
    supplierId: z.uuid().optional(),
    supplierInvoiceNumber: z.string().trim().min(1).max(40).optional(),
    supplierInvoiceDate: isoDate.optional(),
    note: note.optional(),
    lines: z
      .array(
        z
          .object({
            variantId: z.uuid(),
            quantity,
            /** Scheme units given free, received at zero cost. */
            freeQuantity: quantity.default(0),
            /** Omit to use the order's cost, or else the supplier's last cost. */
            unitCostPaise: unitCostPaise.optional(),
          })
          .refine((line) => line.quantity + line.freeQuantity > 0, {
            path: ['quantity'],
            message: 'Receive at least some of each product',
          }),
      )
      .min(1)
      .max(500)
      .superRefine(uniqueVariants),
  })
  .superRefine((body, context) => {
    if (body.purchaseOrderId) {
      for (const key of ['storeId', 'supplierId'] as const) {
        if (body[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'Comes from the purchase order; leave it out',
          });
        }
      }
    } else {
      for (const key of ['storeId', 'supplierId'] as const) {
        if (!body[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when not receiving against a purchase order',
          });
        }
      }
      if (!body.supplierInvoiceNumber) {
        context.addIssue({
          code: 'custom',
          path: ['supplierInvoiceNumber'],
          message: "Enter the supplier's invoice number, or receive against a purchase order",
        });
      }
    }
    if (body.supplierInvoiceDate && !body.supplierInvoiceNumber) {
      context.addIssue({
        code: 'custom',
        path: ['supplierInvoiceNumber'],
        message: 'Enter the invoice number along with its date',
      });
    }
  });
export type CreateGoodsReceiptInput = z.output<typeof createGoodsReceiptSchema>;

export const listGoodsReceiptsSchema = z.object({
  storeId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  purchaseOrderId: z.uuid().optional(),
  ...page,
});
export type ListGoodsReceiptsQuery = z.output<typeof listGoodsReceiptsSchema>;
