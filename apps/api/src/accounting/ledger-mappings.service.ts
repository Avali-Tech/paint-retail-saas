import 'reflect-metadata';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import type { LedgerMappingView, TallyGroup } from '@paint/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import type { LedgerMappingInput } from './accounting.schemas.js';

const { ledgerMappings, parties, paymentModes, stores } = schema;

type MappingRow = typeof ledgerMappings.$inferSelect & { partyName: string | null };

const toView = (row: MappingRow): LedgerMappingView => ({
  id: row.id,
  purpose: row.purpose,
  rateBasisPoints: row.rateBps,
  nature: row.nature,
  supplyType: row.supplyType,
  storeId: row.storeId,
  modeKind: row.modeKind,
  modeId: row.modeId,
  partyId: row.partyId,
  partyName: row.partyName,
  ledgerName: row.tallyLedgerName,
  // The database allows only Tally's groups (ledger_mappings_group).
  group: row.tallyGroup as TallyGroup | null,
  position: row.position,
  updatedAt: row.updatedAt.toISOString(),
});

/** The input as table columns: every match column set, so an edit can clear one. */
const columnsOf = (input: LedgerMappingInput) => ({
  purpose: input.purpose,
  rateBps: input.rateBasisPoints ?? null,
  nature: input.nature ?? null,
  supplyType: input.supplyType ?? null,
  storeId: input.storeId ?? null,
  modeKind: input.modeKind ?? null,
  modeId: input.modeId ?? null,
  partyId: input.partyId ?? null,
  tallyLedgerName: input.ledgerName,
  tallyGroup: input.group ?? null,
  position: input.position,
});

/** Every mapping (or one), by purpose then position: the export resolves ledgers in this order. */
export async function mappingViews(tx: Transaction, id?: string): Promise<LedgerMappingView[]> {
  const rows = await tx
    .select({ mapping: ledgerMappings, partyName: parties.displayName })
    .from(ledgerMappings)
    .leftJoin(parties, eq(parties.id, ledgerMappings.partyId))
    .where(id === undefined ? undefined : eq(ledgerMappings.id, id))
    .orderBy(
      asc(ledgerMappings.purpose),
      asc(ledgerMappings.position),
      asc(ledgerMappings.createdAt),
      asc(ledgerMappings.id),
    );
  return rows.map((row) => toView({ ...row.mapping, partyName: row.partyName }));
}

/**
 * The business's overrides of default Tally ledger names (spec §6.1; the
 * `ledger_mappings` table of round 3a). Settings: audited by a trigger.
 */
@Injectable()
export class LedgerMappingsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Every mapping, by purpose then position. */
  list(auth: AuthContext): Promise<LedgerMappingView[]> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => mappingViews(tx));
  }

  create(auth: AuthContext, input: LedgerMappingInput): Promise<LedgerMappingView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.checkReferences(tx, input);
      const [row] = (await tx
        .insert(ledgerMappings)
        .values({ organizationId: auth.organization.id, ...columnsOf(input) })
        .returning({ id: ledgerMappings.id })) as [{ id: string }];
      return this.one(tx, row.id);
    });
  }

  /** Replaces the mapping: match columns left out are cleared. */
  update(auth: AuthContext, id: string, input: LedgerMappingInput): Promise<LedgerMappingView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.checkReferences(tx, input);
      const [row] = await tx
        .update(ledgerMappings)
        .set({ ...columnsOf(input), updatedAt: sql`now()` })
        .where(eq(ledgerMappings.id, id))
        .returning({ id: ledgerMappings.id });
      if (!row) throw new NotFoundException('Ledger mapping not found');
      return this.one(tx, id);
    });
  }

  /** The default name applies again. */
  remove(auth: AuthContext, id: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [row] = await tx
        .delete(ledgerMappings)
        .where(eq(ledgerMappings.id, id))
        .returning({ id: ledgerMappings.id });
      if (!row) throw new NotFoundException('Ledger mapping not found');
    });
  }

  // Helpers -----------------------------------------------------------------

  private async one(tx: Transaction, id: string): Promise<LedgerMappingView> {
    const [view] = (await mappingViews(tx, id)) as [LedgerMappingView];
    return view;
  }

  /** The store, mode and party must be this business's (row security hides the rest). */
  private async checkReferences(tx: Transaction, input: LedgerMappingInput): Promise<void> {
    const references = [
      { path: 'storeId', id: input.storeId, table: stores, column: stores.id, what: 'store' },
      {
        path: 'modeId',
        id: input.modeId,
        table: paymentModes,
        column: paymentModes.id,
        what: 'payment mode',
      },
      { path: 'partyId', id: input.partyId, table: parties, column: parties.id, what: 'party' },
    ] as const;
    const issues: { path: string; message: string }[] = [];
    for (const reference of references) {
      if (reference.id === undefined) continue;
      const [found] = await tx
        .select({ id: reference.column })
        .from(reference.table)
        .where(eq(reference.column, reference.id));
      if (!found) issues.push({ path: reference.path, message: `No such ${reference.what}` });
    }
    if (issues.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: 'Cannot save the ledger mapping',
        issues,
      });
    }
  }
}
