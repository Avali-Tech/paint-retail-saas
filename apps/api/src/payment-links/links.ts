import { enterTenantScope, nextDocumentNumber, schema, type Transaction } from '@paint/db';
import {
  allocateLinkPayment,
  formatDocumentNumber,
  formatINR,
  nextLinkState,
  planPaymentLink,
  type LinkPlan,
  type LinkTarget,
  type PaymentLinkDocumentView,
  type PaymentLinkOrigin,
  type PaymentLinkPaymentView,
  type PaymentLinkPurpose,
  type PaymentLinkStatus,
  type PaymentLinkSummary,
  type PaymentLinkView,
} from '@paint/shared';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { queueMessage } from '../messaging/outbox.js';
import type { Notifier } from '../notifications/notifier.js';
import type { GatewayEventContext } from '../payments-gateway/gateway-events.js';
import {
  indiaToday,
  lockParty,
  openTargets,
  receivePayment,
  type PaymentMode,
} from '../payments/posting.js';
import type {
  GatewayLinkPayment,
  PaymentLinkEvent,
  PaymentLinkProvider,
} from './payment-link-provider.js';

const {
  allocations,
  organizationMembers,
  organizations,
  parties,
  partyBalances,
  partyLedger,
  paymentLinkDocuments,
  paymentLinks,
  paymentModes,
  payments,
  stores,
  taxDocuments,
  users,
} = schema;

/** Where links come from and how long they live (PAYMENT_LINK_PROVIDER, …_EXPIRY_DAYS). */
export const PAYMENT_LINK_SETTINGS = Symbol('PAYMENT_LINK_SETTINGS');
export interface PaymentLinkSettings {
  /** Null when payment links are off. */
  readonly provider: PaymentLinkProvider | null;
  readonly expiryDays: number;
}

/** The party's open documents (oldest first), its advance and today, for planPaymentLink. */
async function partyPosition(
  tx: Transaction,
  partyId: string,
): Promise<{ open: LinkTarget[]; advancePaise: number; today: string }> {
  const open = (await openTargets(tx, partyId)).map((target) => ({
    documentId: target.documentId,
    partyLedgerId: target.partyLedgerId,
    number: target.number,
    dueOn: target.dueOn,
    outstandingPaise: target.outstandingPaise,
  }));
  const [row] = (
    await tx.execute<{ advance: string; today: string }>(sql`
    select coalesce((select b.advance_paise from ${partyBalances} b where b.party_id = ${partyId}), 0) as advance,
      ${indiaToday} as today`)
  ).rows as [{ advance: string; today: string }];
  return { open, advancePaise: Number(row.advance), today: row.today };
}

/** What a link of this purpose would ask the party for now (rules PL-2, PL-3). */
export async function planLink(
  tx: Transaction,
  input: {
    readonly partyId: string;
    readonly purpose: PaymentLinkPurpose;
    readonly documentIds?: readonly string[];
    readonly amountPaise?: number;
  },
): Promise<LinkPlan> {
  const position = await partyPosition(tx, input.partyId);
  return planPaymentLink({
    purpose: input.purpose,
    ...position,
    ...(input.documentIds === undefined ? {} : { documentIds: input.documentIds }),
    ...(input.amountPaise === undefined ? {} : { amountPaise: input.amountPaise }),
  });
}

export interface NewLink {
  readonly organizationId: string;
  readonly partyId: string;
  readonly storeId: string;
  readonly purpose: PaymentLinkPurpose;
  readonly origin: PaymentLinkOrigin;
  readonly targets: readonly LinkTarget[];
  readonly amountPaise: number;
  /** Null when the reminder run makes it. */
  readonly memberId: string | null;
}

const DESCRIPTIONS: Readonly<Record<PaymentLinkPurpose, string>> = {
  invoice: 'Invoice',
  overdue: 'Overdue bills',
  outstanding: 'Balance due',
  bills: 'Bills due',
  advance: 'Advance payment',
};

/** What the customer reads at the gateway: the shop, and what the link pays. */
function describe(business: string, link: NewLink): string {
  // An invoice link pays exactly its invoice, which has a number.
  const what =
    link.purpose === 'invoice'
      ? `Invoice ${String((link.targets as [LinkTarget])[0].number)}`
      : DESCRIPTIONS[link.purpose];
  return `${business}: ${what}`.slice(0, 200);
}

