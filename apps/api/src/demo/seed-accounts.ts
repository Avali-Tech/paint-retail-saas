import type { PartyPlan, StoreKey } from './plan.js';
import { createParty } from './seed-setup.js';
import { must, type SeedContext, type SeededParty, type Timeline } from './seed-context.js';

const storeOf = (party: PartyPlan): StoreKey => must(party.homeStore, `home store of ${party.key}`);

interface CreditStory {
  readonly party: SeededParty;
  readonly limitRupees: number;
  readonly days: number;
  /** Share of the limit owed today. */
  readonly used: number;
  readonly overdueDays: number;
  readonly risk: 'low' | 'medium' | 'high';
}

/**
 * Credit accounts for contractors, builders and dealers: limits approved by
 * the owner or admin, balances entered by hand (one close to its limit, one
 * well overdue and on hold), one request rejected and two still waiting.
 */
export function scheduleCredit(context: SeedContext, timeline: Timeline): void {
  const { random } = context;
  const stories: CreditStory[] = [];
  timeline.at(context.daysAgo(0.92), async () => {
    const contractors = context.partiesOf('contractor');
    const builders = context.partiesOf('builder');
    const dealers = context.partiesOf('dealer');
    for (const party of contractors) {
      stories.push({
        party,
        limitRupees: random.pick([300_000, 500_000, 750_000]),
        days: random.pick([30, 45]),
        used: random.int(15, 65) / 100,
        overdueDays: random.pick([0, 0, 5, 12]),
        risk: 'low',
      });
    }
    for (const party of builders) {
      stories.push({
        party,
        limitRupees: random.pick([1_000_000, 1_500_000, 2_500_000]),
        days: random.pick([45, 60]),
        used: random.int(20, 70) / 100,
        overdueDays: random.pick([0, 8]),
        risk: 'medium',
      });
    }
    // The first dealer's request is turned down; it asks again (see below).
    for (const party of dealers.slice(1)) {
      stories.push({
        party,
        limitRupees: random.pick([200_000, 300_000, 500_000]),
        days: 30,
        used: random.int(10, 50) / 100,
        overdueDays: 0,
        risk: 'low',
      });
    }
    for (const story of stories) {
      await context.as(context.managerOf(storeOf(story.party))).post('/credit-requests', {
        partyId: story.party.id,
        limitPaise: story.limitRupees * 100,
        creditDays: story.days,
        note: 'Regular buyer; pays by cheque on time',
      });
    }
    const dealer = must(dealers[0], 'dealer');
    await context.as(context.managerOf(storeOf(dealer))).post('/credit-requests', {
      partyId: dealer.id,
      limitPaise: 800_000_00,
      creditDays: 60,
      note: 'New dealer, wants to stock our full range',
    });
    context.count('credit requests', stories.length + 1);
  });

  timeline.at(context.daysAgo(0.88), async () => {
    const pending = await context
      .as('owner')
      .get<{ items: { id: string; party: { id: string } }[] }>(
        '/credit-requests?status=pending&limit=200',
      );
    const dealer = must(context.partiesOf('dealer')[0], 'dealer');
    for (const [index, request] of pending.items.entries()) {
      const approver = index % 2 === 0 ? 'owner' : 'admin';
      if (request.party.id === dealer.id) {
        await context.as(approver).post(`/credit-requests/${request.id}/reject`, {
          reason: 'GST returns pending for two quarters; resubmit with bank statements',
        });
      } else {
        await context.as(approver).post(`/credit-requests/${request.id}/approve`, {
          note: 'Approved after checking payment history',
        });
      }
    }
  });

  timeline.at(context.daysAgo(0.3), async () => {
    for (const [index, story] of stories.entries()) {
      // The first contractor is close to its limit; the first builder is on hold.
      const nearLimit = index === 0;
      const onHold = story.party === context.partiesOf('builder')[0];
      const manager = context.as(context.managerOf(storeOf(story.party)));
      await manager.patch(`/parties/${story.party.id}/credit`, {
        manualExposurePaise: Math.round(story.limitRupees * (nearLimit ? 0.94 : story.used)) * 100,
        overdueDays: onHold ? 75 : story.overdueDays,
        risk: onHold ? 'high' : nearLimit ? 'medium' : story.risk,
        notes: onHold ? 'Cheque returned unpaid twice' : 'Pays within terms',
      });
      if (onHold) {
        await manager.post(`/parties/${story.party.id}/credit/hold`, {
          reason: 'Cheque of ₹1,85,000 returned unpaid',
        });
      }
    }
  });

  // Waiting for the owner today: a dealer asking again, and more credit for the busiest contractor.
  timeline.at(1, async () => {
    const dealer = must(context.partiesOf('dealer')[0], 'dealer');
    await context.as(context.salesOf(storeOf(dealer))).post('/credit-requests', {
      partyId: dealer.id,
      limitPaise: 400_000_00,
      creditDays: 30,
      note: 'Resubmitted with six months of bank statements',
    });
    const contractor = must(stories[0], 'credit story').party;
    await context.as(context.managerOf(storeOf(contractor))).post('/credit-requests', {
      partyId: contractor.id,
      limitPaise: 1_000_000_00,
      creditDays: 45,
      note: 'Needs more credit for the Jubilee Hills villa order',
    });
    context.count('credit requests', 2);
  });
}

