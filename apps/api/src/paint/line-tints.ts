import { schema, type Transaction } from '@paint/db';
import type { LineTintView, TintFormulaComponent, TintLineKind } from '@paint/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { fieldError } from '../tax/tax-lookups.js';
import type { LineTintInput } from './paint.schemas.js';
import { tintLineColumn } from './tint-lines.js';

const { brands, productVariants, products, tintRecords } = schema;

/** The tint-record field naming a line of each kind. */
export const LINE_FIELD = {
  quotation_line: 'quotationLineId',
  sales_order_line: 'salesOrderLineId',
  invoice_line: 'invoiceLineId',
} as const satisfies Record<TintLineKind, keyof typeof tintRecords.$inferInsert>;

/** A saved line and the tint to write for it. */
export interface LineTint {
  readonly lineId: string;
  readonly variantId: string;
  readonly quantity: number;
  /** Where the line is tinted. */
  readonly storeId: string;
  readonly tint: LineTintInput;
  /** Where errors point: "" for POST /tint-records, "lines.0.tint." for a line's own tint. */
  readonly path: string;
  /** Where "not a tintable base" points. */
  readonly basePath: string;
}

/**
 * Writes the tint record of each line (spec §6.3), after the rules of POST
 * /tint-records: a tintable base, packs at most the line's quantity, a known
 * brand (default: the base's). A broken rule throws a 400, which rolls back
 * the caller's transaction (the whole save). Returns the new records' ids.
 */
export async function writeLineTints(
  tx: Transaction,
  auth: AuthContext,
  kind: TintLineKind,
  target: { readonly partyId: string | null; readonly projectId: string | null },
  lines: readonly LineTint[],
): Promise<string[]> {
  if (lines.length === 0) return [];
  const bases = await tx
    .select({
      variantId: productVariants.id,
      brandId: products.brandId,
      isTintable: products.isTintable,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      inArray(
        productVariants.id,
        lines.map((line) => line.variantId),
      ),
    );
  const brandIds = lines.flatMap((line) => (line.tint.brandId ? [line.tint.brandId] : []));
  const known =
    brandIds.length === 0
      ? []
      : await tx.select({ id: brands.id }).from(brands).where(inArray(brands.id, brandIds));
  const values = lines.map((line) => {
    const base = bases.find((row) => row.variantId === line.variantId);
    if (!base?.isTintable) throw fieldError(line.basePath, 'This product is not a tintable base');
    const packQuantity = line.tint.packQuantity ?? line.quantity;
    if (packQuantity > line.quantity) {
      throw fieldError(`${line.path}packQuantity`, `The line has ${String(line.quantity)} packs`);
    }
    if (line.tint.brandId !== undefined && !known.some((row) => row.id === line.tint.brandId)) {
      throw fieldError(`${line.path}brandId`, 'Unknown brand');
    }
    return {
      organizationId: auth.organization.id,
      storeId: line.storeId,
      partyId: target.partyId,
      projectId: target.projectId,
      [LINE_FIELD[kind]]: line.lineId,
      brandId: line.tint.brandId ?? base.brandId,
      shadeCode: line.tint.shadeCode,
      shadeName: line.tint.shadeName ?? null,
      baseVariantId: line.variantId,
      packQuantity,
      colorantCostPaise: line.tint.colorantCostPaise ?? null,
      tintChargePaise: line.tint.tintChargePaise ?? 0,
      machine: line.tint.machine ?? null,
      formula: line.tint.formula ?? [],
      note: line.tint.note ?? null,
      createdByMemberId: auth.memberId,
    };
  });
  const rows = await tx.insert(tintRecords).values(values).returning({ id: tintRecords.id });
  return rows.map((row) => row.id);
}

/** The tints of these lines, by line id, as read with the lines. */
export async function lineTints(
  tx: Transaction,
  kind: TintLineKind,
  lineIds: readonly string[],
): Promise<ReadonlyMap<string, LineTintView>> {
  const column = tintLineColumn(kind);
  // Every document has lines, so the list is never empty.
  const rows = await tx
    .select({ record: tintRecords, lineId: column, brandName: brands.name })
    .from(tintRecords)
    .innerJoin(brands, eq(brands.id, tintRecords.brandId))
    .where(inArray(column, [...lineIds]));
  return new Map(
    rows.map(({ record, lineId, brandName }) => [
      String(lineId),
      {
        id: record.id,
        brand: { id: record.brandId, name: brandName },
        shadeCode: record.shadeCode,
        shadeName: record.shadeName,
        packQuantity: record.packQuantity,
        colorantCostPaise: record.colorantCostPaise,
        tintChargePaise: record.tintChargePaise,
        machine: record.machine,
        formula: record.formula as TintFormulaComponent[],
        note: record.note,
        createdAt: record.createdAt.toISOString(),
      },
    ]),
  );
}

/** `view` with its line's tint, when it has one. */
export function withTint<T extends { readonly id: string }>(
  view: T,
  tints: ReadonlyMap<string, LineTintView>,
): T & { readonly tint?: LineTintView } {
  const tint = tints.get(view.id);
  return tint === undefined ? view : { ...view, tint };
}

/**
 * The tints of a saved document's lines: line n of the request (with its
 * `tint`) is the saved line numbered n + 1, tinted at `storeOf(n)`.
 */
export function tintsOf(
  sent: readonly { readonly variantId: string; readonly tint?: LineTintInput }[],
  saved: readonly { readonly id: string; readonly lineNo: number; readonly quantity: number }[],
  storeOf: (index: number) => string,
): LineTint[] {
  return sent.flatMap((line, index) => {
    const row = saved.find((candidate) => candidate.lineNo === index + 1);
    return line.tint === undefined || row === undefined
      ? []
      : [
          {
            lineId: row.id,
            variantId: line.variantId,
            quantity: row.quantity,
            storeId: storeOf(index),
            tint: line.tint,
            path: `lines.${String(index)}.tint.`,
            basePath: `lines.${String(index)}.tint`,
          },
        ];
  });
}
