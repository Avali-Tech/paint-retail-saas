import 'reflect-metadata';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { STATEMENT_MAX_ENTRIES, type MemberAccess, type StatementData } from '@paint/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import { DATABASE } from '../database/database.module.js';
import { canSeeParty } from '../parties/party-access.js';
import { ageBooks } from '../receivables/receivables.service.js';
import type { StatementQueryInput } from './statements.schemas.js';

const { organizations, parties, partyLedger, payments, stores, taxDocuments } = schema;

/** One line of an address from its parts, or null when there are none. */
const addressOf = (...parts: (string | null)[]) => {
  const text = parts.filter((part) => part !== null).join(', ');
  return text === '' ? null : text;
};

/**
 * A party's statement for any period (roadmap P2-M12, spec §1.3): the party ledger
 * between two dates with its opening balance, every entry and the closing balance,
 * then the ageing on the last day, from the same engine as the receivables screens.
 * In the business's tenant transaction; `access` decides which parties may be seen
 * (a member's stores, or every store for a stored statement link).
 */
export async function statementData(
  tx: Transaction,
  access: MemberAccess,
  organizationId: string,
  partyId: string,
  query: StatementQueryInput,
): Promise<StatementData> {
  const [party] = await tx
    .select({
      name: parties.displayName,
      phone: parties.phone,
      gstin: parties.gstin,
      addressLine: parties.addressLine,
      city: parties.city,
      state: parties.state,
      pincode: parties.pincode,
      homeStoreId: parties.homeStoreId,
      storeGstin: sql<
        string | null
      >`case when ${stores.registrationType} <> 'unregistered' then ${stores.gstin} end`,
      storeAddress: sql<
        string | null
      >`nullif(concat_ws(', ', ${stores.addressLine}, ${stores.city}, ${stores.state}, ${stores.pincode}), '')`,
    })
    .from(parties)
    .leftJoin(stores, eq(stores.id, parties.homeStoreId))
    .where(eq(parties.id, partyId));
  if (!party || !canSeeParty(access, party)) throw new NotFoundException('Customer not found');
  const [business] = (await tx
    .select({ name: organizations.name, legalName: organizations.legalName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))) as [{ name: string; legalName: string | null }];

  const [before] = (await tx
    .select({
      total: sql<number>`coalesce(sum(${partyLedger.amountPaise}), 0)`.mapWith(Number),
    })
    .from(partyLedger)
    .where(
      and(eq(partyLedger.partyId, partyId), sql`${partyLedger.entryOn} < ${query.from}::date`),
    )) as [{ total: number }];
  const rows = await tx
    .select({
      entryOn: partyLedger.entryOn,
      entryType: partyLedger.entryType,
      amountPaise: partyLedger.amountPaise,
      referenceNumber: sql<string | null>`coalesce(${taxDocuments.number}, ${payments.number})`,
      note: partyLedger.note,
    })
    .from(partyLedger)
    .leftJoin(
      taxDocuments,
      and(
        eq(partyLedger.referenceType, 'tax_document'),
        eq(taxDocuments.id, partyLedger.referenceId),
      ),
    )
    .leftJoin(
      payments,
      and(eq(partyLedger.referenceType, 'payment'), eq(payments.id, partyLedger.referenceId)),
    )
    .where(
      and(
        eq(partyLedger.partyId, partyId),
        sql`${partyLedger.entryOn} between ${query.from}::date and ${query.to}::date`,
      ),
    )
    .orderBy(asc(partyLedger.entryOn), asc(partyLedger.createdAt), asc(partyLedger.id))
    .limit(STATEMENT_MAX_ENTRIES + 1);
  if (rows.length > STATEMENT_MAX_ENTRIES) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      message: 'Too many entries for one statement',
      issues: [
        {
          path: 'from',
          message: `More than ${String(STATEMENT_MAX_ENTRIES)} entries: choose a shorter period`,
        },
      ],
    });
  }

  let running = before.total;
  let debitsPaise = 0;
  let creditsPaise = 0;
  const entries = rows.map((row) => {
    running += row.amountPaise;
    if (row.amountPaise > 0) debitsPaise += row.amountPaise;
    else creditsPaise -= row.amountPaise;
    return { ...row, balancePaise: running };
  });
  const ageing = await ageBooks(tx, access, { asOf: query.to, partyId });
  return {
    business: {
      name: business.name,
      legalName: business.legalName,
      gstin: party.storeGstin,
      address: party.storeAddress,
    },
    party: {
      id: partyId,
      name: party.name,
      phone: party.phone,
      gstin: party.gstin,
      address: addressOf(party.addressLine, party.city, party.state, party.pincode),
    },
    from: query.from,
    to: query.to,
    generatedOn: await indiaToday(tx),
    openingPaise: before.total,
    entries,
    debitsPaise,
    creditsPaise,
    closingPaise: running,
    ageing: ageing.totals,
    openItems: ageing.receivables.map((bill) => ({
      kind: bill.kind,
      number: bill.number,
      raisedOn: bill.raisedOn,
      dueOn: bill.effectiveDueOn,
      outstandingPaise: bill.outstandingPaise,
      daysPastDue: bill.daysPastDue,
    })),
  };
}

@Injectable()
export class StatementsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  statement(
    auth: AuthContext,
    partyId: string,
    query: StatementQueryInput,
  ): Promise<StatementData> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      statementData(tx, auth, auth.organization.id, partyId, query),
    );
  }
}
