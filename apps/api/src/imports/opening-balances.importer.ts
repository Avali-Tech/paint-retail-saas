import { schema, type Transaction } from '@paint/db';
import { formatINR } from '@paint/shared';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { phone } from '../auth/auth.schemas.js';
import { indiaToday } from '../billing/invoice-view.js';
import { canSeeParty } from '../parties/party-access.js';
import { gstin } from '../parties/parties.schemas.js';
import { date, optional, required, rupees, text } from './import-cells.js';
import { FirstSeen, type ImportAction, type Importer, type RowPlan } from './import-types.js';

const { goLiveOpenings, parties, salesSettings } = schema;

const row = z
  .object({
    phone: optional(phone),
    gstin: optional(gstin),
    name: optional(text(1, 160)),
    opening_balance: required(rupees),
    overdue_since: optional(date),
  })
  .refine((cells) => cells.phone !== undefined || cells.gstin !== undefined, {
    path: ['phone'],
    message: 'Enter the mobile number or GSTIN the party is saved with',
  })
  .refine((cells) => cells.overdue_since === undefined || cells.opening_balance > 0, {
    path: ['overdue_since'],
    message: 'Only for a party that owes something',
  });
type OpeningRow = z.output<typeof row>;

interface PlannedOpening {
  readonly row: number;
  readonly action: ImportAction;
  readonly partyId: string;
  readonly label: string;
  readonly value: OpeningRow;
}

/**
 * Opening balances from the old books, such as a Tally ledger (spec §4.7,
 * [PO-5]): what each party owes on the day billing goes live, and since when
 * part of it is overdue. Saved for the go-live (POST /sales/go-live), which
 * posts them as opening ledger entries in place of the hand-entered exposure.
 * Importing again replaces a party's figures until billing is live.
 */
