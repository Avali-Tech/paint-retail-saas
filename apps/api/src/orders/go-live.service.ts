import 'reflect-metadata';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  postPartyLedger,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import type { GoLiveOpeningView, GoLivePreview, GoLiveResult } from '@paint/shared';
import { and, count, eq, gt, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { idempotent } from '../billing/idempotency.js';
import { indiaToday } from '../billing/invoice-view.js';
import { requireSaleParty } from '../billing/sale-parties.js';
import { addDays } from '../contracts/contract-dates.js';
import { DATABASE } from '../database/database.module.js';
import { importedOpenings } from '../imports/opening-balances.importer.js';
import { fieldError } from '../tax/tax-lookups.js';
import type { GoLiveInput } from './orders.schemas.js';

const { creditProfiles, loyaltyAccounts, parties, partyLedger, salesSettings } = schema;

/**
 * The billing go-live cut-over (spec §4.7): once per business, in one
 * transaction, MVP 1's hand-entered figures become the party ledger's opening
 * balances and `billing_live_on` is set. From then on exposure and overdue
 * days come from the ledger, invoices earn loyalty points, and the manual
 * figures and manual purchase entry are read-only.
 */
@Injectable()
export class GoLiveService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** What going live on `liveOn` (default today) would post, or what the go-live posted. */
  preview(auth: AuthContext, liveOn?: string): Promise<GoLivePreview> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const settings = await this.settings(tx);
      const live = settings.billingLiveOn !== null;
      const today = await indiaToday(tx);
      if (liveOn !== undefined && liveOn > today) {
        throw fieldError('liveOn', 'Go live today or on a past date');
      }
      return {
        billingLiveOn: settings.billingLiveOn,
        live,
        stockPostOn: settings.stockPostOn,
        openings: live ? [] : await this.openings(tx, liveOn ?? today),
        loyaltyAccounts: await this.loyaltyAccounts(tx),
        posted: live ? await this.posted(tx) : null,
      };
    });
  }

  goLive(auth: AuthContext, input: GoLiveInput, idempotencyKey?: string): Promise<GoLiveResult> {
    const request = { method: 'POST', path: '/sales/go-live', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        // The settings row, locked: two go-lives at once wait, and the second is refused.
        await tx
          .insert(salesSettings)
          .values({ organizationId: auth.organization.id })
          .onConflictDoNothing();
        const [settings] = (await tx
          .select({ liveOn: salesSettings.billingLiveOn })
          .from(salesSettings)
          .for('update')) as [{ liveOn: string | null }];
        if (settings.liveOn !== null) {
          throw new ConflictException(`Billing went live on ${settings.liveOn}`);
        }
        const today = await indiaToday(tx);
        const liveOn = input.liveOn ?? today;
        if (liveOn > today) throw fieldError('liveOn', 'Go live today or on a past date');

        const openings = new Map(
          (await this.openings(tx, liveOn)).map((opening) => [opening.partyId, opening]),
        );
        for (const [index, given] of (input.openings ?? []).entries()) {
          const party = await requireSaleParty(
            tx,
            given.partyId,
            `openings.${String(index)}.partyId`,
          );
          if (typeof given.overdueSince === 'string' && given.overdueSince > liveOn) {
            throw fieldError(
              `openings.${String(index)}.overdueSince`,
              'Cannot be after the go-live date',
            );
          }
          const known = openings.get(party.id);
          openings.set(party.id, {
            partyId: party.id,
            partyName: party.name,
            manualExposurePaise: known?.manualExposurePaise ?? 0,
            overdueDays: known?.overdueDays ?? 0,
            amountPaise: given.amountPaise,
            // Left out keeps the imported or hand-entered date; null says none is overdue.
            overdueSince:
              given.overdueSince === undefined ? (known?.overdueSince ?? null) : given.overdueSince,
            source: known?.source ?? 'manual',
          });
        }

        let openingEntries = 0;
        let openingTotalPaise = 0;
        for (const opening of [...openings.values()].sort((a, b) =>
          a.partyId.localeCompare(b.partyId),
        )) {
          // An imported overdue date after an earlier go-live date (the import checks today).
          if (opening.overdueSince !== null && opening.overdueSince > liveOn) {
            throw fieldError(
              'liveOn',
              `${opening.partyName} is overdue since ${opening.overdueSince}, after this date`,
            );
          }
          if (opening.overdueSince !== null) {
            await tx
              .insert(creditProfiles)
              .values({
                organizationId: auth.organization.id,
                partyId: opening.partyId,
                openingOverdueSince: opening.overdueSince,
              })
              .onConflictDoUpdate({
                target: creditProfiles.partyId,
                set: { openingOverdueSince: opening.overdueSince, updatedAt: sql`now()` },
              });
          }
          if (opening.amountPaise === 0) continue;
          await postPartyLedger(tx, [
            {
              organizationId: auth.organization.id,
              partyId: opening.partyId,
              entryOn: liveOn,
              entryType: 'opening',
              amountPaise: opening.amountPaise,
              referenceType: 'go_live',
              referenceId: opening.partyId,
              note: 'Opening balance at go-live',
              createdByMemberId: auth.memberId,
            },
          ]);
          openingEntries += 1;
          openingTotalPaise += opening.amountPaise;
        }
        await tx
          .update(salesSettings)
          .set({ billingLiveOn: liveOn, updatedAt: sql`now()` })
          .where(eq(salesSettings.organizationId, auth.organization.id));
        return { billingLiveOn: liveOn, openingEntries, openingTotalPaise };
      }),
    );
  }

  // Helpers -----------------------------------------------------------------

  private async settings(tx: Transaction) {
    const [row] = await tx
      .select({
        billingLiveOn: salesSettings.billingLiveOn,
        stockPostOn: salesSettings.stockPostOn,
      })
      .from(salesSettings);
    return row ?? { billingLiveOn: null, stockPostOn: 'invoice' as const };
  }

  /**
   * Every party's opening balance on `liveOn` ([PO-5]): its imported balance,
   * else its hand-entered exposure and overdue days. An imported balance with
   * no overdue date keeps the hand-entered overdue days.
   */
  private async openings(tx: Transaction, liveOn: string): Promise<GoLiveOpeningView[]> {
    const rows = await tx
      .select({
        partyId: creditProfiles.partyId,
        partyName: parties.displayName,
        manualExposurePaise: creditProfiles.manualExposurePaise,
        overdueDays: creditProfiles.overdueDays,
      })
      .from(creditProfiles)
      .innerJoin(parties, eq(parties.id, creditProfiles.partyId))
      .where(or(gt(creditProfiles.manualExposurePaise, 0), gt(creditProfiles.overdueDays, 0)));
    const manual = new Map(rows.map((row) => [row.partyId, row]));
    const imported = await importedOpenings(tx);
    const manualOverdue = (overdueDays: number) =>
      overdueDays > 0 ? addDays(liveOn, -overdueDays) : null;
    const openings: GoLiveOpeningView[] = rows
      .filter((row) => !imported.has(row.partyId))
      .map((row) => ({
        ...row,
        amountPaise: row.manualExposurePaise,
        overdueSince: manualOverdue(row.overdueDays),
        source: 'manual',
      }));
    for (const [partyId, opening] of imported) {
      const known = manual.get(partyId);
      openings.push({
        partyId,
        partyName: opening.partyName,
        manualExposurePaise: known?.manualExposurePaise ?? 0,
        overdueDays: known?.overdueDays ?? 0,
        amountPaise: opening.amountPaise,
        overdueSince: opening.overdueSince ?? manualOverdue(known?.overdueDays ?? 0),
        source: 'import',
      });
    }
    const key = (opening: GoLiveOpeningView) => `${opening.partyName}\u0000${opening.partyId}`;
    return openings.sort((a, b) => key(a).localeCompare(key(b)));
  }

  /** The opening entries the go-live posted. */
  private async posted(tx: Transaction): Promise<{ entries: number; totalPaise: number }> {
    const [row] = await tx
      .select({
        entries: count(),
        totalPaise: sql<string>`coalesce(sum(${partyLedger.amountPaise}), 0)`,
      })
      .from(partyLedger)
      .where(and(eq(partyLedger.entryType, 'opening'), eq(partyLedger.referenceType, 'go_live')));
    return { entries: Number(row?.entries), totalPaise: Number(row?.totalPaise) };
  }

  private async loyaltyAccounts(tx: Transaction): Promise<number> {
    const [total] = await tx
      .select({ value: count() })
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.status, 'active'));
    return Number(total?.value);
  }
}
