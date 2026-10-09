import 'reflect-metadata';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  adjustPartyAdvance,
  postPartyLedger,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { formatINR, type PaymentPage, type PaymentView, type ReceiptView } from '@paint/shared';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { idempotent } from '../billing/idempotency.js';
import {
  afterKey,
  cappedTotal,
  cursorTime,
  keysetSlice,
  NEWEST_FIRST,
  pageOffset,
} from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { Notifier } from '../notifications/notifier.js';
import { containsPattern } from '../parties/party-access.js';
import { fieldError } from '../tax/tax-lookups.js';
import { loadPayment, paymentView, receiptView } from './payment-view.js';
import type {
  AllocatePaymentInput,
  BounceChequeInput,
  ClearChequeInput,
  ListPaymentsQuery,
  RecordPaymentInput,
  RefundInput,
} from './payments.schemas.js';
import {
  activeMode,
  activeParty,
  checkDetails,
  indiaToday,
  insertAllocations,
  insertPayment,
  lockParty,
  paymentStore,
  planAllocations,
  receivePayment,
  refusal,
  registerSessionFor,
  unallocatedOf,
  walkInPartyId,
  type PaymentRow,
} from './posting.js';

const { allocations, parties, paymentModes, payments } = schema;

/**
 * Money received from parties and refunded to them (spec §4.4, §4.6, §5.1):
 * payments with receipt numbers, allocation to bills, cheques that clear or
 * bounce, and refunds. Every change locks the party first (see posting.ts).
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  record(
    auth: AuthContext,
    input: RecordPaymentInput,
    idempotencyKey?: string,
  ): Promise<PaymentView> {
    const request = { method: 'POST', path: '/payments', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, () => this.recordIn(tx, auth, input)),
    );
  }

  allocate(auth: AuthContext, id: string, input: AllocatePaymentInput): Promise<PaymentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const payment = await this.lockedPayment(tx, auth, id);
      if (payment.direction !== 'in' || payment.chequeStatus === 'bounced') {
        throw new ConflictException('Only money received, and not bounced, can be allocated');
      }
      const left = await unallocatedOf(tx, payment);
      if (left === 0) throw new ConflictException('This payment is already fully allocated');
      const plan = await planAllocations(
        tx,
        payment.partyId,
        left,
        input.allocations,
        'allocations',
      );
      if (plan.length === 0)
        throw new ConflictException('This customer has no bills with money due');
      const used = await insertAllocations(tx, auth, payment.partyId, payment.id, plan);
      await adjustPartyAdvance(tx, payment.partyId, -used);
      return paymentView(tx, payment);
    });
  }

  /** Undoes one allocation with a negative row; the money becomes an advance again. */
  reverseAllocation(auth: AuthContext, id: string, allocationId: string): Promise<PaymentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const payment = await this.lockedPayment(tx, auth, id);
      const [row] = await tx
        .select({
          id: allocations.id,
          amountPaise: allocations.amountPaise,
          documentId: allocations.documentId,
          partyLedgerId: allocations.partyLedgerId,
          refundPaymentId: allocations.refundPaymentId,
          reversed: sql<boolean>`exists (select 1 from ${allocations} r where r.reverses_allocation_id = ${sql.raw('"allocations"."id"')})`,
        })
        .from(allocations)
        .where(and(eq(allocations.id, allocationId), eq(allocations.paymentId, id)));
      if (!row || row.amountPaise < 0 || row.refundPaymentId !== null) {
        throw fieldError('allocationId', 'Not an allocation of this payment to a bill');
      }
      if (row.reversed) throw new ConflictException('This allocation is already undone');
      await tx.insert(allocations).values({
        organizationId: auth.organization.id,
        partyId: payment.partyId,
        paymentId: id,
        documentId: row.documentId,
        partyLedgerId: row.partyLedgerId,
        amountPaise: -row.amountPaise,
        reversesAllocationId: row.id,
        createdByMemberId: auth.memberId,
      });
      await adjustPartyAdvance(tx, payment.partyId, row.amountPaise);
      return paymentView(tx, payment);
    });
  }

  clear(auth: AuthContext, id: string, input: ClearChequeInput): Promise<PaymentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const payment = await this.pendingCheque(tx, auth, id);
      const clearedOn = await this.businessDate(
        tx,
        input.clearedOn,
        payment.receivedOn,
        'clearedOn',
      );
      const [cleared] = (await tx
        .update(payments)
        .set({ chequeStatus: 'cleared', chequeClearedOn: clearedOn })
        .where(eq(payments.id, id))
        .returning()) as [PaymentRow];
      return paymentView(tx, cleared);
    });
  }

  /**
   * The bank returned the cheque (spec §4.6): its allocations are undone, the
   * party owes the amount again (`cheque_bounce`), and a bounce charge, when
   * given, is added as a charge the party owes (a non-GST recovery, [CA-11]).
   */
  bounce(auth: AuthContext, id: string, input: BounceChequeInput): Promise<PaymentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const organizationId = auth.organization.id;
      const payment = await this.pendingCheque(tx, auth, id);
      const bouncedOn = await this.businessDate(
        tx,
        input.bouncedOn,
        payment.receivedOn,
        'bouncedOn',
      );
      const left = await unallocatedOf(tx, payment);
      const live = await tx
        .select({
          id: allocations.id,
          amountPaise: allocations.amountPaise,
          documentId: allocations.documentId,
          partyLedgerId: allocations.partyLedgerId,
        })
        .from(allocations)
        .where(
          and(
            eq(allocations.paymentId, id),
            sql`${allocations.amountPaise} > 0`,
            sql`not exists (select 1 from ${allocations} r where r.reverses_allocation_id = ${sql.raw('"allocations"."id"')})`,
          ),
        );
      if (live.length > 0) {
        await tx.insert(allocations).values(
          live.map((row) => ({
            organizationId,
            partyId: payment.partyId,
            paymentId: id,
            documentId: row.documentId,
            partyLedgerId: row.partyLedgerId,
            amountPaise: -row.amountPaise,
            reversesAllocationId: row.id,
            createdByMemberId: auth.memberId,
          })),
        );
      }
      const [bounced] = (await tx
        .update(payments)
        .set({ chequeStatus: 'bounced', chequeBouncedOn: bouncedOn, bounceReason: input.reason })
        .where(eq(payments.id, id))
        .returning()) as [PaymentRow];
      const entry = {
        organizationId,
        partyId: payment.partyId,
        storeId: payment.storeId,
        entryOn: bouncedOn,
        referenceType: 'payment',
        referenceId: id,
        createdByMemberId: auth.memberId,
      };
      await postPartyLedger(tx, [
        {
          ...entry,
          entryType: 'cheque_bounce',
          amountPaise: payment.amountPaise,
          note: `${payment.number} bounced: ${input.reason}`,
        },
        ...(input.chargePaise === undefined
          ? []
          : [
              {
                ...entry,
                entryType: 'adjustment' as const,
                amountPaise: input.chargePaise,
                note: `Cheque bounce charge, ${payment.number}`,
              },
            ]),
      ]);
      // The unallocated part no longer counts as an advance.
      await adjustPartyAdvance(tx, payment.partyId, -left);
      const [party] = (await tx
        .select({ name: parties.displayName })
        .from(parties)
        .where(eq(parties.id, payment.partyId))) as [{ name: string }];
      await this.notifier.notify(tx, {
        organizationId,
        event: 'cheque_bounced',
        to: { storeId: payment.storeId, permission: 'payments:manage' },
        actorMemberId: auth.memberId,
        title: `Cheque bounced: ${party.name}`,
        body: `${payment.number}, cheque ${String(payment.reference)} for ${formatINR(payment.amountPaise)}: ${input.reason}`,
        link: `/payments/${id}`,
      });
      return paymentView(tx, bounced);
    });
  }

  /** Pays back money a payment has not allocated (an advance or an overpayment). */
  refund(
    auth: AuthContext,
    id: string,
    input: RefundInput,
    idempotencyKey?: string,
  ): Promise<PaymentView> {
    const request = { method: 'POST', path: `/payments/${id}/refund`, body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        const source = await this.lockedPayment(tx, auth, id);
        if (source.direction !== 'in' || source.chequeStatus === 'bounced') {
          throw new ConflictException('Only money received, and not bounced, can be refunded');
        }
        if (source.chequeStatus === 'pending') {
          throw new ConflictException('A cheque is refunded only after it clears');
        }
        const left = await unallocatedOf(tx, source);
        if (input.amountPaise > left) {
          throw refusal('amountPaise', `Only ${formatINR(left)} of this payment is not allocated`);
        }
        const store = await paymentStore(tx, auth, source.storeId, 'storeId');
        const mode = await activeMode(tx, input.modeId, 'modeId');
        checkDetails(mode, input, '');
        const paidOn = await this.businessDate(tx, input.paidOn, source.receivedOn, 'paidOn');
        const registerSessionId = await registerSessionFor(
          tx,
          store.id,
          mode.kind,
          input.registerSessionId,
          'registerSessionId',
        );
        const refund = await insertPayment(tx, auth, {
          store,
          partyId: source.partyId,
          mode,
          direction: 'out',
          details: input,
          receivedOn: paidOn,
          registerSessionId,
          // Paying back an advance that had a receipt voucher needs a refund voucher (Rule 51).
          voucherKind: source.voucherNumber === null ? null : 'refund_voucher',
        });
        await tx.insert(allocations).values({
          organizationId: auth.organization.id,
          partyId: source.partyId,
          paymentId: source.id,
          refundPaymentId: refund.id,
          amountPaise: input.amountPaise,
          createdByMemberId: auth.memberId,
        });
        await adjustPartyAdvance(tx, source.partyId, -input.amountPaise);
        return paymentView(tx, refund);
      }),
    );
  }

  get(auth: AuthContext, id: string): Promise<PaymentView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      paymentView(tx, await loadPayment(tx, auth, id)),
    );
  }

  receipt(auth: AuthContext, id: string): Promise<ReceiptView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      receiptView(tx, await loadPayment(tx, auth, id)),
    );
  }

  list(auth: AuthContext, query: ListPaymentsQuery): Promise<PaymentPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const pattern = query.q === undefined ? null : containsPattern(query.q);
      const where = and(
        auth.allStores ? undefined : inArray(payments.storeId, [...auth.storeIds]),
        query.storeId ? eq(payments.storeId, query.storeId) : undefined,
        query.partyId ? eq(payments.partyId, query.partyId) : undefined,
        query.direction ? eq(payments.direction, query.direction) : undefined,
        query.modeKind ? eq(payments.modeKind, query.modeKind) : undefined,
        query.chequeStatus ? eq(payments.chequeStatus, query.chequeStatus) : undefined,
        query.from ? sql`${payments.receivedOn} >= ${query.from}::date` : undefined,
        query.to ? sql`${payments.receivedOn} <= ${query.to}::date` : undefined,
        pattern === null
          ? undefined
          : or(
              ilike(payments.number, pattern),
              ilike(payments.voucherNumber, pattern),
              ilike(payments.reference, pattern),
            ),
      );
      const rows = await tx
        .select({
          id: payments.id,
          number: payments.number,
          voucherNumber: payments.voucherNumber,
          direction: payments.direction,
          storeId: payments.storeId,
          partyId: payments.partyId,
          partyName: parties.displayName,
          modeKind: payments.modeKind,
          modeName: paymentModes.name,
          amountPaise: payments.amountPaise,
          receivedOn: payments.receivedOn,
          chequeStatus: payments.chequeStatus,
          unallocatedPaise: sql<number>`case
            when ${payments.direction} = 'in' and ${payments.chequeStatus} is distinct from 'bounced'
            then ${payments.amountPaise} - coalesce((select sum(a.amount_paise) from ${allocations} a where a.payment_id = ${sql.raw('"payments"."id"')}), 0)
            else 0 end`.mapWith(Number),
          cursorAt: cursorTime(payments.createdAt),
        })
        .from(payments)
        .innerJoin(parties, eq(parties.id, payments.partyId))
        .innerJoin(paymentModes, eq(paymentModes.id, payments.modeId))
        .where(and(where, afterKey(NEWEST_FIRST, [payments.createdAt, payments.id], query.cursor)))
        .orderBy(desc(payments.createdAt), desc(payments.id))
        .limit(query.limit + 1)
        .offset(pageOffset(query));
      const page = keysetSlice(rows, query.limit, (row) => [row.cursorAt, row.id]);
      return {
        items: page.rows.map(({ cursorAt, ...item }) => item),
        nextCursor: page.nextCursor,
        ...(await cappedTotal(
          tx,
          tx.select({ id: payments.id }).from(payments).where(where).$dynamic(),
        )),
      };
    });
  }

  // Helpers -----------------------------------------------------------------

  private async recordIn(
    tx: Transaction,
    auth: AuthContext,
    input: RecordPaymentInput,
  ): Promise<PaymentView> {
    const store = await paymentStore(tx, auth, input.storeId, 'storeId');
    await activeParty(tx, input.partyId, 'partyId');
    if (input.partyId === (await walkInPartyId(tx))) {
      throw refusal('partyId', 'Walk-in customers pay with their bill at the counter');
    }
    const mode = await activeMode(tx, input.modeId, 'modeId');
    checkDetails(mode, input, '');
    await lockParty(tx, auth.organization.id, input.partyId);
    const receivedOn = await this.businessDate(tx, input.receivedOn, null, 'receivedOn');
    const registerSessionId = await registerSessionFor(
      tx,
      store.id,
      mode.kind,
      input.registerSessionId,
      'registerSessionId',
    );
    const plan = await planAllocations(
      tx,
      input.partyId,
      input.amountPaise,
      input.allocations,
      'allocations',
    );
    const payment = await receivePayment(
      tx,
      auth,
      { store, partyId: input.partyId, mode, details: input, receivedOn, registerSessionId },
      plan,
    );
    return paymentView(tx, payment);
  }

  /** The payment with its party locked first, then the payment row (posting.ts order). */
  private async lockedPayment(tx: Transaction, auth: AuthContext, id: string): Promise<PaymentRow> {
    const { partyId } = await loadPayment(tx, auth, id);
    await lockParty(tx, auth.organization.id, partyId);
    return loadPayment(tx, auth, id, true);
  }

  private async pendingCheque(tx: Transaction, auth: AuthContext, id: string): Promise<PaymentRow> {
    const payment = await this.lockedPayment(tx, auth, id);
    if (payment.chequeStatus !== 'pending') {
      throw new ConflictException('Only a cheque waiting for the bank can clear or bounce');
    }
    return payment;
  }

  /**
   * A business date given in a request, or today (India, by the database
   * clock): never in the future, nor before `notBefore`.
   */
  private async businessDate(
    tx: Transaction,
    given: string | undefined,
    notBefore: string | null,
    path: string,
  ): Promise<string> {
    const [row] = (await tx.execute<{ today: string }>(sql`select ${indiaToday} as today`))
      .rows as [{ today: string }];
    const date = given ?? row.today;
    if (date > row.today) throw refusal(path, 'This date is in the future');
    if (notBefore !== null && date < notBefore) {
      throw refusal(path, 'This date is before the payment was received');
    }
    return date;
  }
}
