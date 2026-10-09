import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import type { PartyLedgerView } from '@paint/shared';
import { and, asc, eq, not, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { afterKey, cursorTime, keysetSlice } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { LEDGER_ORDER, type PartyLedgerQuery } from './payments.schemas.js';
import { openTargets } from './posting.js';

const { parties, partyBalances, partyLedger } = schema;

/** A party's account (spec §5.1): ledger entries for a period, and what is still open. */
@Injectable()
export class PartyLedgerService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  ledger(auth: AuthContext, partyId: string, query: PartyLedgerQuery): Promise<PartyLedgerView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [party] = await tx
        .select({
          balancePaise: sql<number>`coalesce(${partyBalances.balancePaise}, 0)`.mapWith(Number),
          advancePaise: sql<number>`coalesce(${partyBalances.advancePaise}, 0)`.mapWith(Number),
        })
        .from(parties)
        .leftJoin(partyBalances, eq(partyBalances.partyId, parties.id))
        .where(eq(parties.id, partyId));
      if (!party) throw new NotFoundException('Customer not found');
      const key = [partyLedger.entryOn, partyLedger.createdAt, partyLedger.id];
      const afterCursor = afterKey(LEDGER_ORDER, key, query.cursor);
      // Everything before this page: before the period, and the period's entries up to the cursor.
      const [opening] = (await tx
        .select({
          total: sql<number>`coalesce(sum(${partyLedger.amountPaise}), 0)`.mapWith(Number),
        })
        .from(partyLedger)
        .where(
          and(
            eq(partyLedger.partyId, partyId),
            or(
              query.from ? sql`${partyLedger.entryOn} < ${query.from}::date` : undefined,
              afterCursor === undefined ? undefined : not(afterCursor),
              sql`false`,
            ),
          ),
        )) as [{ total: number }];
      const rows = await tx
        .select({
          id: partyLedger.id,
          entryOn: partyLedger.entryOn,
          entryType: partyLedger.entryType,
          amountPaise: partyLedger.amountPaise,
          referenceType: partyLedger.referenceType,
          referenceId: partyLedger.referenceId,
          note: partyLedger.note,
          cursorAt: cursorTime(partyLedger.createdAt),
        })
        .from(partyLedger)
        .where(
          and(
            eq(partyLedger.partyId, partyId),
            query.from ? sql`${partyLedger.entryOn} >= ${query.from}::date` : undefined,
            query.to ? sql`${partyLedger.entryOn} <= ${query.to}::date` : undefined,
            afterCursor,
          ),
        )
        .orderBy(asc(partyLedger.entryOn), asc(partyLedger.createdAt), asc(partyLedger.id))
        .limit(query.limit + 1);
      const page = keysetSlice(rows, query.limit, (row) => [row.entryOn, row.cursorAt, row.id]);
      let running = opening.total;
      const entries = page.rows.map(({ cursorAt, ...row }) => {
        running += row.amountPaise;
        return { ...row, balancePaise: running };
      });
      return {
        partyId,
        from: query.from ?? null,
        to: query.to ?? null,
        openingPaise: opening.total,
        entries,
        closingPaise: running,
        nextCursor: page.nextCursor,
        balancePaise: party.balancePaise,
        advancePaise: party.advancePaise,
        openDocuments: await openTargets(tx, partyId),
      };
    });
  }
}
