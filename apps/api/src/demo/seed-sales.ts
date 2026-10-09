import { toCsv, type IssuedInvoiceView, type PartyLedgerView } from '@paint/shared';
import { indiaDate } from './history-clock.js';
import { STORE_KEYS, type StoreKey } from './plan.js';
import { creditStories, type CreditStory } from './seed-accounts.js';
import { basket, paymentMode, sell, type BasketLine, type PayBy } from './seed-billing.js';
import { must, type SeedContext, type SeededParty, type Timeline } from './seed-context.js';

const COUNTER_MODES: readonly PayBy[] = ['cash', 'cash', 'upi', 'upi', 'card'];
/** A register's opening float, in paise. */
const FLOAT_PAISE = 2_000_00;

const counterOf = (store: StoreKey) => `counter${store.charAt(0)}${store.slice(1).toLowerCase()}`;
const homeOf = (party: SeededParty): StoreKey =>
  must(party.homeStore, `home store of ${party.key}`);
const rupees = (paise: number) => (paise / 100).toFixed(2);

/**
 * Billing goes live on the first day of the history, with the old books'
 * balances imported (spec §4.7, [PO-5]); from then on every sale is an
 * invoice: counter sales at each branch with the register opened and closed,
 * credit customers billed on account and paying by bank transfer and cheque
 * (one bounces), returns to stock and to damage, a discount credit note and a
 * debit note, and quotations that become orders holding stock.
 */
export function scheduleSales(context: SeedContext, timeline: Timeline): void {
  const { plan } = context;
  const stories = creditStories(context);
  // Credit customers still billed on account: not the one at its limit, not the one on hold.
  const billed = stories.filter((story) => !story.nearLimit && !story.onHold);
  const creditBills: { invoice: IssuedInvoiceView; store: StoreKey; lines: BasketLine[] }[] = [];

  timeline.at(plan.historyDays, () => goLive(context, stories));
  for (let daysAgo = plan.historyDays - 1; daysAgo >= 1; daysAgo--) {
    timeline.at(daysAgo, () => counterDay(context, daysAgo));
  }
  billed.forEach((story, index) => {
    // On account once the credit is approved (seed-accounts.ts).
    for (let day = context.daysAgo(0.85) - (index % 5); day >= 1; day -= 9 + (index % 4)) {
      timeline.at(day, async () => {
        const store = homeOf(story.party);
        const lines = basket(context, store, context.random.int(8, 25) * 1000_00);
        const invoice = await sell(context, store, {
          by: context.salesOf(store),
          party: story.party,
          payBy: 'credit',
          creditDays: story.days,
          lines,
        });
        creditBills.push({ invoice, store, lines });
      });
    }
    const firstPayment = context.daysAgo(0.8) - (index % 3);
    for (let day = firstPayment; day >= 1; day -= 14) {
      timeline.at(day, () => receive(context, story, index, day === firstPayment));
    }
  });
  scheduleNotes(context, timeline, creditBills);
  scheduleOrders(context, timeline);
}

/** The opening balances from the old books, imported, then the cut-over itself. */
async function goLive(context: SeedContext, stories: readonly CreditStory[]): Promise<void> {
  const owner = context.as('owner');
  const goLiveDay = context.plan.historyDays;
  const rows = stories.map((story) => {
    const owedPaise = Math.round(story.limitRupees * (story.nearLimit ? 0.94 : story.used)) * 100;
    const overdueDays = story.onHold ? 75 : story.overdueDays;
    return [
      story.party.phone,
      '',
      story.party.displayName,
      rupees(owedPaise),
      overdueDays > 0 ? indiaDate(goLiveDay + overdueDays) : '',
    ];
  });
  const csv = toCsv([['phone', 'gstin', 'name', 'opening_balance', 'overdue_since'], ...rows]);
  await owner.post('/imports/opening-balances/preview', { csv });
  await owner.post('/imports/opening-balances', { csv });
  // Dated on the history's first day, as are the opening balances (the history clock leaves them).
  await owner.post('/sales/go-live', { liveOn: indiaDate(goLiveDay) });
  context.count('opening balances', rows.length);
}

/**
 * A day at each counter: the register opened with a float, a few bills
 * (walk-ins and regulars; cash, UPI and card), then counted and closed. On
 * one day Kukatpally's drawer is ₹20 short.
 */
