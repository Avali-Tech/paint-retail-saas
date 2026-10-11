import { schema, type Transaction } from '@paint/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { fieldError } from '../tax/tax-lookups.js';

const { parties, partyRoles, projects } = schema;

/** Roles an influencer holds (spec §6.4). */
export const INFLUENCER_ROLES = ['painter', 'contractor', 'architect'] as const;

/** A party a sale can name, with what the bill and the tax need. */
export interface SaleParty {
  readonly id: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly phone: string | null;
  readonly placeOfSupply: string | null;
}

/**
 * An active, unmerged party, or a 400 naming `path`. With `roles`, the party
 * must hold one of them (an influencer).
 */
export async function requireSaleParty(
  tx: Transaction,
  partyId: string,
  path: string,
  roles: readonly (typeof INFLUENCER_ROLES)[number][] | null = null,
): Promise<SaleParty> {
  const [party] = await tx
    .select({
      id: parties.id,
      name: parties.displayName,
      gstin: parties.gstin,
      phone: parties.phone,
      placeOfSupply: parties.placeOfSupply,
    })
    .from(parties)
    .where(
      and(
        eq(parties.id, partyId),
        eq(parties.isActive, true),
        isNull(parties.mergedIntoId),
        roles === null
          ? undefined
          : sql`exists (select 1 from ${partyRoles} r where r.party_id = ${sql.raw('"parties"."id"')} and r.role::text = any(${`{${roles.join(',')}}`}::text[]))`,
      ),
    );
  if (!party) {
    throw fieldError(
      path,
      roles === null ? 'Unknown customer' : 'Choose a painter, contractor or architect',
    );
  }
  return party;
}

/** A site (project) a sale can name: its name, and its address for the ship-to. */
export interface SaleSite {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly state: string | null;
}

export async function requireSaleSite(
  tx: Transaction,
  projectId: string,
  path = 'projectId',
): Promise<SaleSite> {
  const [project] = await tx
    .select({
      id: projects.id,
      name: projects.name,
      address: sql<
        string | null
      >`nullif(concat_ws(', ', ${projects.addressLine}, ${projects.city}, ${projects.state}, ${projects.pincode}), '')`,
      state: projects.state,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw fieldError(path, 'Unknown site');
  return project;
}