/**
 * Makes a link at the gateway and stores it with its documents (rule PL-4): numbered
 * PL-000001 in the business's own series, payable until the expiry days pass. The
 * gateway is asked inside the transaction; if the transaction then fails, the link the
 * gateway made is never stored and its webhooks are ignored.
 */
export async function createLink(
  tx: Transaction,
  settings: { readonly provider: PaymentLinkProvider; readonly expiryDays: number },
  link: NewLink,
): Promise<string> {
  const [context] = (await tx
    .select({
      business: organizations.name,
      name: parties.displayName,
      phone: parties.phone,
      expiresAt: sql<Date>`now() + make_interval(days => ${settings.expiryDays})`.mapWith(
        (value: string | Date) => new Date(value),
      ),
    })
    .from(parties)
    .innerJoin(organizations, eq(organizations.id, parties.organizationId))
    .where(eq(parties.id, link.partyId))) as [
    { business: string; name: string; phone: string | null; expiresAt: Date },
  ];
  const number = formatDocumentNumber(
    'PL',
    await nextDocumentNumber(tx, link.organizationId, 'payment_link'),
  );
  const description = describe(context.business, link);
  const created = await settings.provider.createPayment({
    reference: number,
    amountPaise: link.amountPaise,
    description,
    expiresAt: context.expiresAt,
    customer: { name: context.name, mobile: context.phone },
  });
  const [row] = (await tx
    .insert(paymentLinks)
    .values({
      organizationId: link.organizationId,
      number,
      storeId: link.storeId,
      partyId: link.partyId,
      purpose: link.purpose,
      origin: link.origin,
      amountPaise: link.amountPaise,
      description,
      provider: settings.provider.name,
      gatewayReference: created.gatewayReference,
      url: created.url,
      expiresAt: context.expiresAt,
      createdByMemberId: link.memberId,
    })
    .returning({ id: paymentLinks.id })) as [{ id: string }];
  if (link.targets.length > 0) {
    await tx.insert(paymentLinkDocuments).values(
      link.targets.map((target, position) => ({
        organizationId: link.organizationId,
        linkId: row.id,
        partyId: link.partyId,
        documentId: target.documentId,
        partyLedgerId: target.partyLedgerId,
        position,
        outstandingPaise: target.outstandingPaise,
      })),
    );
  }
  return row.id;
}

/** The documents of a link as `documentId` / `partyLedgerId` keys, in order. */
const targetKey = (target: { documentId: string | null; partyLedgerId: string | null }) =>
  String(target.documentId ?? target.partyLedgerId);

/**
 * An open link the system made earlier for exactly the same ask (rule PL-5): same
 * party, purpose, amount and documents, nothing paid, and payable for at least another
 * day. The reminder run and statement shares send it again instead of a new one.
 */
export async function reusableLink(tx: Transaction, link: NewLink): Promise<string | null> {
  const candidates = await tx
    .select({ id: paymentLinks.id })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.organizationId, link.organizationId),
        eq(paymentLinks.partyId, link.partyId),
        eq(paymentLinks.purpose, link.purpose),
        eq(paymentLinks.amountPaise, link.amountPaise),
        eq(paymentLinks.status, 'created'),
        eq(paymentLinks.paidPaise, 0),
        sql`${paymentLinks.expiresAt} > now() + interval '1 day'`,
      ),
    )
    .orderBy(desc(paymentLinks.createdAt), desc(paymentLinks.id));
  const wanted = link.targets.map(targetKey).join(',');
  for (const candidate of candidates) {
    const documents = await tx
      .select({
        documentId: paymentLinkDocuments.documentId,
        partyLedgerId: paymentLinkDocuments.partyLedgerId,
      })
      .from(paymentLinkDocuments)
      .where(eq(paymentLinkDocuments.linkId, candidate.id))
      .orderBy(asc(paymentLinkDocuments.position));
    if (documents.map(targetKey).join(',') === wanted) return candidate.id;
  }
  return null;
}

