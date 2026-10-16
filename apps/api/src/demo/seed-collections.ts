import {
  CONSENT_NOTICE_VERSION,
  type EscalationView,
  type MessageChannel,
  type MessageLanguage,
  type PartyCreditSummary,
  type PartyLedgerView,
} from '@paint/shared';
import { indiaDate } from './history-clock.js';
import type { StoreKey } from './plan.js';
import { creditStories, type CreditStory } from './seed-accounts.js';
import { basket, paymentMode, sell } from './seed-billing.js';
import { must, type SeedContext, type SeededParty, type Timeline } from './seed-context.js';
import { siteContractor } from './seed-sites.js';

const homeOf = (party: SeededParty): StoreKey =>
  must(party.homeStore, `home store of ${party.key}`);

/** The credit account whose bills lapse in the given way (seed-accounts.ts). */
export function lapsed(context: SeedContext, lapse: CreditStory['lapse']): SeededParty {
  return must(
    creditStories(context).find((story) => story.lapse === lapse),
    `${String(lapse)} account`,
  ).party;
}

/** The contractor that keeps its promise to pay: the third, billed on account. */
export function promiseKeeper(context: SeedContext): SeededParty {
  return must(context.partiesOf('contractor')[2], 'third contractor');
}

/** Records a party's answer to the consent notice at the counter (spec MSG-2). */
export async function recordConsent(
  context: SeedContext,
  party: SeededParty,
  channel: MessageChannel,
  state: 'granted' | 'withdrawn',
  language: MessageLanguage,
): Promise<void> {
  await context.as(context.salesOf(homeOf(party))).post(`/parties/${party.id}/consents`, {
    channel,
    state,
    method: 'counter_with_notice',
    language,
    noticeVersion: CONSENT_NOTICE_VERSION,
  });
  context.count(state === 'granted' ? 'messaging consents' : 'messaging consents withdrawn');
}

/** Payment reminders: three days before a bill is due, on the day, a week and a fortnight late. */
export const REMINDER_SCHEDULES = [
  { offsetDays: -3, channels: ['whatsapp'] },
  { offsetDays: 0, channels: ['whatsapp', 'sms'] },
  { offsetDays: 7, channels: ['whatsapp'] },
  { offsetDays: 15, channels: ['whatsapp', 'sms'] },
] as const;

/** A promise to pay part of what the party owes now, by `days` from today. */
async function promise(
  context: SeedContext,
  party: SeededParty,
  share: number,
  days: number,
  note: string,
): Promise<number> {
  const sales = context.as(context.salesOf(homeOf(party)));
  const ledger = await sales.get<PartyLedgerView>(`/parties/${party.id}/ledger`);
  const amountPaise = Math.max(
    1000_00,
    Math.floor((ledger.balancePaise * share) / 1000_00) * 1000_00,
  );
  await sales.post(`/parties/${party.id}/promises`, {
    amountPaise,
    promisedOn: await context.clock.today(days),
    note,
  });
  context.count('promises to pay');
  return amountPaise;
}

/**
 * Collections and messaging (P2-M11, P2-M32): customers agree to WhatsApp and SMS at
 * the counter; the owner sets reminders before and after the due date; one dealer
 * stops paying (two bills on account, one long overdue) and breaks its promise, as
 * does the builder whose opening balance lapses; one contractor keeps its promise
 * with a bank transfer, and the site contractor promises to pay next week.
 * The nightly run settles the promises today (collectionsMorning).
 */