async function counterDay(context: SeedContext, daysAgo: number): Promise<void> {
  const { random } = context;
  for (const store of STORE_KEYS) {
    const counter = context.as(counterOf(store));
    const session = await counter.post(`/registers/COUNTER1/open`, {
      storeId: context.storeId(store),
      openingFloatPaise: FLOAT_PAISE,
    });
    const regulars = context.partiesOf('retail').filter((party) => party.homeStore === store);
    const bills = context.plan.size === 'full' ? random.int(1, 3) : 1;
    for (let bill = 0; bill < bills; bill++) {
      const party = random.chance(0.4) && regulars.length > 0 ? random.pick(regulars) : undefined;
      await sell(context, store, {
        by: counterOf(store),
        ...(party === undefined ? {} : { party }),
        payBy: random.pick(COUNTER_MODES),
        lines: basket(context, store, random.int(4, 30) * 100_00),
      });
    }
    // The customer across the border in Andhra Pradesh: an inter-state (IGST) bill.
    if (daysAgo === context.plan.historyDays - 1 && store === 'AMP') {
      await sell(context, store, {
        by: counterOf(store),
        party: context.party('retail-1'),
        payBy: 'upi',
        lines: basket(context, store, 6_000_00),
      });
    }
    const open = await counter.get<{ expectedCashPaise: number }>(
      `/register-sessions/${session.id}`,
    );
    const short = store === 'KPL' && daysAgo === context.daysAgo(0.2) ? 20_00 : 0;
    await counter.post(`/register-sessions/${session.id}/close`, {
      countedCashPaise: open.expectedCashPaise - short,
      ...(short > 0 ? { note: 'Short by ₹20; checked the day’s bills' } : {}),
    });
    context.count('register sessions');
  }
}

/**
 * A credit customer pays part of what it owes by bank transfer, allocated to
 * its oldest bills first. The first payments of two customers come by cheque:
 * one clears, the other bounces and the balance goes back up.
 */
async function receive(
  context: SeedContext,
  story: CreditStory,
  index: number,
  first: boolean,
): Promise<void> {
  const store = homeOf(story.party);
  const manager = context.as(context.managerOf(store));
  const ledger = await manager.get<PartyLedgerView>(`/parties/${story.party.id}/ledger`);
  const amountPaise =
    Math.round((ledger.balancePaise * context.random.int(40, 80)) / 100 / 100) * 100;
  const cheque = first && index < 2;
  const payment = await manager.post('/payments', {
    storeId: context.storeId(store),
    partyId: story.party.id,
    modeId: await paymentMode(context, cheque ? 'cheque' : 'bank_transfer'),
    amountPaise,
    reference: cheque
      ? String(context.random.int(100_000, 999_999))
      : `NEFT${context.random.digits(10)}`,
    ...(cheque ? { chequeDate: await context.clock.today() } : {}),
  });
  if (cheque && index === 0) await manager.post(`/payments/${payment.id}/clear`, {});
  if (cheque && index === 1) {
    await manager.post(`/payments/${payment.id}/bounce`, {
      reason: 'Returned: funds insufficient',
    });
  }
  context.count('payments received');
}

/** Goods back to stock and to damage, a discount after the sale, and an undercharge. */
function scheduleNotes(
  context: SeedContext,
  timeline: Timeline,
  creditBills: readonly { invoice: IssuedInvoiceView; store: StoreKey; lines: BasketLine[] }[],
): void {
  const bill = (index: number) => must(creditBills[index], 'credit bill');
  const returning = (index: number, disposition: 'restock' | 'damage') => async () => {
    const { invoice, store } = bill(index);
    const line = must(invoice.lines[0], 'invoice line');
    await context.as(context.managerOf(store)).post('/sales-returns', {
      invoiceId: invoice.id,
      lines: [
        {
          invoiceLineId: line.id,
          quantity: 1,
          disposition,
          reason: disposition === 'restock' ? 'Wrong shade picked' : 'Tin dented in delivery',
        },
      ],
    });
    // Damaged goods come back and go straight out again as damage.
    if (disposition === 'restock') context.move(store, line.variantId, 1);
    context.count('sales returns');
  };
  timeline.at(context.daysAgo(0.6), returning(0, 'restock'));
  timeline.at(context.daysAgo(0.45), returning(1, 'damage'));
  timeline.at(context.daysAgo(0.5), async () => {
    const { invoice, store } = bill(2);
    const line = must(invoice.lines[0], 'invoice line');
    await context.as(context.managerOf(store)).post('/credit-notes', {
      invoiceId: invoice.id,
      reason: 'discount',
      schemeReference: 'Monsoon contractor scheme 2026',
      lines: [
        { invoiceLineId: line.id, valuePaise: Math.max(100, Math.round(line.totalPaise / 10)) },
      ],
    });
    context.count('credit notes');
  });
  timeline.at(context.daysAgo(0.35), async () => {
    const { invoice, store } = bill(3);
    const line = must(invoice.lines[0], 'invoice line');
    await context.as(context.managerOf(store)).post('/debit-notes', {
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId: line.id, valuePaise: Math.max(100, Math.round(line.totalPaise / 20)) },
      ],
      note: 'Rate revision missed on the bill',
    });
    context.count('debit notes');
  });
}