/** The status as shown: an open link past its expiry is expired. */
const shownStatus = sql<PaymentLinkStatus>`case
  when ${paymentLinks.status} = 'created' and ${paymentLinks.expiresAt} <= now() then 'expired'
  else ${paymentLinks.status}::text end`;

const summaryColumns = {
  id: paymentLinks.id,
  number: paymentLinks.number,
  storeId: paymentLinks.storeId,
  partyId: paymentLinks.partyId,
  partyName: parties.displayName,
  purpose: paymentLinks.purpose,
  origin: paymentLinks.origin,
  amountPaise: paymentLinks.amountPaise,
  paidPaise: paymentLinks.paidPaise,
  status: shownStatus,
  url: paymentLinks.url,
  expiresAt: paymentLinks.expiresAt,
  createdAt: paymentLinks.createdAt,
};

type SummaryRow = Omit<PaymentLinkSummary, 'expiresAt' | 'createdAt'> & {
  expiresAt: Date;
  createdAt: Date;
};

const summaryOf = (row: SummaryRow): PaymentLinkSummary => ({
  ...row,
  expiresAt: row.expiresAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/** A page of links, newest first. */
export async function linkSummaries(
  tx: Transaction,
  where: SQL | undefined,
  page: { readonly limit: number; readonly offset: number },
): Promise<{ items: PaymentLinkSummary[]; total: number }> {
  const rows = await tx
    .select(summaryColumns)
    .from(paymentLinks)
    .innerJoin(parties, eq(parties.id, paymentLinks.partyId))
    .where(where)
    .orderBy(desc(paymentLinks.createdAt), desc(paymentLinks.id))
    .limit(page.limit)
    .offset(page.offset);
  const [count] = (await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(paymentLinks)
    .innerJoin(parties, eq(parties.id, paymentLinks.partyId))
    .where(where)) as [{ total: number }];
  return { items: rows.map(summaryOf), total: count.total };
}

/** The link (none when there is no such link) with its documents and payments. */
export async function linkView(tx: Transaction, linkId: string): Promise<PaymentLinkView[]> {
  const [row] = await tx
    .select({
      ...summaryColumns,
      description: paymentLinks.description,
      provider: paymentLinks.provider,
      paidAt: paymentLinks.paidAt,
      cancelledAt: paymentLinks.cancelledAt,
      createdBy: users.fullName,
    })
    .from(paymentLinks)
    .innerJoin(parties, eq(parties.id, paymentLinks.partyId))
    .leftJoin(organizationMembers, eq(organizationMembers.id, paymentLinks.createdByMemberId))
    .leftJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(paymentLinks.id, linkId));
  if (!row) return [];
  const documents: PaymentLinkDocumentView[] = await tx
    .select({
      documentId: paymentLinkDocuments.documentId,
      partyLedgerId: paymentLinkDocuments.partyLedgerId,
      number: sql<string | null>`coalesce(${taxDocuments.number}, ${partyLedger.note})`,
      outstandingPaise: paymentLinkDocuments.outstandingPaise,
    })
    .from(paymentLinkDocuments)
    .leftJoin(taxDocuments, eq(taxDocuments.id, paymentLinkDocuments.documentId))
    .leftJoin(partyLedger, eq(partyLedger.id, paymentLinkDocuments.partyLedgerId))
    .where(eq(paymentLinkDocuments.linkId, linkId))
    .orderBy(asc(paymentLinkDocuments.position));
  const paid: PaymentLinkPaymentView[] = await tx
    .select({
      id: payments.id,
      number: payments.number,
      amountPaise: payments.amountPaise,
      receivedOn: payments.receivedOn,
      advancePaise: sql<number>`${payments.amountPaise} - coalesce((select sum(a.amount_paise)
        from ${allocations} a where a.payment_id = ${sql.raw('"payments"."id"')}), 0)`.mapWith(
        Number,
      ),
    })
    .from(payments)
    .where(eq(payments.paymentLinkId, linkId))
    .orderBy(asc(payments.createdAt), asc(payments.id));
  const { paidAt, cancelledAt, expiresAt, createdAt, ...rest } = row;
  return [
    {
      ...rest,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString(),
      paidAt: paidAt?.toISOString() ?? null,
      cancelledAt: cancelledAt?.toISOString() ?? null,
      documents,
      payments: paid,
    },
  ];
}

/**
 * The business's UPI link payment mode, made the first time a link is paid (a
 * migration cannot make it: the kind is new in the same migration). Kept even when
 * switched off, since the money came anyway.
 */
export async function upiLinkMode(tx: Transaction, organizationId: string): Promise<PaymentMode> {
  const find = async () => {
    const [mode] = await tx
      .select({ id: paymentModes.id, kind: paymentModes.kind, name: paymentModes.name })
      .from(paymentModes)
      .where(
        and(eq(paymentModes.organizationId, organizationId), eq(paymentModes.kind, 'upi_link')),
      )
      .orderBy(desc(paymentModes.isActive), asc(paymentModes.createdAt), asc(paymentModes.id))
      .limit(1);
    return mode;
  };
  // "UPI link", or, when the business already named another mode so, a name of its own.
  for (const name of ['UPI link', 'UPI payment link (gateway)']) {
    const found = await find();
    if (found) return found;
    await tx
      .insert(paymentModes)
      .values({ organizationId, kind: 'upi_link', name })
      .onConflictDoNothing();
  }
  return (await find()) as PaymentMode;
}

/** India date of a gateway's payment time, never after today. */
async function receivedOnOf(tx: Transaction, paidAt: Date): Promise<string> {
  const [row] = (
    await tx.execute<{ day: string }>(sql`
    select least((${paidAt.toISOString()}::timestamptz at time zone 'Asia/Kolkata')::date,
      (now() at time zone 'Asia/Kolkata')::date)::text as day`)
  ).rows as [{ day: string }];
  return row.day;
}

type LinkRow = typeof paymentLinks.$inferSelect;

/**
 * Applies a verified gateway event to its link (rules PL-6 – PL-11), inside
 * receiveGatewayWebhook's transaction, which stores the event once. The link is found
 * by the gateway's id outside tenant scope (as a public statement link is), the event
 * is attached to its business, and the rest runs in that business's tenant scope.
 *
 * A payment is recorded at the link's store with the UPI link mode, never in a
 * register; it pays the link's documents oldest first, each up to what is owed now,
 * and the rest is an advance. A payment the business already has (the same gateway
 * payment reported by another event) is ignored. An expiry or cancellation ends only
 * an open link, so the order events arrive in does not matter.
 */
export async function applyLinkEvent(
  tx: Transaction,
  event: PaymentLinkEvent,
  context: GatewayEventContext,
  deps: { readonly provider: PaymentLinkProvider; readonly notifier: Notifier },
): Promise<'applied' | 'ignored'> {
  if (event.kind === 'ignored') return 'ignored';
  const [found] = await tx
    .select({ id: paymentLinks.id, organizationId: paymentLinks.organizationId })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.provider, deps.provider.name),
        eq(paymentLinks.gatewayReference, event.gatewayLinkId),
      ),
    );
  if (!found) return 'ignored';
  await context.attach(found.organizationId);
  await enterTenantScope(tx, found.organizationId);
  const [{ partyId }] = (await tx
    .select({ partyId: paymentLinks.partyId })
    .from(paymentLinks)
    .where(eq(paymentLinks.id, found.id))) as [{ partyId: string }];
  // Party first, then the link (posting.ts order): two payments of one link queue up.
  await lockParty(tx, found.organizationId, partyId);
  const [link] = (await tx
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.id, found.id))
    .for('update')) as [LinkRow];

  if (event.kind !== 'paid') {
    const next = nextLinkState(link, event.kind);
    if (next.status === link.status) return 'ignored';
    await tx
      .update(paymentLinks)
      .set({
        status: next.status,
        updatedAt: sql`now()`,
        ...(next.status === 'cancelled' ? { cancelledAt: sql`now()` } : {}),
      })
      .where(eq(paymentLinks.id, link.id));
    return 'applied';
  }

  const payment = event.payment;
  const [already] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, link.organizationId),
        eq(payments.gatewayReference, payment.id),
        sql`${payments.paymentLinkId} is not null`,
      ),
    );
  if (already) return 'ignored';
  await recordLinkPayment(tx, link, payment, deps.notifier);
  return 'applied';
}

