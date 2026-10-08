import 'reflect-metadata';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  canAccessStore,
  countedCash,
  formatINR,
  type RegisterSessionSummary,
  type RegisterSessionView,
} from '@paint/shared';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { Notifier } from '../notifications/notifier.js';
import type {
  CashMovementInput,
  CloseRegisterInput,
  ListRegisterSessionsQuery,
  OpenRegisterInput,
} from './payments.schemas.js';
import { paymentStore } from './posting.js';

const { paymentModes, payments, registerCashMovements, registerSessions, salesSettings } = schema;

type SessionRow = typeof registerSessions.$inferSelect;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/**
 * The cash register (spec §5.5): a session opens with a float, takes cash
 * payments and refunds and pay-ins and pay-outs, and closes once with the
 * cash counted against what is expected. Closed sessions never change.
 */
@Injectable()
export class RegistersService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {}

  open(auth: AuthContext, code: string, input: OpenRegisterInput): Promise<RegisterSessionView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await paymentStore(tx, auth, input.storeId, 'storeId');
      const [session] = await tx
        .insert(registerSessions)
        .values({
          organizationId: auth.organization.id,
          storeId: input.storeId,
          registerCode: code,
          openedByMemberId: auth.memberId,
          openingFloatPaise: input.openingFloatPaise,
          openingNote: input.note,
        })
        .onConflictDoNothing()
        .returning();
      if (!session) throw new ConflictException(`Register ${code} is already open at this store`);
      return this.view(tx, session);
    });
  }

  list(
    auth: AuthContext,
    query: ListRegisterSessionsQuery,
  ): Promise<{
    items: RegisterSessionSummary[];
    total: number;
  }> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        auth.allStores ? undefined : inArray(registerSessions.storeId, [...auth.storeIds]),
        query.storeId ? eq(registerSessions.storeId, query.storeId) : undefined,
        query.status ? eq(registerSessions.status, query.status) : undefined,
      );
      const rows = await tx
        .select({
          id: registerSessions.id,
          storeId: registerSessions.storeId,
          registerCode: registerSessions.registerCode,
          status: registerSessions.status,
          openedAt: registerSessions.openedAt,
          closedAt: registerSessions.closedAt,
          openingFloatPaise: registerSessions.openingFloatPaise,
          variancePaise: registerSessions.variancePaise,
        })
        .from(registerSessions)
        .where(where)
        .orderBy(desc(registerSessions.openedAt), desc(registerSessions.id))
        .limit(query.limit)
        .offset(query.offset);
      const [total] = await tx.select({ value: count() }).from(registerSessions).where(where);
      return {
        items: rows.map((row) => ({
          ...row,
          openedAt: row.openedAt.toISOString(),
          closedAt: iso(row.closedAt),
        })),
        total: Number(total?.value),
      };
    });
  }

  get(auth: AuthContext, id: string): Promise<RegisterSessionView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      this.view(tx, await this.load(tx, auth, id)),
    );
  }

  movement(auth: AuthContext, id: string, input: CashMovementInput): Promise<RegisterSessionView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const session = await this.load(tx, auth, id, 'share');
      if (session.status !== 'open') throw new ConflictException('This register session is closed');
      await tx.insert(registerCashMovements).values({
        organizationId: auth.organization.id,
        sessionId: id,
        kind: input.kind,
        amountPaise: input.amountPaise,
        reason: input.reason,
        createdByMemberId: auth.memberId,
      });
      return this.view(tx, session);
    });
  }

  /** Counts the drawer: the variance is counted − expected; past the setting, managers hear. */
  close(auth: AuthContext, id: string, input: CloseRegisterInput): Promise<RegisterSessionView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const session = await this.load(tx, auth, id, 'update');
      if (session.status !== 'open') throw new ConflictException('This register session is closed');
      const fromNotes =
        input.denominations === undefined ? undefined : countedCash(input.denominations);
      if (
        fromNotes !== undefined &&
        input.countedCashPaise !== undefined &&
        fromNotes !== input.countedCashPaise
      ) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          message: 'Cannot close the register',
          issues: [
            {
              path: 'countedCashPaise',
              message: `The notes and coins add up to ${formatINR(fromNotes)}`,
            },
          ],
        });
      }
      // One of the two is present (the schema insists).
      const counted = Number(fromNotes ?? input.countedCashPaise);
      const totals = await this.cashTotals(tx, id);
      const expected = session.openingFloatPaise + totals.netPaise;
      const [closed] = (await tx
        .update(registerSessions)
        .set({
          status: 'closed',
          closedByMemberId: auth.memberId,
          closedAt: sql`now()`,
          expectedCashPaise: expected,
          countedCashPaise: counted,
          variancePaise: counted - expected,
          denominations: input.denominations,
          closingNote: input.note,
          updatedAt: sql`now()`,
        })
        .where(eq(registerSessions.id, id))
        .returning()) as [SessionRow];
      const [settings] = await tx
        .select({ alert: salesSettings.registerVarianceAlertPaise })
        .from(salesSettings);
      const variance = counted - expected;
      if (Math.abs(variance) > (settings?.alert ?? 0)) {
        await this.notifier.notify(tx, {
          organizationId: auth.organization.id,
          event: 'register_variance',
          to: { storeId: session.storeId, permission: 'payments:manage' },
          actorMemberId: auth.memberId,
          title: `Register ${session.registerCode} closed ${variance < 0 ? 'short' : 'over'} by ${formatINR(Math.abs(variance))}`,
          body: `Expected ${formatINR(expected)}, counted ${formatINR(counted)}`,
          link: `/register-sessions/${id}`,
        });
      }
      return this.view(tx, closed);
    });
  }

  // Helpers -----------------------------------------------------------------

  private async load(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    lock?: 'share' | 'update',
  ): Promise<SessionRow> {
    const query = tx.select().from(registerSessions).where(eq(registerSessions.id, id));
    const [session] = lock === undefined ? await query : await query.for(lock);
    if (!session || !canAccessStore(auth, session.storeId)) {
      throw new NotFoundException('Register session not found');
    }
    return session;
  }

  /** Cash in and out of the drawer: cash payments, cash refunds and movements. */
  private async cashTotals(
    tx: Transaction,
    id: string,
  ): Promise<{ inPaise: number; outPaise: number; netPaise: number }> {
    const result = await tx.execute<{ cash_in: string; cash_out: string; moved: string }>(sql`
      select
        coalesce((select sum(p.amount_paise) from ${payments} p
          where p.register_session_id = ${id} and p.mode_kind = 'cash' and p.direction = 'in'), 0) as cash_in,
        coalesce((select sum(p.amount_paise) from ${payments} p
          where p.register_session_id = ${id} and p.mode_kind = 'cash' and p.direction = 'out'), 0) as cash_out,
        coalesce((select sum(case m.kind when 'pay_in' then m.amount_paise else -m.amount_paise end)
          from ${registerCashMovements} m where m.session_id = ${id}), 0) as moved
    `);
    const [row] = result.rows as [{ cash_in: string; cash_out: string; moved: string }];
    const inPaise = Number(row.cash_in);
    const outPaise = Number(row.cash_out);
    return { inPaise, outPaise, netPaise: inPaise - outPaise + Number(row.moved) };
  }

  private async view(tx: Transaction, session: SessionRow): Promise<RegisterSessionView> {
    const totals = await this.cashTotals(tx, session.id);
    const movements = await tx
      .select()
      .from(registerCashMovements)
      .where(eq(registerCashMovements.sessionId, session.id))
      .orderBy(asc(registerCashMovements.createdAt), asc(registerCashMovements.id));
    const modeTotals = await tx
      .select({
        modeId: paymentModes.id,
        kind: paymentModes.kind,
        name: paymentModes.name,
        inPaise:
          sql<number>`coalesce(sum(${payments.amountPaise}) filter (where ${payments.direction} = 'in'), 0)`.mapWith(
            Number,
          ),
        outPaise:
          sql<number>`coalesce(sum(${payments.amountPaise}) filter (where ${payments.direction} = 'out'), 0)`.mapWith(
            Number,
          ),
        count: count(),
      })
      .from(payments)
      .innerJoin(paymentModes, eq(paymentModes.id, payments.modeId))
      .where(eq(payments.registerSessionId, session.id))
      .groupBy(paymentModes.id, paymentModes.kind, paymentModes.name)
      .orderBy(asc(paymentModes.name));
    return {
      id: session.id,
      storeId: session.storeId,
      registerCode: session.registerCode,
      status: session.status,
      openedByMemberId: session.openedByMemberId,
      openedAt: session.openedAt.toISOString(),
      openingFloatPaise: session.openingFloatPaise,
      openingNote: session.openingNote,
      expectedCashPaise: session.expectedCashPaise ?? session.openingFloatPaise + totals.netPaise,
      countedCashPaise: session.countedCashPaise,
      variancePaise: session.variancePaise,
      denominations: session.denominations,
      closedByMemberId: session.closedByMemberId,
      closedAt: iso(session.closedAt),
      closingNote: session.closingNote,
      cashInPaise: totals.inPaise,
      cashOutPaise: totals.outPaise,
      movements: movements.map((movement) => ({
        id: movement.id,
        kind: movement.kind,
        amountPaise: movement.amountPaise,
        reason: movement.reason,
        createdByMemberId: movement.createdByMemberId,
        createdAt: movement.createdAt.toISOString(),
      })),
      modeTotals,
    };
  }
}