interface OrderView {
  readonly id: string;
  readonly lines: readonly {
    id: string;
    variantId: string;
    quantity: number;
    unitPricePaise: number;
  }[];
}

/**
 * Quotations and orders: one quoted, ordered and paid in advance, its first
 * line billed and the rest still holding stock; one order taken today
 * waiting for its payment, holding stock; one quotation still with the customer.
 */
function scheduleOrders(context: SeedContext, timeline: Timeline): void {
  const reserve = (store: StoreKey, order: OrderView) => {
    for (const line of order.lines) context.move(store, line.variantId, -line.quantity);
  };
  let quoted = '';
  let ordered: OrderView | null = null;
  const start = context.daysAgo(0.5);
  const flat = () => must(context.partiesOf('retail')[2], 'retail customer');
  timeline.at(start, async () => {
    const store = homeOf(flat());
    const sales = context.as(context.salesOf(store));
    const lines = basket(context, store, 30_000_00);
    // Set aside now, so the counter does not sell what the order will hold.
    for (const line of lines) context.move(store, line.variantId, -line.quantity);
    const quotation = await sales.post('/quotations', {
      storeId: context.storeId(store),
      billToPartyId: flat().id,
      note: 'Three-bedroom flat, interior repaint',
      lines,
    });
    await sales.post(`/quotations/${quotation.id}/send`);
    quoted = quotation.id;
    context.count('quotations');
  });
  timeline.at(start - 1, async () => {
    const store = homeOf(flat());
    const sales = context.as(context.salesOf(store));
    const order = await sales.post<OrderView>(`/quotations/${quoted}/convert`, {
      paymentTerms: 'prepaid',
    });
    ordered = await sales.post<OrderView>(`/sales-orders/${order.id}/confirm`);
    context.count('sales orders');
  });
  timeline.at(start - 2, async () => {
    const order = must(ordered, 'order');
    const line = must(order.lines[0], 'order line');
    const sales = context.as(context.salesOf(homeOf(flat())));
    const draft = await sales.post(`/sales-orders/${order.id}/invoices`, {
      lines: [{ orderLineId: line.id, quantity: line.quantity }],
    });
    await sales.post(`/invoices/${draft.id}/issue`, {
      payments: [
        {
          modeId: await paymentMode(context, 'upi'),
          amountPaise: line.quantity * line.unitPricePaise,
        },
      ],
    });
    context.count('invoices');
  });
  timeline.at(2, async () => {
    const customer = must(context.partiesOf('retail')[3], 'retail customer');
    const store = homeOf(customer);
    const sales = context.as(context.salesOf(store));
    const order = await sales.post<OrderView>('/sales-orders', {
      storeId: context.storeId(store),
      billToPartyId: customer.id,
      paymentTerms: 'prepaid',
      note: 'Collecting on Saturday after paying online',
      lines: basket(context, store, 12_000_00),
    });
    reserve(store, await sales.post<OrderView>(`/sales-orders/${order.id}/confirm`));
    context.count('sales orders');
  });
  timeline.at(1, async () => {
    const contractor = must(context.partiesOf('contractor')[1], 'contractor');
    const store = homeOf(contractor);
    const sales = context.as(context.salesOf(store));
    const quotation = await sales.post('/quotations', {
      storeId: context.storeId(store),
      billToPartyId: contractor.id,
      note: 'Villa exterior, two coats',
      lines: basket(context, store, 45_000_00),
    });
    await sales.post(`/quotations/${quotation.id}/send`);
    context.count('quotations');
  });
}