async function recordLinkPayment(
  tx: Transaction,
  link: LinkRow,
  payment: GatewayLinkPayment,
  notifier: Notifier,
): Promise<void> {
  const organizationId = link.organizationId;
  const documents = await tx
    .select({
      documentId: paymentLinkDocuments.documentId,
      partyLedgerId: paymentLinkDocuments.partyLedgerId,
    })
    .from(paymentLinkDocuments)
    .where(eq(paymentLinkDocuments.linkId, link.id))
    .orderBy(asc(paymentLinkDocuments.position));
  // What is owed on each now: something else may have paid it since the link was made.
  const open = await openTargets(tx, link.partyId);
  const targets: LinkTarget[] = documents.map((document) => {
    const now = open.find((target) => targetKey(target) === targetKey(document));
    return {
      ...document,
      number: now?.number ?? null,
      dueOn: now?.dueOn ?? null,
      outstandingPaise: now?.outstandingPaise ?? 0,
    };
  });
  const plan = allocateLinkPayment(targets, payment.amountPaise);
  const [store] = (await tx
    .select({
      id: stores.id,
      code: stores.code,
      gstin: sql<
        string | null
      >`case when ${stores.registrationType} <> 'unregistered' then ${stores.gstin} end`,
    })
    .from(stores)
    .where(eq(stores.id, link.storeId))) as [{ id: string; code: string; gstin: string | null }];
  const row = await receivePayment(
    tx,
    { organization: { id: organizationId }, memberId: null },
    {
      store,
      partyId: link.partyId,
      mode: await upiLinkMode(tx, organizationId),
      details: {
        amountPaise: payment.amountPaise,
        reference: payment.id.slice(0, 100),
        gatewayReference: payment.id,
        note: `Paid by UPI link ${link.number}`,
      },
      receivedOn: await receivedOnOf(tx, payment.paidAt),
      registerSessionId: null,
      paymentLinkId: link.id,
    },
    plan.allocations,
  );
  const next = nextLinkState(link, 'paid', payment.amountPaise);
  await tx
    .update(paymentLinks)
    .set({
      status: next.status,
      paidPaise: next.paidPaise,
      updatedAt: sql`now()`,
      ...(next.status === 'paid' && link.status !== 'paid' ? { paidAt: sql`now()` } : {}),
    })
    .where(eq(paymentLinks.id, link.id));
  await tellStaff(tx, notifier, link, row, plan.advancePaise, targets.length > 0);
  // The customer's receipt, when they agreed to WhatsApp messages (MSG-1).
  await queueMessage(tx, {
    organizationId,
    partyId: link.partyId,
    channel: 'whatsapp',
    templateKey: 'receipt_issued',
    variables: { number: row.number, amount: formatINR(payment.amountPaise) },
    reference: { type: 'payment', id: row.id },
    dedupeKey: `receipt:${row.id}`,
    memberId: null,
  });
}