export function scheduleCollections(context: SeedContext, timeline: Timeline): void {
  timeline.at(context.daysAgo(0.96), async () => {
    const [first, second] = context.partiesOf('painter');
    await recordConsent(context, must(first, 'painter'), 'whatsapp', 'granted', 'te');
    await recordConsent(context, must(second, 'painter'), 'whatsapp', 'granted', 'hi');
    await recordConsent(context, siteContractor(context), 'whatsapp', 'granted', 'en');
    await recordConsent(context, promiseKeeper(context), 'whatsapp', 'granted', 'en');
    const dealer = lapsed(context, 'waived');
    await recordConsent(context, dealer, 'whatsapp', 'granted', 'te');
    await recordConsent(context, dealer, 'sms', 'granted', 'te');
  });

  timeline.at(context.daysAgo(0.9), async () => {
    await context.as('owner').put('/collections/reminder-schedules', {
      schedules: REMINDER_SCHEDULES.map((schedule) => ({ ...schedule, isActive: true })),
    });
  });

  // The dealer's two bills on account: one on a week's credit, long overdue now, and
  // one whose 30-odd days ran out a week ago (today's 7-days-late reminder).
  const dealerBill = (daysAgo: number, creditDays: number) => async () => {
    const dealer = lapsed(context, 'waived');
    const store = homeOf(dealer);
    await sell(context, store, {
      by: context.salesOf(store),
      party: dealer,
      payBy: 'credit',
      creditDays,
      lines: basket(context, store, context.random.int(30, 40) * 1000_00),
    });
  };
  const late = context.daysAgo(0.78);
  timeline.at(late, dealerBill(late, 7));
  const recent = context.daysAgo(0.62);
  timeline.at(recent, dealerBill(recent, recent - 7));

  // A promise kept: made, then paid by bank transfer before its date.
  let keptPaise = 0;
  timeline.at(12, async () => {
    keptPaise = await promise(
      context,
      promiseKeeper(context),
      0.4,
      5,
      'Will transfer after the site handover',
    );
  });
  timeline.at(9, async () => {
    const party = promiseKeeper(context);
    const store = homeOf(party);
    await context.as(context.managerOf(store)).post('/payments', {
      storeId: context.storeId(store),
      partyId: party.id,
      modeId: await paymentMode(context, 'bank_transfer'),
      amountPaise: keptPaise,
      reference: `NEFT${context.random.digits(10)}`,
    });
    context.count('payments received');
  });

  // Two promises broken: nothing comes in by their dates.
  timeline.at(9, async () => {
    await promise(
      context,
      lapsed(context, 'auto_hold'),
      0.5,
      3,
      'Half after the flats are handed over; rest next month',
    );
  });
  timeline.at(8, async () => {
    await promise(context, lapsed(context, 'waived'), 0.6, 4, 'Cheque from the builder expected');
  });

  // A promise still running: due next week.
  timeline.at(1, async () => {
    await promise(context, siteContractor(context), 0.4, 6, 'Villa payment due from the owner');
  });
}

/**
 * Before the nightly run (today): the site contractor's statement goes out on
 * WhatsApp as a stored link; another, sent to the wrong number, is revoked.
 */
export async function shareStatements(context: SeedContext): Promise<void> {
  const contractor = siteContractor(context);
  const sales = context.as(context.salesOf(homeOf(contractor)));
  const period = { from: indiaDate(context.plan.historyDays), to: indiaDate(0) };
  await sales.post(`/parties/${contractor.id}/statement/links`, {
    ...period,
    lang: 'en',
    send: 'whatsapp',
  });
  const dealer = lapsed(context, 'waived');
  const wrong = await context
    .as(context.salesOf(homeOf(dealer)))
    .post<{ link: { id: string } }>(`/parties/${dealer.id}/statement/links`, {
      ...period,
      lang: 'te',
    });
  await context
    .as(context.salesOf(homeOf(dealer)))
    .post(`/statement-links/${wrong.link.id}/revoke`);
  context.count('statement links', 2);
}

/**
 * After the nightly run (today): the dealer's branch manager acknowledges the
 * escalation of its broken promise, records a new promise for half of what it owes
 * and, the account being on automatic hold, asks for it to be released; the owner
 * releases it with the overdue block waived for two weeks while the dealer pays.
 * The builder's escalation stays open.
 */
export async function followUpEscalations(context: SeedContext): Promise<void> {
  const dealer = lapsed(context, 'waived');
  const manager = context.as(context.managerOf(homeOf(dealer)));
  const open = await manager.get<EscalationView[]>('/collections/escalations');
  const escalation = must(
    open.find((entry) => entry.party.id === dealer.id),
    'dealer escalation',
  );
  await manager.post(`/collections/escalations/${escalation.id}/acknowledge`, {
    note: 'Met the owner; the builder’s cheque is due on Friday',
  });
  // The first of the two parts, promised again this morning.
  const ledger = await manager.get<PartyLedgerView>(`/parties/${dealer.id}/ledger`);
  await manager.post(`/parties/${dealer.id}/promises`, {
    amountPaise: Math.max(1000_00, Math.floor(ledger.balancePaise / 2 / 1000_00) * 1000_00),
    promisedOn: indiaDate(-5),
    note: 'First half on Friday when the builder’s cheque clears',
  });
  context.count('promises to pay');
  const credit = await manager.get<PartyCreditSummary>(`/parties/${dealer.id}/credit`);
  if (credit.holdKind !== 'auto') return;
  const release = await manager.post('/credit-approvals', {
    kind: 'release',
    partyId: dealer.id,
    reason: 'Paying the overdue bill in two parts; needs stock for a running site',
  });
  await context.as('owner').post(`/credit-approvals/${release.id}/approve`, {
    reason: 'Released for two weeks while the overdue bill is paid',
    waiveOverdueUntil: indiaDate(-14),
  });
  context.count('holds released with a waiver');
}
