import type { StoreKey } from './plan.js';
import { creditStories } from './seed-accounts.js';
import { basket, sell } from './seed-billing.js';
import { must, type SeedContext, type SeededParty, type Timeline } from './seed-context.js';

/** The contractor whose work is split into site accounts: the second, billed on account. */
export function siteContractor(context: SeedContext): SeededParty {
  return must(context.partiesOf('contractor')[1], 'site contractor');
}

/** Two sites of one contractor, each with its own limit (MVP 3 spec §3.3). */
export const SITES = [
  {
    name: 'Villa 41, Aparna Hillpark, Gachibowli',
    addressLine: 'Villa 41, Aparna Hillpark, Gachibowli',
    pincode: '500032',
    limitRupees: 200_000,
    notes: 'Interior and exterior; the owner pays the contractor monthly',
    /** Bills booked to the site, as shares of the history back. */
    bills: [0.7, 0.5, 0.3, 0.12],
  },
  {
    name: 'Skyline Residency Block B, Kondapur',
    addressLine: 'Block B, Skyline Residency, Kondapur',
    pincode: '500084',
    limitRupees: 150_000,
    notes: 'Common areas of 48 flats; the builder pays on running bills',
    bills: [0.6, 0.35],
  },
] as const;

const ids = new WeakMap<SeedContext, string[]>();

/** The site accounts' ids, in the order of SITES, once they exist. */
export function siteAccountIds(context: SeedContext): readonly string[] {
  return must(ids.get(context), 'site accounts');
}

/**
 * Site accounts (P2-M09): the contractor's two jobs become projects with a site
 * account each, inside its own limit; bills are booked to each site (and others to
 * no site), so each site has its own outstanding, ledger and ageing. The builder of
 * Block B falls behind, so its site goes on hold two days ago.
 */
export function scheduleSites(context: SeedContext, timeline: Timeline): void {
  const contractor = () => siteContractor(context);
  const storeOf = (): StoreKey => must(contractor().homeStore, 'contractor home store');
  const projectIds: string[] = [];

  // After the contractor's credit is approved (seed-accounts.ts, 0.88).
  timeline.at(context.daysAgo(0.75), async () => {
    const store = storeOf();
    const list: string[] = [];
    for (const site of SITES) {
      const project = await context.as('crm').post('/projects', {
        storeId: context.storeId(store),
        customerPartyId: contractor().id,
        name: site.name,
        addressLine: site.addressLine,
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: site.pincode,
        assignedMemberId: context.memberId(context.salesOf(store)),
      });
      projectIds.push(project.id);
      const account = await context.as('owner').post(`/parties/${contractor().id}/sites`, {
        projectId: project.id,
        limitPaise: site.limitRupees * 100,
        notes: site.notes,
      });
      list.push(account.id);
      context.count('projects');
      context.count('site accounts');
    }
    ids.set(context, list);
  });

  SITES.forEach((site, index) => {
    for (const share of site.bills) {
      timeline.at(context.daysAgo(share), async () => {
        const story = must(
          creditStories(context).find((entry) => entry.party.id === contractor().id),
          'site contractor credit',
        );
        const store = storeOf();
        await sell(context, store, {
          by: context.salesOf(store),
          party: contractor(),
          payBy: 'credit',
          creditDays: story.days,
          projectId: must(projectIds[index], 'site project'),
          lines: basket(context, store, context.random.int(20, 40) * 1000_00),
        });
        context.count('site bills');
      });
    }
  });

  timeline.at(2, async () => {
    const block = must(siteAccountIds(context)[1], 'Block B account');
    await context.as(context.managerOf(storeOf())).post(`/site-accounts/${block}/hold`, {
      reason: 'The builder has not released the contractor’s running bill',
    });
  });
}
