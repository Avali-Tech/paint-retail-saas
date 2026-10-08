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
import { asc, count, eq, gt, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { idempotent } from '../billing/idempotency.js';
import { indiaToday } from '../billing/invoice-view.js';
import { requireSaleParty } from '../billing/sale-parties.js';
import { addDays } from '../contracts/contract-dates.js';
import { DATABASE } from '../database/database.module.js';
import { fieldError } from '../tax/tax-lookups.js';
import type { GoLiveInput } from './orders.schemas.js';

const { creditProfiles, loyaltyAccounts, parties, salesSettings } = schema;

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

  preview(auth: AuthContext): Promise<GoLivePreview> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const settings = await this.settings(tx);
      const live = settings.billingLiveOn !== null;
      const today = await indiaToday(tx);
      return {
        billingLiveOn: settings.billingLiveOn,
        live,
        stockPostOn: settings.stockPostOn,
        openings: live ? [] : await this.openings(tx, today),
        loyaltyAccounts: await this.loyaltyAccounts(tx),
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
          const known = openings.get(party.id);
          openings.set(party.id, {
            partyId: party.id,
            partyName: party.name,
            manualExposurePaise: known?.manualExposurePaise ?? 0,
            overdueDays: known?.overdueDays ?? 0,
            amountPaise: given.amountPaise,
            overdueSince: given.overdueSince ?? known?.overdueSince ?? null,
          });
        }

        let openingEntries = 0;
        let openingTotalPaise = 0;
        for (const opening of [...openings.values()].sort((a, b) =>
          a.partyId.localeCompare(b.partyId),
        )) {
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

  /** Every party with a hand-entered exposure or overdue days, as its opening balance on `liveOn`. */
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
      .where(or(gt(creditProfiles.manualExposurePaise, 0), gt(creditProfiles.overdueDays, 0)))
      .orderBy(asc(parties.displayName));
    return rows.map((row) => ({
      ...row,
      amountPaise: row.manualExposurePaise,
      overdueSince: row.overdueDays > 0 ? addDays(liveOn, -row.overdueDays) : null,
    }));
  }

  private async loyaltyAccounts(tx: Transaction): Promise<number> {
    const [total] = await tx
      .select({ value: count() })
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.status, 'active'));
    return Number(total?.value);
  }
}
