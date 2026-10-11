import { BadRequestException } from '@nestjs/common';
import { nextDocumentNumber, schema, type Transaction } from '@paint/db';
import {
  defaultSeries,
  financialYear,
  formatTaxDocumentNumber,
  type TaxDocumentKind,
} from '@paint/shared';
import { and, eq } from 'drizzle-orm';

const { documentSeries } = schema;

export interface ActiveSeries {
  readonly id: string;
  readonly prefix: string;
  readonly digits: number;
}

/** The store's active series for `kind`, set up with the default prefix when it has none. */
export async function activeSeries(
  tx: Transaction,
  organizationId: string,
  storeId: string,
  storeCode: string,
  kind: TaxDocumentKind,
): Promise<ActiveSeries> {
  const active = () =>
    tx
      .select({
        id: documentSeries.id,
        prefix: documentSeries.prefix,
        digits: documentSeries.digits,
      })
      .from(documentSeries)
      .where(
        and(
          eq(documentSeries.storeId, storeId),
          eq(documentSeries.kind, kind),
          eq(documentSeries.isActive, true),
        ),
      );
  const [existing] = await active();
  if (existing) return existing;
  const fallback = defaultSeries(storeCode, kind);
  if (fallback === null) {
    throw new BadRequestException(
      `Set up a document series for this store: its code is too long to number ${kind.replaceAll('_', ' ')}s`,
    );
  }
  // Concurrent first documents at a store race to create it; the losers use the winner's.
  await tx
    .insert(documentSeries)
    .values({ organizationId, storeId, kind, ...fallback })
    .onConflictDoNothing();
  const [created] = (await active()) as [ActiveSeries];
  return created;
}

/** A GST document number taken in the issuing transaction: gap-free per GSTIN, FY, kind and prefix. */
export interface TakenNumber {
  readonly seriesId: string;
  readonly number: string;
  readonly fy: string;
}

/** Takes the next number of the store's `kind` series for the financial year of `on`. */
export async function takeDocumentNumber(
  tx: Transaction,
  organizationId: string,
  store: { readonly id: string; readonly code: string; readonly gstin: string },
  kind: TaxDocumentKind,
  on: string,
): Promise<TakenNumber> {
  const series = await activeSeries(tx, organizationId, store.id, store.code, kind);
  const fy = financialYear(on);
  const serial = await nextDocumentNumber(
    tx,
    organizationId,
    `tax:${kind}:${store.gstin}:${fy}:${series.prefix}`,
  );
  return {
    seriesId: series.id,
    number: formatTaxDocumentNumber(series.prefix, fy, serial, series.digits),
    fy,
  };
}
