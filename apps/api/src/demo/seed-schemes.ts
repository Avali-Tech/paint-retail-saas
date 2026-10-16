import type { BrandClaimView, SchemeDetail, SchemeInput, SchemeView } from '@paint/shared';
import { indiaDate } from './history-clock.js';
import { must, type SeedContext } from './seed-context.js';

/** ₹1,000 and 10 litres: slab targets are round, as brands print them. */
const THOUSAND = 1_000_00;
const TEN_LITRES = 10_000;
const roundDown = (amount: number, step: number) => Math.floor(amount / step) * step;
const roundUp = (amount: number, step: number) => Math.ceil(amount / step) * step;

/**
 * Brand schemes for the pilot walkthrough (P2-M33, spec §7 round 5: "per brand, the
 * distance to the next slab and the benefits outstanding"). Run after the history, so
 * the GRNs it counts are already on their days. For the two biggest distributors'
 * brands:
 * - the first brand's quarter (by value, running a month more): its first slab reached,
 *   the second one ahead, with the rupees still to buy and per day;
 * - the second brand's litres scheme over the same quarter: its first slab still ahead;
 * - the first brand's pre-monsoon booster, ended half the history ago and due since:
 *   its slab reached, a claim filed and acknowledged, and a credit note for part of
 *   what it earned, so the rest is outstanding and overdue.
 * Targets follow what the demo bought, so the story holds whatever the seed's chance.
 */
export async function seedSchemes(context: SeedContext): Promise<void> {
  const { plan } = context;
  const owner = context.as('owner');
  const suppliers = plan.parties.filter((party) => party.segment === 'supplier');
  const brandOf = (index: number) =>
    must(context.brandIds.get(String(must(suppliers[index], 'supplier').brand)), 'brand');
  const first = brandOf(0);
  const second = brandOf(1);
  const startsOn = indiaDate(plan.historyDays);

  /** A scheme entered with a placeholder slab, so its slabs can follow what it counts. */
  const draft = async (input: Omit<SchemeInput, 'slabs'>) => {
    const scheme = await owner.post<SchemeView>('/brand-schemes', {
      ...input,
      slabs: [{ target: 1, benefits: [{ kind: 'rebate', basisPoints: 100 }] }],
    });
    const detail = await owner.get<SchemeDetail>(`/brand-schemes/${scheme.id}`);
    return { scheme, progress: detail.progress };
  };
  const settle = async (scheme: SchemeView, input: SchemeInput) => {
    await owner.put(`/brand-schemes/${scheme.id}`, input);
    await owner.post(`/brand-schemes/${scheme.id}/activate`);
    context.count('brand schemes');
  };
  const common = {
    brandReference: null,
    mode: 'retro' as const,
    dateBasis: 'grn_date' as const,
    productIds: [],
    categoryIds: [],
  };

  // 1. The first brand's quarter, by value: slab 1 reached, slab 2 ahead.
  const quarterInput = {
    ...common,
    brandId: first,
    name: 'Monsoon quarter',
    brandReference: 'CIRC/Q2/2026',
    startsOn,
    endsOn: indiaDate(-30),
    measure: 'value' as const,
    settlementDays: 45,
    note: 'Quarterly dealer slab: whole volume, on purchases at cost before GST',
  };
  const quarter = await draft(quarterInput);
  const bought = Math.max(quarter.progress.achievedValuePaise, 20 * THOUSAND);
  await settle(quarter.scheme, {
    ...quarterInput,
    slabs: [
      {
        target: Math.max(roundDown(bought * 0.6, THOUSAND), THOUSAND),
        benefits: [{ kind: 'rebate', basisPoints: 100 }],
      },
      {
        target: roundUp(bought * 1.4, THOUSAND),
        benefits: [
          { kind: 'rebate', basisPoints: 150 },
          { kind: 'points', label: 'Goa trip for two', points: 1 },
        ],
      },
      {
        target: roundUp(bought * 2.2, THOUSAND),
        benefits: [
          { kind: 'rebate', basisPoints: 200 },
          { kind: 'points', label: 'Dubai trip for two', points: 1 },
        ],
      },
    ],
  });

  // 2. The second brand's litres scheme: its first slab still ahead.
  const litresInput = {
    ...common,
    brandId: second,
    name: 'Litres booster',
    startsOn,
    endsOn: indiaDate(-30),
    measure: 'litres' as const,
    settlementDays: 30,
    note: 'Scheme-free units count as litres',
  };
  const litres = await draft(litresInput);
  const poured = Math.max(litres.progress.achievedMillilitres, 50 * TEN_LITRES);
  await settle(litres.scheme, {
    ...litresInput,
    slabs: [
      {
        target: roundUp(poured * 1.25, TEN_LITRES),
        benefits: [{ kind: 'per_litre', paisePerLitre: 200 }],
      },
      {
        target: roundUp(poured * 2, TEN_LITRES),
        benefits: [
          { kind: 'per_litre', paisePerLitre: 300 },
          { kind: 'points', label: 'Bangkok trip', points: 1 },
        ],
      },
    ],
  });

  // 3. The first brand's pre-monsoon booster: over, claimed, partly paid, overdue.
  const boosterEnded = context.daysAgo(0.5);
  const boosterInput = {
    ...common,
    brandId: first,
    name: 'Pre-monsoon booster',
    brandReference: 'BOOST/0626',
    startsOn,
    endsOn: indiaDate(boosterEnded),
    measure: 'value' as const,
    settlementDays: Math.floor(boosterEnded / 2),
    note: null,
  };
  const booster = await draft(boosterInput);
  const boosted = Math.max(booster.progress.achievedValuePaise, 10 * THOUSAND);
  await settle(booster.scheme, {
    ...boosterInput,
    slabs: [
      {
        target: Math.max(roundDown(boosted * 0.5, THOUSAND), THOUSAND),
        benefits: [{ kind: 'rebate', basisPoints: 200 }],
      },
    ],
  });
  const claim = await owner.post<BrandClaimView>(`/brand-schemes/${booster.scheme.id}/claims`, {
    filedOn: indiaDate(context.daysAgo(0.4)),
    brandReference: 'CLM/26/0412',
    note: 'Sent to the area sales manager with the GRN list',
  });
  await owner.post(`/brand-schemes/claims/${claim.id}/status`, {
    status: 'acknowledged',
    note: 'Brand confirmed the purchases; credit note in two parts',
  });
  context.count('scheme claims');
  await owner.post(`/brand-schemes/${booster.scheme.id}/receipts`, {
    kind: 'money',
    receivedOn: indiaDate(context.daysAgo(0.15)),
    amountPaise: roundDown(claim.claimedPaise * 0.4, 100),
    moneyForm: 'credit_note',
    reference: 'CN/26/88213',
    note: 'First part of the booster rebate',
    claimId: claim.id,
  });
  context.count('scheme receipts');
}
