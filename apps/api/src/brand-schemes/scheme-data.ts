import { schema, type Transaction } from '@paint/db';
import {
  lineCounts,
  productTitle,
  schemeClaim,
  schemeProgress,
  variantTitle,
  type BenefitReceiptView,
  type BrandScheme,
  type ReceivedBenefit,
  type SchemeBenefitView,
  type SchemeClaim,
  type SchemeDateBasis,
  type SchemeGrnLine,
  type SchemeGrnLineView,
  type SchemeProgress,
  type SchemeView,
  type SlabBenefit,
} from '@paint/shared';
import { and, asc, desc, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/**
 * Loading brand schemes for the engines (P2-M33, spec §6.3): a scheme with what it
 * covers, its slabs and benefits; the brand's GRN lines (and purchase returns) in its
 * period; and what the brand issued against it. The engines in @paint/shared compute
 * progress, expected benefits and claims from these.
 */

const {
  brandBenefitReceipts,
  brandClaims,
  brandSchemeBenefits,
  brandSchemeItems,
  brandSchemeSlabs,
  brandSchemes,
  brands,
  categories,
  goodsReceiptLines,
  goodsReceipts,
  organizationMembers,
  parties,
  productVariants,
  products,
  stockLedger,
  stores,
  users,
} = schema;

/** A scheme as the screens show it and as the engines compute it. */
export interface SchemeRecord {
  readonly view: SchemeView;
  readonly engine: BrandScheme;
}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

/** Millilitres in `quantity` packs of a variant (0 for kg, pieces and the like). */
const millilitres = (quantity: AnyColumn | SQL) =>
  sql<string>`round(${quantity} * ${productVariants.packSize} * case ${productVariants.unit}
    when 'l' then 1000 when 'ml' then 1 else 0 end)`;

const indiaDay = (moment: AnyColumn | SQL) =>
  sql<string>`((${moment} at time zone 'Asia/Kolkata')::date)::text`;

/** Items by key, each list in the items' order: none for a key no item has. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): (of: string) => readonly T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list === undefined) groups.set(key(item), [item]);
    else list.push(item);
  }
  return (of) => groups.get(of) ?? [];
}

/** Schemes matching `where` (in the tenant's transaction), newest period first. */
export async function loadSchemes(tx: Transaction, where?: SQL): Promise<SchemeRecord[]> {
  const rows = await tx
    .select({ scheme: brandSchemes, brandName: brands.name })
    .from(brandSchemes)
    .innerJoin(brands, eq(brands.id, brandSchemes.brandId))
    .where(where)
    .orderBy(desc(brandSchemes.startsOn), asc(brands.name), asc(brandSchemes.name));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.scheme.id);

  const itemBrands = alias(brands, 'item_brands');
  const items = await tx
    .select({
      schemeId: brandSchemeItems.schemeId,
      productId: brandSchemeItems.productId,
      productName: products.name,
      productBrand: itemBrands.name,
      categoryId: brandSchemeItems.categoryId,
      categoryName: categories.name,
    })
    .from(brandSchemeItems)
    .leftJoin(products, eq(products.id, brandSchemeItems.productId))
    .leftJoin(itemBrands, eq(itemBrands.id, products.brandId))
    .leftJoin(categories, eq(categories.id, brandSchemeItems.categoryId))
    .where(inArray(brandSchemeItems.schemeId, ids))
    .orderBy(asc(products.name), asc(categories.name));
  const slabs = await tx
    .select()
    .from(brandSchemeSlabs)
    .where(inArray(brandSchemeSlabs.schemeId, ids))
    .orderBy(asc(brandSchemeSlabs.position));
  const benefitBrands = alias(brands, 'benefit_brands');
  const benefits = await tx
    .select({
      benefit: brandSchemeBenefits,
      productName: products.name,
      brandName: benefitBrands.name,
      packSize: productVariants.packSize,
      unit: productVariants.unit,
      label: productVariants.label,
    })
    .from(brandSchemeBenefits)
    .leftJoin(productVariants, eq(productVariants.id, brandSchemeBenefits.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(benefitBrands, eq(benefitBrands.id, products.brandId))
    .where(inArray(brandSchemeBenefits.schemeId, ids))
    .orderBy(asc(brandSchemeBenefits.position));

  const itemsOf = groupBy(items, (item) => item.schemeId);
  const slabsOf = groupBy(slabs, (slab) => slab.schemeId);
  const benefitsOf = groupBy(benefits, (row) => row.benefit.slabId);
  return rows.map(({ scheme, brandName }) => {
    const own = itemsOf(scheme.id);
    const ownSlabs = slabsOf(scheme.id).map((slab) => {
      const ownBenefits = benefitsOf(slab.id).map((row) => benefitView(row));
      return { id: slab.id, position: slab.position, target: slab.target, benefits: ownBenefits };
    });
    const productIds = own.flatMap((item) => (item.productId ? [item.productId] : []));
    const categoryIds = own.flatMap((item) => (item.categoryId ? [item.categoryId] : []));
    const view: SchemeView = {
      id: scheme.id,
      brand: { id: scheme.brandId, name: brandName },
      name: scheme.name,
      brandReference: scheme.brandReference,
      startsOn: scheme.startsOn,
      endsOn: scheme.endsOn,
      measure: scheme.measure,
      mode: scheme.mode,
      settlementDays: scheme.settlementDays,
      dateBasis: scheme.dateBasis,
      status: scheme.status,
      note: scheme.note,
      products: own.flatMap((item) =>
        item.productId
          ? [
              {
                id: item.productId,
                name: productTitle(String(item.productBrand), String(item.productName)),
              },
            ]
          : [],
      ),
      categories: own.flatMap((item) =>
        item.categoryId ? [{ id: item.categoryId, name: String(item.categoryName) }] : [],
      ),
      slabs: ownSlabs,
      endedAt: isoOrNull(scheme.endedAt),
      endNote: scheme.endNote,
      createdAt: iso(scheme.createdAt),
      updatedAt: iso(scheme.updatedAt),
    };
    const engine: BrandScheme = {
      id: scheme.id,
      brandId: scheme.brandId,
      startsOn: scheme.startsOn,
      endsOn: scheme.endsOn,
      measure: scheme.measure,
      mode: scheme.mode,
      productIds,
      categoryIds,
      settlementDays: scheme.settlementDays,
      slabs: ownSlabs.map((slab) => ({
        id: slab.id,
        target: slab.target,
        benefits: slab.benefits.map((benefit) => toSlabBenefit(benefit)),
      })),
    };
    return { view, engine };
  });
}

interface BenefitRow {
  readonly benefit: typeof brandSchemeBenefits.$inferSelect;
  readonly productName: string | null;
  readonly brandName: string | null;
  readonly packSize: number | null;
  readonly unit: (typeof productVariants.$inferSelect)['unit'] | null;
  readonly label: string | null;
}

/** A stored benefit as the screens show it. The kind check (0083) makes its columns set. */
function benefitView({ benefit, ...variant }: BenefitRow): SchemeBenefitView {
  switch (benefit.kind) {
    case 'rebate':
      return { kind: 'rebate', basisPoints: Number(benefit.basisPoints) };
    case 'per_litre':
      return { kind: 'per_litre', paisePerLitre: Number(benefit.paisePerLitre) };
    case 'free_goods':
      return {
        kind: 'free_goods',
        variantId: String(benefit.variantId),
        units: Number(benefit.units),
        perMillilitres: benefit.perMillilitres,
        variantTitle: variantTitle(String(variant.brandName), String(variant.productName), {
          packSize: Number(variant.packSize),
          unit: String(variant.unit),
          label: variant.label,
        }),
      };
    case 'points':
      return { kind: 'points', label: String(benefit.label), points: Number(benefit.points) };
  }
}

/** The engine's benefit, without the screen's extras. */
export function toSlabBenefit(benefit: SchemeBenefitView): SlabBenefit {
  if (benefit.kind !== 'free_goods') return benefit;
  return {
    kind: 'free_goods',
    variantId: benefit.variantId,
    units: benefit.units,
    perMillilitres: benefit.perMillilitres,
  };
}

/** A GRN line or purchase return of a scheme's brand, with both of its days. */
export interface GrnLineRecord {
  readonly view: Omit<SchemeGrnLineView, 'countedOn'>;
  readonly brandId: string;
  readonly productId: string;
  readonly categoryId: string | null;
}

/**
 * The brands' GRN lines and purchase returns whose GRN date or supplier invoice date
 * falls between `from` and `to` (both included). Value is paid units × the GRN's unit
 * cost (before GST); scheme-free units add litres only [CA-4]. A purchase return
 * (a `purchase_return` stock movement) is a negative line on its own day, at its unit
 * cost, else its GRN's.
 */
export async function loadGrnLines(
  tx: Transaction,
  brandIds: readonly string[],
  from: string,
  to: string,
): Promise<GrnLineRecord[]> {
  const grnDate = indiaDay(goodsReceipts.receivedAt);
  const receipts = await tx
    .select({
      sourceId: goodsReceipts.id,
      number: goodsReceipts.number,
      receivedOn: grnDate,
      supplierInvoiceDate: goodsReceipts.supplierInvoiceDate,
      storeId: stores.id,
      storeCode: stores.code,
      supplierName: parties.displayName,
      variantId: productVariants.id,
      sku: productVariants.sku,
      productId: products.id,
      productName: products.name,
      brandId: products.brandId,
      brandName: brands.name,
      categoryId: products.categoryId,
      quantity: goodsReceiptLines.quantity,
      freeQuantity: goodsReceiptLines.freeQuantity,
      unitCostPaise: goodsReceiptLines.unitCostPaise,
      valuePaise: sql<string>`round(${goodsReceiptLines.quantity} * coalesce(${goodsReceiptLines.unitCostPaise}, 0))`,
      millilitres: millilitres(goodsReceiptLines.quantity),
      freeMillilitres: millilitres(goodsReceiptLines.freeQuantity),
    })
    .from(goodsReceiptLines)
    .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.goodsReceiptId))
    .innerJoin(stores, eq(stores.id, goodsReceipts.storeId))
    .innerJoin(parties, eq(parties.id, goodsReceipts.supplierPartyId))
    .innerJoin(productVariants, eq(productVariants.id, goodsReceiptLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(brands, eq(brands.id, products.brandId))
    .where(
      and(
        inArray(products.brandId, [...brandIds]),
        sql`((${grnDate})::date between ${from}::date and ${to}::date
          or ${goodsReceipts.supplierInvoiceDate} between ${from}::date and ${to}::date)`,
      ),
    )
    .orderBy(asc(goodsReceipts.receivedAt), asc(goodsReceipts.number), asc(productVariants.sku));

  const returnDate = indiaDay(stockLedger.createdAt);
  const returnLines = alias(goodsReceiptLines, 'return_grn_lines');
  const returns = await tx
    .select({
      sourceId: stockLedger.id,
      number: sql<string>`coalesce(${stockLedger.note}, 'Purchase return')`,
      receivedOn: returnDate,
      storeId: stores.id,
      storeCode: stores.code,
      variantId: productVariants.id,
      sku: productVariants.sku,
      productId: products.id,
      productName: products.name,
      brandId: products.brandId,
      brandName: brands.name,
      categoryId: products.categoryId,
      quantity: stockLedger.quantity,
      unitCostPaise: sql<
        string | null
      >`coalesce(${stockLedger.unitCostPaise}, ${returnLines.unitCostPaise})`,
      valuePaise: sql<string>`round(${stockLedger.quantity}
        * coalesce(${stockLedger.unitCostPaise}, ${returnLines.unitCostPaise}, 0))`,
      millilitres: millilitres(stockLedger.quantity),
    })
    .from(stockLedger)
    .innerJoin(stores, eq(stores.id, stockLedger.storeId))
    .innerJoin(productVariants, eq(productVariants.id, stockLedger.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(
      returnLines,
      and(
        eq(stockLedger.referenceType, 'goods_receipt'),
        eq(returnLines.goodsReceiptId, stockLedger.referenceId),
        eq(returnLines.variantId, stockLedger.variantId),
      ),
    )
    .where(
      and(
        eq(stockLedger.movementType, 'purchase_return'),
        inArray(products.brandId, [...brandIds]),
        sql`(${returnDate})::date between ${from}::date and ${to}::date`,
      ),
    )
    .orderBy(asc(stockLedger.createdAt), asc(stockLedger.id));

  return [
    ...receipts.map((row) => ({
      view: {
        kind: 'receipt' as const,
        sourceId: row.sourceId,
        number: row.number,
        receivedOn: row.receivedOn,
        supplierInvoiceDate: row.supplierInvoiceDate,
        store: { id: row.storeId, code: row.storeCode },
        supplierName: row.supplierName,
        variantId: row.variantId,
        sku: row.sku,
        productName: productTitle(row.brandName, row.productName),
        quantity: row.quantity,
        freeQuantity: row.freeQuantity,
        unitCostPaise: row.unitCostPaise,
        valuePaise: Number(row.valuePaise),
        millilitres: Number(row.millilitres),
        freeMillilitres: Number(row.freeMillilitres),
      },
      brandId: row.brandId,
      productId: row.productId,
      categoryId: row.categoryId,
    })),
    ...returns.map((row) => ({
      view: {
        kind: 'return' as const,
        sourceId: row.sourceId,
        number: row.number,
        receivedOn: row.receivedOn,
        supplierInvoiceDate: null,
        store: { id: row.storeId, code: row.storeCode },
        supplierName: null,
        variantId: row.variantId,
        sku: row.sku,
        productName: productTitle(row.brandName, row.productName),
        quantity: row.quantity,
        freeQuantity: 0,
        unitCostPaise: row.unitCostPaise === null ? null : Number(row.unitCostPaise),
        valuePaise: Number(row.valuePaise),
        millilitres: Number(row.millilitres),
        freeMillilitres: 0,
      },
      brandId: row.brandId,
      productId: row.productId,
      categoryId: row.categoryId,
    })),
  ];
}

/** The day a scheme counts a line on: its GRN date, or its supplier invoice date if set ([CA-21]). */
export function countedOn(line: GrnLineRecord, basis: SchemeDateBasis): string {
  return basis === 'invoice_date'
    ? (line.view.supplierInvoiceDate ?? line.view.receivedOn)
    : line.view.receivedOn;
}

/**
 * The lines a scheme counts as of a day, for the engine and for the screen. `lines`
 * are its brand's, each with its place among every line loaded (its id's suffix).
 */
export function schemeLines(
  record: SchemeRecord,
  lines: readonly (readonly [GrnLineRecord, number])[],
  asOf: string,
): { readonly engine: SchemeGrnLine[]; readonly views: SchemeGrnLineView[] } {
  const engine: SchemeGrnLine[] = [];
  const views: SchemeGrnLineView[] = [];
  lines.forEach(([line, index]) => {
    const day = countedOn(line, record.view.dateBasis);
    const counted: SchemeGrnLine = {
      id: `${line.view.sourceId}:${String(index)}`,
      brandId: line.brandId,
      productId: line.productId,
      categoryId: line.categoryId,
      receivedOn: day,
      valuePaise: line.view.valuePaise,
      millilitres: line.view.millilitres,
      freeMillilitres: line.view.freeMillilitres,
    };
    if (!lineCounts(record.engine, counted, asOf)) return;
    engine.push(counted);
    views.push({ ...line.view, countedOn: day });
  });
  return { engine, views };
}

/** What the brand issued against these schemes, oldest first. */
export async function loadReceipts(
  tx: Transaction,
  schemeIds: readonly string[],
): Promise<{ readonly schemeId: string; readonly view: BenefitReceiptView }[]> {
  const rows = await tx
    .select({
      receipt: brandBenefitReceipts,
      variantSku: productVariants.sku,
      productName: products.name,
      brandName: brands.name,
      packSize: productVariants.packSize,
      unit: productVariants.unit,
      variantLabel: productVariants.label,
      grnNumber: goodsReceipts.number,
      claimNumber: brandClaims.number,
      recordedBy: users.fullName,
    })
    .from(brandBenefitReceipts)
    .leftJoin(productVariants, eq(productVariants.id, brandBenefitReceipts.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(goodsReceipts, eq(goodsReceipts.id, brandBenefitReceipts.goodsReceiptId))
    .leftJoin(brandClaims, eq(brandClaims.id, brandBenefitReceipts.claimId))
    .innerJoin(
      organizationMembers,
      eq(organizationMembers.id, brandBenefitReceipts.recordedByMemberId),
    )
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(inArray(brandBenefitReceipts.schemeId, [...schemeIds]))
    .orderBy(asc(brandBenefitReceipts.receivedOn), asc(brandBenefitReceipts.createdAt));
  return rows.map((row) => {
    const { receipt } = row;
    return {
      schemeId: receipt.schemeId,
      view: {
        id: receipt.id,
        kind: receipt.kind,
        receivedOn: receipt.receivedOn,
        amountPaise: receipt.amountPaise,
        moneyForm: receipt.moneyForm,
        variant: receipt.variantId
          ? {
              id: receipt.variantId,
              title: variantTitle(String(row.brandName), String(row.productName), {
                packSize: Number(row.packSize),
                unit: String(row.unit),
                label: row.variantLabel,
              }),
            }
          : null,
        units: receipt.units,
        goodsReceipt: receipt.goodsReceiptId
          ? { id: receipt.goodsReceiptId, number: String(row.grnNumber) }
          : null,
        label: receipt.label,
        points: receipt.points,
        reference: receipt.reference,
        note: receipt.note,
        claim: receipt.claimId ? { id: receipt.claimId, number: String(row.claimNumber) } : null,
        recordedBy: row.recordedBy,
        createdAt: iso(receipt.createdAt),
      },
    };
  });
}

/** A receipt as the engine reads it. The kind check (0083) makes its columns set. */
export function toReceived(schemeId: string, view: BenefitReceiptView): ReceivedBenefit {
  const base = { id: view.id, schemeId, receivedOn: view.receivedOn };
  switch (view.kind) {
    case 'money':
      return { ...base, kind: 'money', amountPaise: Number(view.amountPaise) };
    case 'free_goods':
      return {
        ...base,
        kind: 'free_goods',
        variantId: String(view.variant?.id),
        units: Number(view.units),
      };
    case 'points':
      return { ...base, kind: 'points', label: String(view.label), points: Number(view.points) };
  }
}

/** Where a scheme stands as of a day: its progress and its claim against what came. */
export function evaluate(
  record: SchemeRecord,
  lines: readonly SchemeGrnLine[],
  received: readonly ReceivedBenefit[],
  asOf: string,
): { readonly progress: SchemeProgress; readonly claim: SchemeClaim } {
  const progress = schemeProgress(record.engine, lines, asOf);
  return { progress, claim: schemeClaim(record.engine, progress.benefit, received, asOf) };
}

/**
 * Schemes with their progress and claims as of a day, loading every GRN line and
 * receipt they need in three queries whatever their number.
 */
export async function evaluateSchemes(
  tx: Transaction,
  records: readonly SchemeRecord[],
  asOf: string,
): Promise<
  {
    readonly record: SchemeRecord;
    readonly lines: SchemeGrnLineView[];
    readonly receipts: BenefitReceiptView[];
    readonly progress: SchemeProgress;
    readonly claim: SchemeClaim;
  }[]
> {
  if (records.length === 0) return [];
  const from = records.reduce(
    (first, { view }) => (view.startsOn < first ? view.startsOn : first),
    '9999-12-31',
  );
  const to = records.reduce(
    (last, { view }) => (view.endsOn > last ? view.endsOn : last),
    '0001-01-01',
  );
  const brandIds = [...new Set(records.map((record) => record.view.brand.id))];
  const lines = await loadGrnLines(tx, brandIds, from, to);
  const receipts = await loadReceipts(
    tx,
    records.map((record) => record.view.id),
  );
  // Each scheme reads its own brand's lines and receipts only: matching every scheme
  // against every line loaded took 2 s for 100 schemes of 20 brands (performance.md).
  const linesOf = groupBy(
    lines.map((line, index) => [line, index] as const),
    ([line]) => line.brandId,
  );
  const receiptsOf = groupBy(receipts, (receipt) => receipt.schemeId);
  return records.map((record) => {
    const counted = schemeLines(record, linesOf(record.view.brand.id), asOf);
    const own = receiptsOf(record.view.id);
    const received = own.map((receipt) => toReceived(record.view.id, receipt.view));
    return {
      record,
      lines: counted.views,
      receipts: own.map((receipt) => receipt.view),
      ...evaluate(record, counted.engine, received, asOf),
    };
  });
}
