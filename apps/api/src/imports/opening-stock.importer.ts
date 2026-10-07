import { postStockMovements, schema } from '@paint/db';
import { VARIANT_LABEL_MAX_LENGTH, canAccessStore, variantName } from '@paint/shared';
import { and, count, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { decimal, optional, required, rupees, text } from './import-cells.js';
import { FirstSeen, unique, type Importer, type RowPlan } from './import-types.js';

const { productVariants, stockLedger, stores } = schema;

const threeDecimals = (value: number) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;

const row = z.object({
  store: required(z.string().toUpperCase()),
  sku: required(z.string().toUpperCase()),
  variant_label: optional(text(1, VARIANT_LABEL_MAX_LENGTH)),
  quantity: required(
    decimal.pipe(
      z
        .number()
        .positive('Must be more than zero')
        .max(1_000_000_000)
        .refine(threeDecimals, 'Use at most 3 decimals'),
    ),
  ),
  unit_cost: optional(rupees),
});
type StockRow = z.output<typeof row>;

const REFERENCE_TYPE = 'import';

export const openingStockImporter: Importer<StockRow> = {
  kind: 'opening-stock',
  title: 'Opening stock per store',
  permission: 'inventory:manage',
  columns: [
    { name: 'store', required: true, description: 'Store code', example: 'HYD' },
    {
      name: 'sku',
      required: true,
      description: 'Product SKU, as in your product list',
      example: 'APX-ULT-1L',
    },
    {
      name: 'variant_label',
      required: false,
      description: 'The pack’s label, such as 2 inch or Grit 120; checked against the SKU',
      example: '',
    },
    { name: 'quantity', required: true, description: 'Quantity on hand today', example: '24' },
    {
      name: 'unit_cost',
      required: false,
      description: 'Cost per unit in rupees, for stock value and margins',
      example: '520.00',
    },
  ],
  row,

  async plan(tx, auth, rows, fail) {
    const pairs = new FirstSeen<string>();
    const checked = rows.filter(({ row: rowNumber, value }) => {
      const first = pairs.check(`${value.store}|${value.sku}`, rowNumber);
      if (first) fail(rowNumber, 'sku', `Also on row ${String(first)} for this store`);
      return !first;
    });
    const values = checked.map((parsed) => parsed.value);
    const storesByCode = new Map(
      (
        await tx
          .select({ id: stores.id, code: stores.code, isActive: stores.isActive })
          .from(stores)
          .where(inArray(stores.code, unique(values.map((v) => v.store))))
      ).map((store) => [store.code, store]),
    );
    const variantsBySku = new Map(
      (
        await tx
          .select({
            id: productVariants.id,
            sku: productVariants.sku,
            packSize: productVariants.packSize,
            unit: productVariants.unit,
            label: productVariants.label,
          })
          .from(productVariants)
          .where(inArray(productVariants.sku, unique(values.map((v) => v.sku))))
      ).map((variant) => [variant.sku, variant]),
    );
    // What each store already holds, and whether it came only from an earlier import.
    const history = new Map(
      (
        await tx
          .select({
            storeId: stockLedger.storeId,
            variantId: stockLedger.variantId,
            entries: count(),
            imported: sql<number>`count(*) filter (where ${stockLedger.movementType} = 'opening' and ${stockLedger.referenceType} = ${REFERENCE_TYPE})::int`,
            quantity: sql<string>`sum(${stockLedger.quantity})`,
          })
          .from(stockLedger)
          .where(
            and(
              inArray(
                stockLedger.storeId,
                [...storesByCode.values()].map((store) => store.id),
              ),
              inArray(
                stockLedger.variantId,
                [...variantsBySku.values()].map((variant) => variant.id),
              ),
            ),
          )
          .groupBy(stockLedger.storeId, stockLedger.variantId)
      ).map((entry) => [`${entry.storeId}|${entry.variantId}`, entry]),
    );

    const planned: (RowPlan & { storeId: string; variantId: string; value: StockRow })[] = [];
    for (const { row: rowNumber, value } of checked) {
      const store = storesByCode.get(value.store);
      const variant = variantsBySku.get(value.sku);
      if (!store?.isActive || !canAccessStore(auth, store.id)) {
        fail(rowNumber, 'store', 'Unknown store code, or a store you cannot access');
        continue;
      }
      if (!variant) {
        fail(rowNumber, 'sku', 'Unknown SKU; import products first');
        continue;
      }
      // A label guards against a mistyped SKU among look-alike packs (2 inch and 3 inch brushes).
      if (
        value.variant_label !== undefined &&
        value.variant_label.toLowerCase() !== variant.label?.toLowerCase()
      ) {
        fail(rowNumber, 'variant_label', `Does not match ${value.sku} (${variantName(variant)})`);
        continue;
      }
      const variantId = variant.id;
      const label = `${value.store} · ${value.sku} · ${variantName(variant)}`;
      const before = history.get(`${store.id}|${variantId}`);
      if (!before) {
        planned.push({
          row: rowNumber,
          action: 'create',
          label,
          storeId: store.id,
          variantId,
          value,
        });
      } else if (before.imported === before.entries && Number(before.quantity) === value.quantity) {
        planned.push({
          row: rowNumber,
          action: 'unchanged',
          label,
          storeId: store.id,
          variantId,
          value,
        });
      } else {
        fail(
          rowNumber,
          'quantity',
          `${value.store} already has stock movements for ${value.sku} (${String(Number(before.quantity))} on the books); correct it with a stock count`,
        );
      }
    }

    return {
      rows: planned.map(({ row: rowNumber, action, label }) => ({ row: rowNumber, action, label })),
      apply: (applyTx) =>
        postStockMovements(
          applyTx,
          planned
            .filter((entry) => entry.action === 'create')
            .map(({ storeId, variantId, value }) => ({
              organizationId: auth.organization.id,
              storeId,
              variantId,
              movementType: 'opening' as const,
              quantity: value.quantity,
              unitCostPaise: value.unit_cost ?? null,
              referenceType: REFERENCE_TYPE,
              note: 'Opening stock import',
              createdByMemberId: auth.memberId,
            })),
        ),
    };
  },
};