export const openingBalancesImporter: Importer<OpeningRow> = {
  kind: 'opening-balances',
  title: 'Opening balances for the billing go-live',
  permission: 'organization:manage',
  columns: [
    {
      name: 'phone',
      required: false,
      description: 'Mobile number the party is saved with; this or the GSTIN finds the party',
      example: '9876543210',
    },
    {
      name: 'gstin',
      required: false,
      description: 'GSTIN the party is saved with',
      example: '',
    },
    {
      name: 'name',
      required: false,
      description: 'The party’s name; checked against the party found',
      example: 'Sharma Constructions',
    },
    {
      name: 'opening_balance',
      required: true,
      description: 'What the party owes on the go-live date, in rupees; 0 for nothing',
      example: '45000.00',
    },
    {
      name: 'overdue_since',
      required: false,
      description:
        'Since when part of it is overdue, such as 2026-03-15 or 15-03-2026; blank keeps the overdue days entered by hand',
      example: '',
    },
  ],
  row,

  async plan(tx, auth, rows, fail) {
    const [settings] = await tx.select({ liveOn: salesSettings.billingLiveOn }).from(salesSettings);
    // Once live, nothing is checked or saved: the file is refused as a whole.
    const checking = settings?.liveOn ? [] : rows;
    if (settings?.liveOn) {
      fail(
        1,
        null,
        `Billing went live on ${settings.liveOn}: opening balances are in the party ledger now`,
      );
    }
    const today = await indiaToday(tx);

    // Each phone number and GSTIN can identify only one row.
    const phones = new FirstSeen<string>();
    const gstins = new FirstSeen<string>();
    const checked = checking.filter(({ row: rowNumber, value }) => {
      const phoneRow = value.phone ? phones.check(value.phone, rowNumber) : undefined;
      const gstinRow = value.gstin ? gstins.check(value.gstin, rowNumber) : undefined;
      if (phoneRow) fail(rowNumber, 'phone', `Also on row ${String(phoneRow)}`);
      if (gstinRow) fail(rowNumber, 'gstin', `Also on row ${String(gstinRow)}`);
      return !phoneRow && !gstinRow;
    });

    const values = checked.map((parsed) => parsed.value);
    const matches = await tx
      .select({
        id: parties.id,
        name: parties.displayName,
        phone: parties.phone,
        gstin: parties.gstin,
        homeStoreId: parties.homeStoreId,
        usable: sql<boolean>`${parties.isActive} and ${parties.mergedIntoId} is null`,
      })
      .from(parties)
      .where(
        or(
          inArray(
            parties.phone,
            values.flatMap((v) => (v.phone ? [v.phone] : [])),
          ),
          inArray(
            parties.gstin,
            values.flatMap((v) => (v.gstin ? [v.gstin] : [])),
          ),
        ),
      );
    const byPhone = new Map(matches.flatMap((p) => (p.phone ? [[p.phone, p] as const] : [])));
    const byGstin = new Map(matches.flatMap((p) => (p.gstin ? [[p.gstin, p] as const] : [])));
    const staged = new Map(
      (
        await tx
          .select({
            partyId: goLiveOpenings.partyId,
            amountPaise: goLiveOpenings.amountPaise,
            overdueSince: goLiveOpenings.overdueSince,
          })
          .from(goLiveOpenings)
          .where(
            inArray(
              goLiveOpenings.partyId,
              matches.map((p) => p.id),
            ),
          )
      ).map((opening) => [opening.partyId, opening]),
    );

    const partiesSeen = new FirstSeen<string>();
    const planned: PlannedOpening[] = [];
    for (const { row: rowNumber, value } of checked) {
      const viaPhone = value.phone ? byPhone.get(value.phone) : undefined;
      const viaGstin = value.gstin ? byGstin.get(value.gstin) : undefined;
      const party = viaGstin ?? viaPhone;
      const problems: [string, string][] = [];
      if (viaPhone && viaGstin && viaPhone.id !== viaGstin.id) {
        problems.push([
          'phone',
          `This number is ${viaPhone.name}'s, but the GSTIN is ${viaGstin.name}'s`,
        ]);
      } else if (!party) {
        problems.push([
          value.gstin ? 'gstin' : 'phone',
          'No party has this mobile number or GSTIN; import parties first',
        ]);
      } else if (!canSeeParty(auth, party)) {
        problems.push(['phone', 'Matches a party at a store you cannot access']);
      } else if (!party.usable) {
        problems.push(['phone', `${party.name} is inactive or merged into another party`]);
      } else if (
        value.name !== undefined &&
        value.name.toLowerCase() !== party.name.toLowerCase()
      ) {
        problems.push(['name', `This is ${party.name}, not ${value.name}`]);
      } else {
        const first = partiesSeen.check(party.id, rowNumber);
        if (first) problems.push(['phone', `${party.name} is also on row ${String(first)}`]);
      }
      if (value.overdue_since !== undefined && value.overdue_since > today) {
        problems.push(['overdue_since', 'Cannot be in the future']);
      }
      if (problems.length > 0 || !party) {
        for (const [column, message] of problems) fail(rowNumber, column, message);
        continue;
      }
      const before = staged.get(party.id);
      const action: ImportAction = !before
        ? 'create'
        : before.amountPaise === value.opening_balance &&
            before.overdueSince === (value.overdue_since ?? null)
          ? 'unchanged'
          : 'update';
      planned.push({
        row: rowNumber,
        action,
        partyId: party.id,
        label: `${party.name} · ${formatINR(value.opening_balance)}`,
        value,
      });
    }

    return {
      rows: planned.map(({ row: rowNumber, action, label }): RowPlan => ({
        row: rowNumber,
        action,
        label,
      })),
      async apply(applyTx) {
        for (const opening of planned) {
          if (opening.action === 'unchanged') continue;
          const figures = {
            amountPaise: opening.value.opening_balance,
            overdueSince: opening.value.overdue_since ?? null,
            importedByMemberId: auth.memberId,
          };
          await applyTx
            .insert(goLiveOpenings)
            .values({ organizationId: auth.organization.id, partyId: opening.partyId, ...figures })
            .onConflictDoUpdate({
              target: [goLiveOpenings.organizationId, goLiveOpenings.partyId],
              set: { ...figures, updatedAt: sql`now()` },
            });
        }
      },
    };
  },
};

/** The imported opening balances, by party (empty once none were imported). */
export async function importedOpenings(
  tx: Transaction,
): Promise<Map<string, { amountPaise: number; overdueSince: string | null; partyName: string }>> {
  const rows = await tx
    .select({
      partyId: goLiveOpenings.partyId,
      partyName: parties.displayName,
      amountPaise: goLiveOpenings.amountPaise,
      overdueSince: goLiveOpenings.overdueSince,
    })
    .from(goLiveOpenings)
    .innerJoin(parties, eq(parties.id, goLiveOpenings.partyId));
  return new Map(rows.map(({ partyId, ...rest }) => [partyId, rest]));
}
