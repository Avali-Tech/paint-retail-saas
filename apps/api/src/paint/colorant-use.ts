import { postStockMovements, schema, type Transaction } from '@paint/db';
import {
  colorantDose,
  type DoseGap,
  type TintFormulaComponent,
  type TintUnitsMl,
} from '@paint/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Notifier } from '../notifications/notifier.js';

const { organizations, productVariants, products, salesSettings, stockBalances, tintRecords } =
  schema;

/** Part of a tinted invoice line leaving the store. */
export interface LeavingTintedLine {
  readonly invoiceLineId: string;
  /** Packs of the line leaving now. */
  readonly quantity: number;
  /** Packs on the line in all. */
  readonly lineQuantity: number;
}

export interface ColorantUse {
  readonly organizationId: string;
  readonly storeId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  /** What moved the base: the invoice, or a dispatch of it. */
  readonly referenceType: 'tax_document' | 'dispatch';
  readonly referenceId: string;
  readonly memberId: string;
  readonly lines: readonly LeavingTintedLine[];
}

/** Stock keeps 3 decimals. */
const round3 = (value: number) => Math.round(value * 1000) / 1000;

const GAP_TEXT: Record<DoseGap, string> = {
  shot_not_set: 'set how many ml a shot is (Settings → Tinting)',
  y_not_set: 'set how many ml a Y is (Settings → Tinting)',
  density_not_set: 'set the colorant’s density (g per ml)',
};

/**
 * Takes the colorant of tinted packs out of stock as the packs leave (round 8a),
 * as tint_use movements beside the base's sale. Only doses that name a loose
 * colorant count. The counter never stops for it: when the store has less
 * colorant than the dose, what it has is taken, the movement notes the
 * shortfall, and the store's stock staff are told, so a receipt or count can
 * put it right. Colorant is never given back: it is in the can.
 */
export async function postColorantUse(
  tx: Transaction,
  notifier: Notifier,
  use: ColorantUse,
): Promise<void> {
  if (use.lines.length === 0) return;
  const records = await tx
    .select({
      invoiceLineId: tintRecords.invoiceLineId,
      packQuantity: tintRecords.packQuantity,
      formula: tintRecords.formula,
    })
    .from(tintRecords)
    .where(
      inArray(
        tintRecords.invoiceLineId,
        use.lines.map((line) => line.invoiceLineId),
      ),
    );
  const doses = use.lines.flatMap((line) =>
    records
      .filter((record) => record.invoiceLineId === line.invoiceLineId)
      .flatMap((record) => {
        // Tinted packs leave in step with the line's packs.
        const packs = (record.packQuantity * line.quantity) / line.lineQuantity;
        return (record.formula as TintFormulaComponent[]).flatMap((dose) =>
          dose.colorantVariantId === undefined
            ? []
            : [{ ...dose, packs, variantId: dose.colorantVariantId }],
        );
      }),
  );
  if (doses.length === 0) return;

  // Through the business, so a business with no settings saved reads them as not set.
  const [units] = (await tx
    .select({ shotMl: salesSettings.tintShotMl, yMl: salesSettings.tintYMl })
    .from(organizations)
    .leftJoin(salesSettings, eq(salesSettings.organizationId, organizations.id))
    .where(eq(organizations.id, use.organizationId))) as [TintUnitsMl];
  const variantIds = [...new Set(doses.map((dose) => dose.variantId))];
  const colorants = await tx
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      unit: productVariants.unit,
      densityGPerMl: productVariants.densityGPerMl,
      name: products.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));
  // Locked, so two bills cannot both take the last of a colorant.
  const balances = await tx
    .select({ variantId: stockBalances.variantId, onHand: stockBalances.onHand })
    .from(stockBalances)
    .where(
      and(eq(stockBalances.storeId, use.storeId), inArray(stockBalances.variantId, variantIds)),
    )
    .for('update');

  const problems: string[] = [];
  const movements = colorants.flatMap((colorant) => {
    // Checked loose (one ml or one g) when the tint was saved.
    const unit = colorant.unit as 'ml' | 'g';
    let need = 0;
    for (const dose of doses.filter((candidate) => candidate.variantId === colorant.id)) {
      const perPack = colorantDose(
        dose.amount,
        dose.unit,
        { unit, densityGPerMl: colorant.densityGPerMl },
        units,
      );
      if (perPack.ok) need += perPack.quantity * dose.packs;
      else problems.push(`${colorant.name} (${colorant.sku}) not taken: ${GAP_TEXT[perPack.gap]}`);
    }
    need = round3(need);
    if (need <= 0) return [];
    const onHand = balances.find((row) => row.variantId === colorant.id)?.onHand ?? 0;
    const take = round3(Math.min(need, onHand));
    const short = round3(need - take);
    if (short > 0) {
      problems.push(
        `${colorant.name} (${colorant.sku}) short by ${String(short)} ${unit}: ${String(take)} of ${String(need)} taken`,
      );
    }
    if (take <= 0) return [];
    return [
      {
        organizationId: use.organizationId,
        storeId: use.storeId,
        variantId: colorant.id,
        movementType: 'tint_use' as const,
        quantity: -take,
        referenceType: use.referenceType,
        referenceId: use.referenceId,
        note:
          short > 0
            ? `Tinting for ${use.invoiceNumber}, short by ${String(short)} ${unit}`
            : `Tinting for ${use.invoiceNumber}`,
        createdByMemberId: use.memberId,
      },
    ];
  });
  await postStockMovements(tx, movements);
  if (problems.length > 0) {
    await notifier.notify(tx, {
      organizationId: use.organizationId,
      event: 'colorant_short',
      to: { storeId: use.storeId, permission: 'inventory:manage' },
      title: `Colorant not fully taken for ${use.invoiceNumber}`,
      body: `${problems.join('; ')}. Record the colorant received, or count it.`,
      link: `/invoices/${use.invoiceId}`,
    });
  }
}