/**
 * The paid-link notice to who takes payments at the link's store (rule PL-10). Money
 * for bills already paid some other way, or more than they owed, is an advance: the
 * notice says so, so someone refunds or allocates it.
 */
async function tellStaff(
  tx: Transaction,
  notifier: Notifier,
  link: LinkRow,
  payment: { id: string; number: string; amountPaise: number },
  advancePaise: number,
  hadDocuments: boolean,
): Promise<void> {
  const [party] = (await tx
    .select({ name: parties.displayName })
    .from(parties)
    .where(eq(parties.id, link.partyId))) as [{ name: string }];
  const allocated = payment.amountPaise - advancePaise;
  const settled = hadDocuments && allocated === 0;
  const title = settled
    ? `UPI link paid for bills already settled: ${party.name}`
    : `Paid by UPI link: ${party.name}`;
  const parts = [
    `${formatINR(payment.amountPaise)} received for ${link.number}, recorded as ${payment.number}.`,
  ];
  if (advancePaise > 0 && hadDocuments) {
    parts.push(`${formatINR(advancePaise)} is kept as an advance: refund or allocate it.`);
  }
  await notifier.notify(tx, {
    organizationId: link.organizationId,
    event: 'payment_link_paid',
    to: { storeId: link.storeId, permission: 'payments:manage' },
    title,
    body: parts.join(' '),
    link: `/payments/${payment.id}`,
  });
}
