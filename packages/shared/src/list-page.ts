/**
 * Totals on the MVP 2 lists (invoices, notes, payments, quotations, orders, estimates,
 * register sessions) are counted up to this many rows and no further, so a large shop's
 * count stays as quick as its first page; past it the list says "10,000+".
 */
export const LIST_COUNT_CAP = 10_000;

/**
 * What every keyset-paged list answers besides its rows. `nextCursor` asks for the rows
 * after this page (`?cursor=`), which stays as fast on page 500 as on page 1; `null` on
 * the last page.
 */
export interface ListPageInfo {
  /** Rows matching the filters, up to {@link LIST_COUNT_CAP}. */
  readonly total: number;
  /** More than {@link LIST_COUNT_CAP} rows match: `total` is the cap. */
  readonly totalCapped: boolean;
  readonly nextCursor: string | null;
}
