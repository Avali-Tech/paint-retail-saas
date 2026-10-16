import { schema, type Transaction } from '@paint/db';
import { dayNumber, type BrandSchemeMoney } from '@paint/shared';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { indiaToday } from '../billing/invoice-view.js';
import { evaluateSchemes, loadSchemes } from './scheme-data.js';

const { brandSchemes } = schema;

/**
 * Scheme money per brand for a period, for brand profitability (P2-M35, round 5b):
 * the engine's `BrandSchemeMoney` rows, ready for `brandMargins`.
 *
 * - Schemes counted: active or closed (never draft or cancelled) whose period overlaps
 *   `from`–`to` (both included).
 * - Each scheme is taken as it stands on `asOf` (default: today in India, from the
 *   database clock): its progress from the brand's GRNs and the money the brand has
 *   issued (credit notes and payments, net of reversals) up to that day.
 * - `receivedPaise`: that money; `expectedPaise`: what is still owed, expected −
 *   received, never below 0, and 0 for a closed scheme (nothing more is expected).
 * - A scheme running past either end of the period counts in proportion to its days
 *   inside it (rounded down per scheme), so a year's scheme gives a quarter about a
 *   quarter of its money and consecutive periods never count it twice.
 * - Free goods and points are not money: they are left out ([CA-20]).
 *
 * Runs in the caller's tenant transaction (`withTenant`); `organizationId` is filtered
 * on as well. Brands with no counted scheme are not listed; rows are by brand id.
 */
export async function schemeMoneyByBrand(
  tx: Transaction,
  organizationId: string,
  from: string,
  to: string,
  asOf?: string,
): Promise<BrandSchemeMoney[]> {
  if (dayNumber(to) < dayNumber(from)) throw new RangeError('The period ends before it starts');
  const day = asOf ?? (await indiaToday(tx));
  const records = await loadSchemes(
    tx,
    and(
      eq(brandSchemes.organizationId, organizationId),
      inArray(brandSchemes.status, ['active', 'closed']),
      lte(brandSchemes.startsOn, to),
      gte(brandSchemes.endsOn, from),
    ),
  );
  const evaluated = await evaluateSchemes(tx, records, day);
  const totals = new Map<string, { received: bigint; expected: bigint }>();
  for (const { record, claim } of evaluated) {
    const { startsOn, endsOn, status, brand } = record.view;
    const periodDays = BigInt(dayNumber(endsOn) - dayNumber(startsOn) + 1);
    const inside = BigInt(
      Math.min(dayNumber(endsOn), dayNumber(to)) -
        Math.max(dayNumber(startsOn), dayNumber(from)) +
        1,
    );
    const share = (paise: number) => (BigInt(paise) * inside) / periodDays;
    const owed = status === 'closed' ? 0 : Math.max(claim.money.outstandingPaise, 0);
    const total = totals.get(brand.id) ?? { received: 0n, expected: 0n };
    total.received += share(claim.money.receivedPaise);
    total.expected += share(owed);
    totals.set(brand.id, total);
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([brandId, total]) => ({
      brandId,
      receivedPaise: Number(total.received),
      expectedPaise: Number(total.expected),
    }));
}