/**
 * Painters (and two contractors) in the loyalty programme, earning points on
 * hand-entered bills, a painter-meet campaign, a referral award, redemptions
 * and one correction. The two busiest painters reach Gold and Platinum.
 */
export function scheduleLoyalty(context: SeedContext, timeline: Timeline): void {
  const { random, plan } = context;
  const painters = plan.parties.filter(
    (party) => party.segment === 'painter' && party.duplicateOf === null,
  );
  const contractors = plan.parties.filter((party) => party.segment === 'contractor').slice(0, 2);
  const members = [...painters, ...contractors];
  members.forEach((member, index) => {
    const enrolled = context.daysAgo(0.95 - index * 0.02);
    timeline.at(enrolled, async () => {
      const party = context.party(member.key);
      await context.as(context.salesOf(storeOf(party))).post(`/parties/${party.id}/loyalty`, {
        assignedMemberId: context.memberId(context.salesOf(storeOf(party))),
      });
      context.count('loyalty members');
    });
    // The two busiest painters buy for big sites; others for homes.
    const big = index < 2;
    const bills = random.int(big ? 6 : 2, big ? 9 : 6);
    for (let bill = 0; bill < bills; bill++) {
      const day = Math.max(1, enrolled - 1 - Math.floor(((enrolled - 2) * bill) / bills));
      const rupees = big ? random.int(60, 180) * 1000 : random.int(4, 45) * 1000;
      const reference = `${storeOf(member)}/26-27/${String(random.int(1000, 9999))}`;
      timeline.at(day, async () => {
        const party = context.party(member.key);
        // Entered by the branch manager, so the salesperson hears when a tier is reached.
        await context
          .as(context.managerOf(storeOf(party)))
          .post(`/parties/${party.id}/loyalty/purchases`, {
            manualPurchasePaise: rupees * 100,
            reference,
          });
        context.count('loyalty purchases');
      });
    }
  });

  timeline.at(context.daysAgo(0.2), async () => {
    const owner = context.as('owner');
    for (const member of painters.slice(0, 6)) {
      await owner.post(`/parties/${context.party(member.key).id}/loyalty/awards`, {
        points: 200,
        campaign: 'Painter Meet – September',
        note: 'Attended the product training at Ameerpet',
      });
    }
    const first = context.party(must(painters[0], 'painter').key);
    const second = context.party(must(painters[1], 'painter').key);
    await owner.post(`/parties/${first.id}/loyalty/awards`, {
      points: 100,
      note: 'Referred the Jubilee Hills villa lead',
    });
    await owner.post(`/parties/${first.id}/loyalty/redemptions`, {
      points: 1_500,
      note: 'Redeemed for a spray machine',
    });
    await owner.post(`/parties/${second.id}/loyalty/redemptions`, {
      points: 500,
      note: 'Redeemed for a gift voucher',
    });
    await owner.post(`/parties/${second.id}/loyalty/adjustments`, {
      points: -40,
      reason: 'Bill entered twice',
    });
  });
}

/**
 * The near-duplicates arrive late, entered by someone at the counter in a
 * hurry, and pick up some activity of their own, so the merge has something to move.
 */
export function scheduleDuplicates(context: SeedContext, timeline: Timeline): void {
  const duplicates = context.plan.parties.filter((party) => party.duplicateOf !== null);
  for (const duplicate of duplicates) {
    timeline.at(context.daysAgo(0.25), async () => {
      const id = await createParty(context, duplicate);
      const store = storeOf(context.party(duplicate.key));
      if (duplicate.segment === 'painter') {
        const sales = context.as(context.salesOf(store));
        await sales.post(`/parties/${id}/loyalty`, {});
        await sales.post(`/parties/${id}/loyalty/purchases`, {
          manualPurchasePaise: 18_000_00,
          reference: `${store}/26-27/0420`,
        });
      } else {
        await context.as('crm').post('/leads', {
          storeId: context.storeId(store),
          partyId: id,
          title: 'Apartment repaint, Miyapur (Flat 302)',
          source: 'walk_in',
          estimatedValuePaise: 90_000_00,
        });
        context.count('leads');
      }
    });
  }
}
