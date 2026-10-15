import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  AGEING_BUCKETS,
  ageingBucket,
  formatINR,
  type AgeingBucket,
  type SiteAccountDetail,
  type SiteAccountView,
  type SiteLedgerEntry,
  type SiteOpenDocument,
} from '@paint/shared';
import { eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { canSeeParty } from '../parties/party-access.js';
import { fieldError } from '../tax/tax-lookups.js';
import { indiaToday, siteAccountsOf } from './credit-lookups.js';
import type { CreateSiteInput, UpdateSiteInput } from './site-accounts.schemas.js';

const { creditProfiles, parties, projectParties, projects, siteCreditAccounts } = schema;

type SiteRow = typeof siteCreditAccounts.$inferSelect;

/**
 * Site (job) accounts under a contractor (MVP 3 round 1a, P2-M09; spec §3.3):
 * a limit and status per project for one party, with the site's ledger view
 * and ageing computed from the party's documents on that project.
 */
@Injectable()
export class SiteAccountsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  list(auth: AuthContext, partyId: string): Promise<SiteAccountView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.party(tx, auth, partyId);
      return siteAccountsOf(tx, { partyId });
    });
  }

  /** A site account for a project the party is on, within the party's own limit. */
  create(auth: AuthContext, partyId: string, input: CreateSiteInput): Promise<SiteAccountView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const party = await this.party(tx, auth, partyId, true);
      const [project] = await tx
        .select({
          id: projects.id,
          onIt: sql<boolean>`${projects.customerPartyId} = ${partyId} or exists (
            select 1 from ${projectParties} pp where pp.project_id = ${projects.id} and pp.party_id = ${partyId})`,
        })
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (!project) throw fieldError('projectId', 'Unknown project');
      if (!project.onIt) {
        throw fieldError(
          'projectId',
          'This party is not the customer or a contractor on this project',
        );
      }
      this.withinLimit(party, input.limitPaise);
      const [created] = await tx
        .insert(siteCreditAccounts)
        .values({
          organizationId: auth.organization.id,
          partyId,
          projectId: input.projectId,
          limitPaise: input.limitPaise,
          notes: input.notes,
          createdByMemberId: auth.memberId,
        })
        .onConflictDoNothing()
        .returning({ id: siteCreditAccounts.id });
      if (!created) throw new ConflictException('This party already has an account for this site');
      return this.one(tx, created.id);
    });
  }

  get(auth: AuthContext, id: string): Promise<SiteAccountDetail> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const site = await this.site(tx, auth, id);
      const view = await this.one(tx, id);
      const today = (
        (await tx.execute<{ today: string }>(sql`select ${indiaToday}::text as today`)).rows[0] as {
          today: string;
        }
      ).today;
      const documents = await tx.execute<{
        id: string;
        number: string | null;
        kind: SiteLedgerEntry['kind'];
        issued_on: string;
        due_on: string | null;
        total_paise: string;
        outstanding: string;
        days_past_due: number;
      }>(sql`
        select d.id, d.number, d.kind, d.issued_on::text, d.due_on::text, d.total_paise,
          d.total_paise - coalesce((select sum(a.amount_paise) from allocations a where a.document_id = d.id), 0) as outstanding,
          (${today}::date - coalesce(d.due_on, d.issued_on))::int as days_past_due
        from tax_documents d
        where d.party_id = ${site.partyId} and d.project_id = ${site.projectId} and d.status = 'issued'
          and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
        order by d.issued_on, d.number, d.id`);
      const money = await tx.execute<{
        id: string;
        document_id: string;
        on: string;
        amount_paise: string;
        kind: 'payment' | 'credit_note' | 'reversal';
        number: string | null;
      }>(sql`
        select a.id, a.document_id, ((a.created_at at time zone 'Asia/Kolkata')::date)::text as on,
          a.amount_paise,
          case when a.reverses_allocation_id is not null then 'reversal'
               when a.payment_id is not null then 'payment' else 'credit_note' end as kind,
          coalesce(p.number, n.number) as number
        from allocations a
        join tax_documents d on d.id = a.document_id
        left join payments p on p.id = a.payment_id
        left join tax_documents n on n.id = a.credit_note_id
        where d.party_id = ${site.partyId} and d.project_id = ${site.projectId} and d.status = 'issued'
          and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
        order by a.created_at, a.id`);
      const numberOf = new Map(documents.rows.map((row) => [row.id, row.number]));
      const lines: Omit<SiteLedgerEntry, 'runningPaise'>[] = [
        ...documents.rows.map((row) => ({
          on: row.issued_on,
          kind: row.kind,
          documentId: row.id,
          number: row.number,
          againstNumber: null,
          amountPaise: Number(row.total_paise),
        })),
        ...money.rows.map((row) => ({
          on: row.on,
          kind: row.kind,
          documentId: row.document_id,
          number: row.number,
          // Money is only ever set against the site's documents listed above.
          againstNumber: numberOf.get(row.document_id) as string | null,
          amountPaise: -Number(row.amount_paise),
        })),
      ];
      // Oldest first; on one day a document before the money set against it (stable sort).
      lines.sort((a, b) => a.on.localeCompare(b.on));
      let running = 0;
      const ledger = lines.map((line) => {
        running += line.amountPaise;
        return { ...line, runningPaise: running };
      });
      const open: SiteOpenDocument[] = documents.rows
        .filter((row) => Number(row.outstanding) > 0)
        .map((row) => ({
          documentId: row.id,
          number: row.number,
          issuedOn: row.issued_on,
          dueOn: row.due_on,
          totalPaise: Number(row.total_paise),
          outstandingPaise: Number(row.outstanding),
          daysPastDue: row.days_past_due,
          bucket: ageingBucket(row.days_past_due),
        }));
      const ageing = Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, 0])) as Record<
        AgeingBucket,
        number
      >;
      for (const document of open) ageing[document.bucket] += document.outstandingPaise;
      return { ...view, ledger, openDocuments: open, ageing };
    });
  }

  update(auth: AuthContext, id: string, input: UpdateSiteInput): Promise<SiteAccountView> {
    return this.change(auth, id, async (tx, site) => {
      if (site.status === 'closed') throw new ConflictException('This site account is closed');
      if (input.limitPaise !== undefined) {
        this.withinLimit(await this.party(tx, auth, site.partyId), input.limitPaise);
      }
      return { ...input };
    });
  }

  hold(auth: AuthContext, id: string, reason: string): Promise<SiteAccountView> {
    return this.change(auth, id, (_tx, site) => {
      if (site.status !== 'active')
        throw new ConflictException(`This site account is ${site.status.replace('_', ' ')}`);
      return Promise.resolve({
        status: 'on_hold',
        holdReason: reason,
        heldAt: sql`now()`,
        heldByMemberId: auth.memberId,
      });
    });
  }

  release(auth: AuthContext, id: string): Promise<SiteAccountView> {
    return this.change(auth, id, (_tx, site) => {
      if (site.status !== 'on_hold')
        throw new ConflictException('This site account is not on hold');
      return Promise.resolve({
        status: 'active',
        holdReason: null,
        heldAt: null,
        heldByMemberId: null,
      });
    });
  }

  /** No more credit on this site; its documents stay with the party. */
  close(auth: AuthContext, id: string): Promise<SiteAccountView> {
    return this.change(auth, id, (_tx, site) => {
      if (site.status === 'closed') throw new ConflictException('This site account is closed');
      return Promise.resolve({
        status: 'closed',
        holdReason: null,
        heldAt: null,
        heldByMemberId: null,
      });
    });
  }

  // Helpers -----------------------------------------------------------------

  private change(
    auth: AuthContext,
    id: string,
    changes: (
      tx: Transaction,
      site: SiteRow,
    ) => Promise<PgUpdateSetSource<typeof siteCreditAccounts>>,
  ): Promise<SiteAccountView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const site = await this.site(tx, auth, id, true);
      await tx
        .update(siteCreditAccounts)
        .set({ ...(await changes(tx, site)), updatedAt: sql`now()` })
        .where(eq(siteCreditAccounts.id, id));
      return this.one(tx, id);
    });
  }

  /** The party, if the member can see it, with its credit; locked when adding a site. */
  private async party(tx: Transaction, auth: AuthContext, partyId: string, lock = false) {
    const query = tx
      .select({
        id: parties.id,
        homeStoreId: parties.homeStoreId,
        status: creditProfiles.status,
        limitPaise: creditProfiles.limitPaise,
      })
      .from(parties)
      .leftJoin(creditProfiles, eq(creditProfiles.partyId, parties.id))
      .where(eq(parties.id, partyId));
    const [party] = lock ? await query.for('update', { of: parties }) : await query;
    if (!party || !canSeeParty(auth, party)) throw new NotFoundException('Party not found');
    return party;
  }

  /** A site's limit sits within the party's own: credit must be given to the party first. */
  private withinLimit(
    party: { status: string | null; limitPaise: number | null },
    limitPaise: number,
  ): void {
    if (party.status === null || party.status === 'none') {
      throw new BadRequestException(
        'Give this party credit first: a site account sits within its limit',
      );
    }
    if (limitPaise > Number(party.limitPaise)) {
      throw fieldError(
        'limitPaise',
        `A site's limit is at most the party's: ${formatINR(Number(party.limitPaise))}`,
      );
    }
  }

  private async site(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    lock = false,
  ): Promise<SiteRow> {
    const query = tx
      .select({ site: siteCreditAccounts, homeStoreId: parties.homeStoreId })
      .from(siteCreditAccounts)
      .innerJoin(parties, eq(parties.id, siteCreditAccounts.partyId))
      .where(eq(siteCreditAccounts.id, id));
    const [row] = lock ? await query.for('update', { of: siteCreditAccounts }) : await query;
    if (!row || !canSeeParty(auth, row)) throw new NotFoundException('Site account not found');
    return row.site;
  }

  private async one(tx: Transaction, id: string): Promise<SiteAccountView> {
    const [view] = (await siteAccountsOf(tx, { id })) as [SiteAccountView];
    return view;
  }
}
