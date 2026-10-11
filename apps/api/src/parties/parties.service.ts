import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isUniqueViolation,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { canAccessStore, panFromGstin, stateCodeFromGstin } from '@paint/shared';
import { and, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { canSeeParty, containsPattern, phoneSearchDigits } from './party-access.js';
import type {
  CreatePartyInput,
  ListPartiesQuery,
  PARTY_ROLES,
  UpdatePartyInput,
} from './parties.schemas.js';

const { customerProfiles, organizationMembers, parties, partyRoles, stores } = schema;

type PartyRole = (typeof PARTY_ROLES)[number];
type PartyRow = typeof parties.$inferSelect;
type CustomerRow = typeof customerProfiles.$inferSelect;

export interface CustomerView {
  readonly customerType: CustomerRow['customerType'];
  readonly assignedMemberId: string | null;
  readonly preferredContact: CustomerRow['preferredContact'];
}

export interface PartyView {
  readonly id: string;
  readonly kind: PartyRow['kind'];
  readonly displayName: string;
  readonly legalName: string | null;
  readonly contactPerson: string | null;
  readonly phone: string | null;
  readonly alternatePhone: string | null;
  readonly email: string | null;
  readonly gstin: string | null;
  readonly pan: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
  /** GSTN state code: from the GSTIN when there is one, else as entered. */
  readonly placeOfSupply: string | null;
  readonly homeStoreId: string | null;
  readonly notes: string | null;
  readonly tags: string[];
  readonly isActive: boolean;
  /** Set when this party was merged into another: open that one instead. */
  readonly mergedIntoId: string | null;
  readonly roles: PartyRole[];
  readonly customer: CustomerView | null;
}

export interface PartyPage {
  readonly items: PartyView[];
  readonly total: number;
}

const DEFAULT_CUSTOMER: CustomerView = {
  customerType: 'retail',
  assignedMemberId: null,
  preferredContact: 'phone',
};

@Injectable()
export class PartiesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Parties the member can see, filtered and searched, ordered by name ignoring case. */
  list(auth: AuthContext, query: ListPartiesQuery): Promise<PartyPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        this.visibleTo(auth),
        query.includeInactive ? undefined : eq(parties.isActive, true),
        query.role
          ? inArray(
              parties.id,
              tx
                .select({ id: partyRoles.partyId })
                .from(partyRoles)
                .where(eq(partyRoles.role, query.role)),
            )
          : undefined,
        query.q ? this.matching(query.q) : undefined,
      );
      const rows = await tx
        .select()
        .from(parties)
        .where(where)
        .orderBy(sql`lower(${parties.displayName})`, parties.displayName, parties.id)
        .limit(query.limit)
        .offset(query.offset);
      const [{ total } = { total: 0 }] = await tx
        .select({ total: count() })
        .from(parties)
        .where(where);
      return { items: await this.withDetails(tx, rows), total };
    });
  }

  get(auth: AuthContext, partyId: string): Promise<PartyView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, partyId),
    );
  }

  async create(auth: AuthContext, input: CreatePartyInput): Promise<PartyView> {
    const { roles, customer, ...fields } = input;
    const id = randomUUID();
    return this.mapDuplicates(auth, fields, () =>
      withTenant(this.connection.db, auth.organization.id, async (tx) => {
        await this.assertHomeStore(tx, auth, fields.homeStoreId ?? null);
        this.checkPlaceOfSupply(fields.gstin, fields.placeOfSupply);
        const values = { ...fields, pan: this.checkedPan(fields.gstin, fields.pan) };
        await tx.insert(parties).values({ id, organizationId: auth.organization.id, ...values });
        await this.replaceRoles(tx, auth.organization.id, id, roles);
        if (roles.includes('customer')) {
          await this.saveCustomer(tx, auth.organization.id, id, {
            ...DEFAULT_CUSTOMER,
            ...customer,
          });
        }
        return this.view(tx, auth, id);
      }),
    );
  }

  async update(auth: AuthContext, partyId: string, input: UpdatePartyInput): Promise<PartyView> {
    const { roles, customer, ...fields } = input;
    return this.mapDuplicates(auth, fields, () =>
      withTenant(this.connection.db, auth.organization.id, async (tx) => {
        const current = await this.loadVisible(tx, auth, partyId);
        const view = (await this.detailBuilder(tx, [current.id]))(current);

        if (fields.homeStoreId !== undefined && fields.homeStoreId !== current.homeStoreId) {
          await this.assertHomeStore(tx, auth, fields.homeStoreId);
        }
        const gstin = fields.gstin === undefined ? current.gstin : fields.gstin;
        const pan = fields.pan === undefined ? current.pan : fields.pan;
        this.checkPlaceOfSupply(gstin, fields.placeOfSupply);
        await tx
          .update(parties)
          .set({ ...fields, pan: this.checkedPan(gstin, pan), updatedAt: sql`now()` })
          .where(eq(parties.id, partyId));

        const finalRoles = roles ?? view.roles;
        if (customer && !finalRoles.includes('customer')) {
          throw new BadRequestException('Customer details need the customer role');
        }
        if (roles) await this.replaceRoles(tx, auth.organization.id, partyId, roles);
        if (finalRoles.includes('customer')) {
          await this.saveCustomer(tx, auth.organization.id, partyId, {
            ...(view.customer ?? DEFAULT_CUSTOMER),
            ...customer,
          });
        } else {
          await tx.delete(customerProfiles).where(eq(customerProfiles.partyId, partyId));
        }
        return this.view(tx, auth, partyId);
      }),
    );
  }

  /** Condition limiting parties to those the member can see. */
  private visibleTo(auth: AuthContext): SQL | undefined {
    if (auth.allStores) return undefined;
    return or(isNull(parties.homeStoreId), inArray(parties.homeStoreId, [...auth.storeIds]));
  }

  /** Search by phone fragment, or by name, legal name, contact person or GSTIN. */
  private matching(q: string): SQL | undefined {
    const digits = phoneSearchDigits(q);
    if (digits) {
      return or(
        ilike(parties.phone, containsPattern(digits)),
        ilike(parties.alternatePhone, containsPattern(digits)),
      );
    }
    const pattern = containsPattern(q);
    return or(
      ilike(parties.displayName, pattern),
      ilike(parties.legalName, pattern),
      ilike(parties.contactPerson, pattern),
      ilike(parties.gstin, pattern),
    );
  }

  /** A visible party with its roles and customer details, read inside `tx`. */
  private async view(tx: Transaction, auth: AuthContext, partyId: string): Promise<PartyView> {
    const row = await this.loadVisible(tx, auth, partyId);
    return (await this.detailBuilder(tx, [row.id]))(row);
  }

  private async loadVisible(
    tx: Transaction,
    auth: AuthContext,
    partyId: string,
  ): Promise<PartyRow> {
    const [row] = await tx.select().from(parties).where(eq(parties.id, partyId));
    if (!row || !canSeeParty(auth, row)) throw new NotFoundException('Party not found');
    return row;
  }

  private async withDetails(tx: Transaction, rows: PartyRow[]): Promise<PartyView[]> {
    return rows.map(
      await this.detailBuilder(
        tx,
        rows.map((row) => row.id),
      ),
    );
  }

  /** Loads roles and customer profiles for `ids`, returning a function that builds each view. */
  private async detailBuilder(
    tx: Transaction,
    ids: string[],
  ): Promise<(row: PartyRow) => PartyView> {
    const roleRows = await tx.select().from(partyRoles).where(inArray(partyRoles.partyId, ids));
    const customerRows = await tx
      .select()
      .from(customerProfiles)
      .where(inArray(customerProfiles.partyId, ids));
    return ({ organizationId, createdAt, updatedAt, mergedAt, mergedByMemberId, ...party }) => {
      const customer = customerRows.find((row) => row.partyId === party.id);
      return {
        ...party,
        roles: roleRows
          .filter((row) => row.partyId === party.id)
          .map((row) => row.role)
          .sort(),
        customer: customer
          ? {
              customerType: customer.customerType,
              assignedMemberId: customer.assignedMemberId,
              preferredContact: customer.preferredContact,
            }
          : null,
      };
    };
  }

  /** The home store must exist in the business and be one the member can access. */
  private async assertHomeStore(
    tx: Transaction,
    auth: AuthContext,
    homeStoreId: string | null,
  ): Promise<void> {
    if (homeStoreId === null) return;
    const [store] = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, homeStoreId));
    if (!store) throw new BadRequestException('Unknown store');
    if (!canAccessStore(auth, homeStoreId)) {
      throw new ForbiddenException('You cannot add parties to a store you cannot access');
    }
  }

  /** Fills the PAN from the GSTIN, and refuses a PAN that contradicts it. */
  private checkedPan(gstin: string | null | undefined, pan: string | null | undefined) {
    if (!gstin) return pan;
    const fromGstin = panFromGstin(gstin);
    if (pan && pan !== fromGstin) {
      throw new BadRequestException('The PAN does not match the GSTIN');
    }
    return fromGstin;
  }

  /** Refuses a place of supply that contradicts the GSTIN (a trigger copies the GSTIN's). */
  private checkPlaceOfSupply(
    gstin: string | null | undefined,
    placeOfSupply: string | null | undefined,
  ) {
    if (gstin && placeOfSupply && placeOfSupply !== stateCodeFromGstin(gstin)) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Invalid request',
        issues: [{ path: 'placeOfSupply', message: "The GSTIN's state is the place of supply" }],
      });
    }
  }

  private async replaceRoles(
    tx: Transaction,
    organizationId: string,
    partyId: string,
    roles: readonly PartyRole[],
  ): Promise<void> {
    await tx.delete(partyRoles).where(eq(partyRoles.partyId, partyId));
    await tx.insert(partyRoles).values(roles.map((role) => ({ organizationId, partyId, role })));
  }

  private async saveCustomer(
    tx: Transaction,
    organizationId: string,
    partyId: string,
    customer: CustomerView,
  ): Promise<void> {
    if (customer.assignedMemberId) {
      const [member] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.id, customer.assignedMemberId),
            eq(organizationMembers.isActive, true),
          ),
        );
      if (!member) throw new BadRequestException('Unknown salesperson');
    }
    await tx
      .insert(customerProfiles)
      .values({ partyId, organizationId, ...customer })
      .onConflictDoUpdate({
        target: customerProfiles.partyId,
        set: { ...customer, updatedAt: sql`now()` },
      });
  }

  /** Turns a duplicate phone or GSTIN into a 409 that points at the existing party. */
  private async mapDuplicates<T>(
    auth: AuthContext,
    fields: { phone?: string | null; gstin?: string | null },
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const byPhone = isUniqueViolation(error, ['parties_organization_phone_unique']);
      if (!byPhone && !isUniqueViolation(error, ['parties_organization_gstin_unique'])) throw error;
      const value = [byPhone ? fields.phone : fields.gstin].filter(
        (candidate): candidate is string => typeof candidate === 'string',
      );
      const [existing] = await withTenant(this.connection.db, auth.organization.id, (tx) =>
        tx
          .select({ id: parties.id })
          .from(parties)
          .where(inArray(byPhone ? parties.phone : parties.gstin, value)),
      );
      throw new ConflictException({
        statusCode: 409,
        message: byPhone
          ? 'A party with this mobile number already exists'
          : 'A party with this GSTIN already exists',
        /** Which field matched, for the duplicate warning. */
        field: byPhone ? 'phone' : 'gstin',
        existingPartyId: existing?.id,
      });
    }
  }
}
