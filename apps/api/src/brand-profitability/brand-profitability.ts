import { NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import {
  brandMargins,
  canAccessStore,
  previousQuarter,
  sumMargins,
  type BrandProfitabilityRow,
  type BrandProfitabilityView,
  type MarginSlice,
  type ProfitabilitySliceView,
} from '@paint/shared';
import { inArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import type { BrandProfitabilityInput } from './brand-profitability.schemas.js';
import { marginRows } from './margin-rows.js';
import { loadMarginInputs } from './profitability-data.js';
import { profitabilitySettings } from './profitability-settings.js';
import type { SchemeMoneySource } from './scheme-money.js';

/**
 * Brand profitability (roadmap P2-M35, spec §6.3): the books loaded for the
 * period, attributed to brand, product and store (`marginRows`), and run through
 * the margin engine once at the finest grain, business-wide, so each brand's
 * scheme money is spread over all its sales. Slices are then kept to the member's
 * stores and the filters, and summed to the grouping asked for (`sumMargins`), so
 * a brand's products, or its stores, always add up to the brand.
 */

const { brands, products, stores } = schema;

interface Named {
  readonly id: string;
  readonly name: string;
}

/** Items grouped by key, groups in first-seen order. */
function groupBy<T, K>(items: readonly T[], key: (item: T) => K): [K, T[]][] {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const list = groups.get(key(item)) ?? [];
    list.push(item);
    groups.set(key(item), list);
  }
  return [...groups];
}

const byContribution = <T extends { contributionPaise: number }>(
  a: T,
  b: T,
  nameA: string,
  nameB: string,
) => b.contributionPaise - a.contributionPaise || nameA.localeCompare(nameB);

export async function brandProfitability(
  tx: Transaction,
  auth: AuthContext,
  query: BrandProfitabilityInput,
  schemes: SchemeMoneySource,
): Promise<BrandProfitabilityView> {
  if (query.storeId !== undefined && !canAccessStore(auth, query.storeId)) {
    throw new NotFoundException('Store not found');
  }
  const period =
    query.from !== undefined && query.to !== undefined
      ? { from: query.from, to: query.to }
      : previousQuarter(await indiaToday(tx));
  const settings = await profitabilitySettings(tx);
  const costOfMoneyBps = query.costOfMoneyBps ?? settings.costOfMoneyBps;
  const pointValuePaise = query.pointValuePaise ?? settings.pointValuePaise;
  const ofBrand = <T extends { brandId: string }>(list: readonly T[]) =>
    query.brandId === undefined ? list : list.filter((item) => item.brandId === query.brandId);

  const rows = ofBrand(
    marginRows(await loadMarginInputs(tx, period), {
      ...period,
      pointValuePaise,
    }),
  );
  const money = ofBrand(await schemes.byBrand(tx, auth.organization.id, period.from, period.to));
  const unfiltered = query.storeId === undefined && query.productId === undefined;
  const shown = (slice: { storeId: string | null; productId: string | null }) =>
    slice.storeId === null
      ? unfiltered
      : canAccessStore(auth, slice.storeId) &&
        (query.storeId === undefined || slice.storeId === query.storeId) &&
        (query.productId === undefined || slice.productId === query.productId);
  const slices = brandMargins(rows, money, {
    groupBy: ['product', 'store'],
    costOfMoneyBps,
  }).filter(shown);
  const uncosted = rows.filter(shown);

  const names = await lookups(tx, slices);
  const brandRows: BrandProfitabilityRow[] = groupBy(slices, (slice) => slice.brandId).map(
    ([brandId, own]) => ({
      brandId,
      brandName: String(names.brands.get(brandId)),
      figures: sumMargins(own),
      uncostedLines: uncosted
        .filter((row) => row.brandId === brandId)
        .reduce((sum, row) => sum + row.uncostedLines, 0),
      slices: query.groupBy === 'brand' ? [] : group(own, query.groupBy, names),
    }),
  );
  brandRows.sort((a, b) => byContribution(a.figures, b.figures, a.brandName, b.brandName));
  return {
    ...period,
    groupBy: query.groupBy,
    costOfMoneyBps,
    pointValuePaise,
    settings,
    schemesCounted: schemes.counted,
    brands: brandRows,
    total: sumMargins(brandRows.map((row) => row.figures)),
    uncostedLines: brandRows.reduce((sum, row) => sum + row.uncostedLines, 0),
  };
}

interface Names {
  readonly brands: ReadonlyMap<string, string>;
  readonly products: ReadonlyMap<string, string>;
  readonly stores: ReadonlyMap<string, { code: string; name: string }>;
}

/** A brand's slices summed by product or by store, most contribution first. */
function group(
  own: readonly MarginSlice[],
  by: 'product' | 'store',
  names: Names,
): ProfitabilitySliceView[] {
  const key = (slice: MarginSlice) => (by === 'product' ? slice.productId : slice.storeId);
  const views = groupBy(own, key).map(([id, list]): ProfitabilitySliceView => {
    const store = by === 'store' && id !== null ? names.stores.get(id) : undefined;
    return {
      productId: by === 'product' ? id : null,
      productName: by === 'product' && id !== null ? String(names.products.get(id)) : null,
      storeId: by === 'store' ? id : null,
      storeCode: store?.code ?? null,
      storeName: store?.name ?? null,
      ...sumMargins(list),
    };
  });
  const label = (view: ProfitabilitySliceView) => String(view.productName ?? view.storeCode);
  return views.sort((a, b) => byContribution(a, b, label(a), label(b)));
}

/** The names of the brands, products and stores the slices name, three queries at most. */
async function lookups(tx: Transaction, slices: readonly MarginSlice[]): Promise<Names> {
  const ids = (pick: (slice: MarginSlice) => string | null) => [
    ...new Set(slices.map(pick).filter((id): id is string => id !== null)),
  ];
  const brandIds = ids((slice) => slice.brandId);
  const productIds = ids((slice) => slice.productId);
  const storeIds = ids((slice) => slice.storeId);
  const named = (rows: readonly Named[]) => new Map(rows.map((row) => [row.id, row.name]));
  if (brandIds.length === 0) return { brands: new Map(), products: new Map(), stores: new Map() };
  return {
    brands: named(
      await tx
        .select({ id: brands.id, name: brands.name })
        .from(brands)
        .where(inArray(brands.id, brandIds)),
    ),
    products: named(
      productIds.length === 0
        ? []
        : await tx
            .select({ id: products.id, name: products.name })
            .from(products)
            .where(inArray(products.id, productIds)),
    ),
    stores: new Map(
      (storeIds.length === 0
        ? []
        : await tx
            .select({ id: stores.id, code: stores.code, name: stores.name })
            .from(stores)
            .where(inArray(stores.id, storeIds))
      ).map((store) => [store.id, { code: store.code, name: store.name }]),
    ),
  };
}
