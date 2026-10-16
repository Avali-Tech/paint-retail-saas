import type { IssuedInvoiceView } from '@paint/shared';
import type { StoreKey } from './plan.js';
import { basket, sell } from './seed-billing.js';
import { recordConsent } from './seed-collections.js';
import { must, type SeedContext, type SeededParty, type Timeline } from './seed-context.js';

const homeOf = (party: SeededParty): StoreKey =>
  must(party.homeStore, `home store of ${party.key}`);

/**
 * Painter points earn rules (P2-M36): a point per ₹100 on every brand, double on
 * Asian Paints (a brand multiplier), and per litre of Berger.
 */
export function earnRules(context: SeedContext) {
  const brand = (name: string) => must(context.brandIds.get(name), `brand ${name}`);
  const rule = { validFrom: null, validUntil: null, isActive: true };
  return [
    {
      ...rule,
      name: 'Every brand: 1 point per ₹100',
      basis: 'value',
      points: 1,
      perPaise: 100_00,
      perMillilitres: null,
      brandId: null,
      multiplierBps: 10_000,
    },
    {
      ...rule,
      name: 'Asian Paints: double points',
      basis: 'value',
      points: 1,
      perPaise: 100_00,
      perMillilitres: null,
      brandId: brand('Asian Paints'),
      multiplierBps: 20_000,
    },
    {
      ...rule,
      name: 'Berger: 4 points a litre',
      basis: 'litre',
      points: 4,
      perPaise: null,
      perMillilitres: 1_000,
      brandId: brand('Berger'),
      multiplierBps: 10_000,
    },
  ] as const;
}

/** Bills each painter brings in (homeowners they paint for), as shares of the history back. */
const REFERRALS: readonly (readonly number[])[] = [[0.8, 0.55, 0.3], [0.4], [0.7, 0.2]];

/**
 * Painter points from invoices (P2-M36): the owner sets the earn rules; homeowners
 * buy for the painters who work for them, so each bill names its painter, who earns
 * points and is told on WhatsApp when they agreed to it. One homeowner returns a tin,
 * taking back that bill's share of the points. The second painter asks to stop
 * WhatsApp messages the day a notice is queued, so it is never sent.
 */
export function schedulePainterPoints(context: SeedContext, timeline: Timeline): void {
  timeline.at(context.daysAgo(0.97), async () => {
    for (const rule of earnRules(context)) {
      await context.as('owner').post('/loyalty-earn-rules', rule);
      context.count('painter points rules');
    }
  });

  const homeowner = (index: number) => {
    const retail = context.partiesOf('retail');
    return must(retail[(4 + index) % retail.length], 'homeowner');
  };
  let returned: IssuedInvoiceView | null = null;
  let referral = 0;
  REFERRALS.forEach((shares, painterIndex) => {
    for (const share of shares) {
      const customer = referral++;
      timeline.at(context.daysAgo(share), async () => {
        const painter = must(context.partiesOf('painter')[painterIndex], 'painter');
        const party = homeowner(customer);
        const store = homeOf(party);
        const invoice = await sell(context, store, {
          party,
          influencer: painter,
          payBy: 'upi',
          lines: basket(context, store, context.random.int(15, 35) * 1000_00),
        });
        returned ??= invoice;
        context.count('bills earning painter points');
        if (painterIndex === 1) {
          await recordConsent(context, painter, 'whatsapp', 'withdrawn', 'hi');
        }
      });
    }
  });

  timeline.at(context.daysAgo(0.45), async () => {
    const invoice = must(returned, 'painter-tagged bill');
    const line = must(invoice.lines[0], 'invoice line');
    const store = homeOf(homeowner(0));
    await context.as(context.managerOf(store)).post('/sales-returns', {
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId: line.id, quantity: 1, disposition: 'restock', reason: 'Shade too dark' },
      ],
    });
    context.move(store, line.variantId, 1);
    context.count('sales returns');
  });
}
