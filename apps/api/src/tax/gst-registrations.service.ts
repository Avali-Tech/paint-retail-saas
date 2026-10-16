import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  canAccessStore,
  gstStateName,
  panFromGstin,
  type GstRegistrations,
  type StoreGstRegistration,
} from '@paint/shared';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { fieldError } from './tax-lookups.js';
import type { BusinessGstInput, StoreGstInput } from './tax.schemas.js';

const { organizations, stores } = schema;

const registrationFields = {
  storeId: stores.id,
  code: stores.code,
  name: stores.name,
  registrationType: stores.registrationType,
  stateCode: stores.stateCode,
  gstin: stores.gstin,
  legalName: stores.legalName,
  tradeName: stores.tradeName,
  addressLine: stores.addressLine,
  city: stores.city,
  pincode: stores.pincode,
};

/** The business's GST profile and each store's registration (GST is per state). */
@Injectable()
export class GstRegistrationsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  get(auth: AuthContext): Promise<GstRegistrations> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.view(tx, auth));
  }

  /** The legal name stores' registrations default to. */
  setBusiness(auth: AuthContext, input: BusinessGstInput): Promise<GstRegistrations> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await tx
        .update(organizations)
        .set({ legalName: input.legalName, updatedAt: sql`now()` })
        .where(eq(organizations.id, auth.organization.id));
      return this.view(tx, auth);
    });
  }

  /** Registers a store (or records that it is unregistered); see applyStoreRegistration. */
  setStore(auth: AuthContext, storeId: string, input: StoreGstInput): Promise<GstRegistrations> {
    if (!canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [store] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId));
      if (!store) throw new NotFoundException('Store not found');
      await applyStoreRegistration(tx, auth, storeId, input);
      return this.view(tx, auth);
    });
  }

  private async view(tx: Transaction, auth: AuthContext): Promise<GstRegistrations> {
    const [organization] = await tx
      .select({ legalName: organizations.legalName })
      .from(organizations)
      .where(eq(organizations.id, auth.organization.id));
    const rows: StoreGstRegistration[] = await tx
      .select(registrationFields)
      .from(stores)
      .where(auth.allStores ? undefined : inArray(stores.id, [...auth.storeIds]))
      .orderBy(stores.code);
    const registered = rows.find((row) => row.registrationType !== 'unregistered');
    return {
      legalName: organization?.legalName ?? null,
      pan: registered?.gstin ? panFromGstin(registered.gstin) : null,
      stores: rows,
    };
  }
}

/**
 * Saves a store's registration (or that it is unregistered) in `tx`; also used
 * when a store is created with its registration (POST /stores). Every GSTIN of
 * a business carries the same PAN, so a GSTIN with another PAN is refused.
 */
export async function applyStoreRegistration(
  tx: Transaction,
  auth: AuthContext,
  storeId: string,
  input: StoreGstInput,
): Promise<void> {
  const registered = input.registrationType !== 'unregistered';
  const gstin = input.gstin ?? null;
  if (gstin !== null) await assertSamePan(tx, storeId, gstin);
  const legalName = registered ? await legalNameOf(tx, auth, input.legalName) : null;
  await tx
    .update(stores)
    .set({
      registrationType: input.registrationType,
      stateCode: input.stateCode,
      state: gstStateName(input.stateCode),
      gstin,
      legalName,
      tradeName: registered ? (input.tradeName ?? null) : null,
      addressLine: input.addressLine ?? null,
      city: input.city ?? null,
      pincode: input.pincode ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(stores.id, storeId));
}

async function legalNameOf(
  tx: Transaction,
  auth: AuthContext,
  given: string | undefined,
): Promise<string> {
  if (given !== undefined) return given;
  const [organization] = await tx
    .select({ legalName: organizations.legalName })
    .from(organizations)
    .where(eq(organizations.id, auth.organization.id));
  if (!organization?.legalName) {
    throw fieldError('legalName', 'Enter the legal name on the registration certificate');
  }
  return organization.legalName;
}

async function assertSamePan(tx: Transaction, storeId: string, gstin: string): Promise<void> {
  const [other] = await tx
    .select({ gstin: stores.gstin })
    .from(stores)
    .where(
      and(
        ne(stores.id, storeId),
        ne(stores.registrationType, 'unregistered'),
        isNotNull(stores.gstin),
        sql`substr(${stores.gstin}, 3, 10) <> ${panFromGstin(gstin)}`,
      ),
    )
    .limit(1);
  if (other) {
    throw fieldError('gstin', "This GSTIN has another PAN than the business's other registrations");
  }
}
