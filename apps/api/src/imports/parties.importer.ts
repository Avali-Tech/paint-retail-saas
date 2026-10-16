import { schema, type Transaction } from '@paint/db';
import { canAccessStore, formatINR, panFromGstin, type Permission } from '@paint/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { email, phone } from '../auth/auth.schemas.js';
import { MAX_CREDIT_DAYS, MAX_CREDIT_LIMIT_PAISE, setCreditTerms } from '../credit/credit-terms.js';
import { canSeeParty } from '../parties/party-access.js';
import { CUSTOMER_TYPES, gstin, PARTY_ROLES, pan, pincode } from '../parties/parties.schemas.js';
import { choice, decimal, list, optional, required, rupees, text } from './import-cells.js';
import {
  FirstSeen,
  unique,
  type ImportAction,
  type Importer,
  type RowPlan,
} from './import-types.js';

const { creditProfiles, creditRequests, customerProfiles, parties, partyRoles, stores } = schema;

/** Who may set credit by import: approvers, as approving a credit request does (PO-101). */
export const IMPORT_CREDIT_PERMISSION: Permission = 'credit:approve';

interface CreditTerms {
  readonly limitPaise: number;
  readonly creditDays: number;
}

type PartyRole = (typeof PARTY_ROLES)[number];
type PartyRow = z.output<typeof row>;
type PartyRecord = typeof parties.$inferSelect;
type PartyChanges = Partial<typeof parties.$inferInsert>;

const row = z
  .object({
    name: required(text(2, 160)),
    roles: required(list.pipe(z.array(choice(PARTY_ROLES)))),
    kind: optional(choice(['person', 'organization'])),
    phone: optional(phone),
    alternate_phone: optional(phone),
    email: optional(email),
    gstin: optional(gstin),
    pan: optional(pan),
    legal_name: optional(text(1, 160)),
    contact_person: optional(text(1, 120)),
    address: optional(text(1, 300)),
    city: optional(text(1, 80)),
    state: optional(text(1, 80)),
    pincode: optional(pincode),
    home_store: optional(z.string().toUpperCase()),
    customer_type: optional(choice(CUSTOMER_TYPES)),
    tags: list.pipe(
      z.array(z.string().toLowerCase().max(30, 'Tags have at most 30 characters')).max(20),
    ),
    notes: optional(text(1, 2000)),
    credit_limit: optional(
      rupees.pipe(
        z
          .number()
          .positive('Must be more than zero')
          .max(MAX_CREDIT_LIMIT_PAISE, 'At most ₹10,00,00,000'),
      ),
    ),
    credit_days: optional(
      decimal.pipe(
        z
          .number()
          .int('Enter whole days')
          .min(0, 'Cannot be negative')
          .max(MAX_CREDIT_DAYS, `At most ${String(MAX_CREDIT_DAYS)} days`),
      ),
    ),
  })
  .refine((cells) => cells.phone !== undefined || cells.gstin !== undefined, {
    path: ['phone'],
    message: 'Enter a mobile number or a GSTIN, so the row matches the same party next time',
  })
  .refine((cells) => cells.customer_type === undefined || cells.roles.includes('customer'), {
    path: ['customer_type'],
    message: 'Only for parties with the customer role',
  });

interface PlannedParty {
  readonly row: number;
  readonly value: PartyRow;
  readonly action: ImportAction;
  readonly existing: PartyRecord | undefined;
  readonly fields: PartyChanges;
  readonly newRoles: PartyRole[];
  /** Customer type to save, when the customer profile is new or changes. */
  readonly customer: {
    readonly type: (typeof CUSTOMER_TYPES)[number];
    readonly isNew: boolean;
  } | null;
  /** Credit limit and days to give, when new or changed. */
  readonly credit: CreditTerms | null;
}

export const partiesImporter: Importer<PartyRow> = {
  kind: 'parties',
  title: 'Customers, suppliers, contractors and painters',
  permission: 'parties:manage',
  columns: [
    {
      name: 'name',
      required: true,
      description: 'Name as you know them',
      example: 'Sharma Constructions',
    },
    {
      name: 'roles',
      required: true,
      description: `Any of: ${PARTY_ROLES.join(', ')}; separate with ;`,
      example: 'customer;contractor',
    },
    {
      name: 'kind',
      required: false,
      description: 'person or organization',
      example: 'organization',
    },
    {
      name: 'phone',
      required: false,
      description: 'Mobile number; this or the GSTIN matches the party next time',
      example: '9876543210',
    },
    { name: 'alternate_phone', required: false, description: 'Another number', example: '' },
    {
      name: 'email',
      required: false,
      description: 'Email address',
      example: 'accounts@sharma.example',
    },
    {
      name: 'gstin',
      required: false,
      description: 'GSTIN; fills in the PAN',
      example: '36AABCU9603R1ZO',
    },
    { name: 'pan', required: false, description: 'PAN, for parties without a GSTIN', example: '' },
    { name: 'legal_name', required: false, description: 'Registered name', example: '' },
    {
      name: 'contact_person',
      required: false,
      description: 'Who to speak to',
      example: 'Ravi Sharma',
    },
    {
      name: 'address',
      required: false,
      description: 'Street address',
      example: 'Plot 12, Banjara Hills',
    },
    { name: 'city', required: false, description: 'City', example: 'Hyderabad' },
    { name: 'state', required: false, description: 'State', example: 'Telangana' },
    { name: 'pincode', required: false, description: '6-digit PIN code', example: '500034' },
    {
      name: 'home_store',
      required: false,
      description: 'Store code; blank = whole business',
      example: 'HYD',
    },
    {
      name: 'customer_type',
      required: false,
      description: `For customers: ${CUSTOMER_TYPES.join(', ')}`,
      example: 'contractor',
    },
    { name: 'tags', required: false, description: 'Labels; separate with ;', example: 'vip' },
    { name: 'notes', required: false, description: 'Anything else', example: '' },
    {
      name: 'credit_limit',
      required: false,
      description:
        'Credit limit in rupees, for customers; credit approvers only. Blank keeps the current limit',
      example: '100000',
    },
    {
      name: 'credit_days',
      required: false,
      description: `Days to pay, 0 to ${String(MAX_CREDIT_DAYS)}; needed with a party's first limit. Blank keeps the current days`,
      example: '30',
    },
  ],
  row,

  async plan(tx, auth, rows, fail) {
    // Each phone number and GSTIN can identify only one row.
    const phones = new FirstSeen<string>();
    const gstins = new FirstSeen<string>();
    const checked = rows.filter(({ row: rowNumber, value }) => {
      const phoneRow = value.phone ? phones.check(value.phone, rowNumber) : undefined;
      const gstinRow = value.gstin ? gstins.check(value.gstin, rowNumber) : undefined;
      if (phoneRow) fail(rowNumber, 'phone', `Also on row ${String(phoneRow)}`);
      if (gstinRow) fail(rowNumber, 'gstin', `Also on row ${String(gstinRow)}`);
      return !phoneRow && !gstinRow;
    });

    const values = checked.map((parsed) => parsed.value);
    const storeCodes = unique(values.flatMap((v) => (v.home_store ? [v.home_store] : [])));
    const storeRows = await tx
      .select({ id: stores.id, code: stores.code, isActive: stores.isActive })
      .from(stores)
      .where(inArray(stores.code, storeCodes));
    const storesByCode = new Map(storeRows.map((store) => [store.code, store]));
    const matches = await tx
      .select()
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
    const ids = matches.map((p) => p.id);
    const roleRows = await tx
      .select({ partyId: partyRoles.partyId, role: partyRoles.role })
      .from(partyRoles)
      .where(inArray(partyRoles.partyId, ids));
    const rolesOf = (partyId: string) =>
      roleRows.filter((entry) => entry.partyId === partyId).map((entry) => entry.role);
    const customerTypes = new Map(
      (
        await tx
          .select({ partyId: customerProfiles.partyId, type: customerProfiles.customerType })
          .from(customerProfiles)
          .where(inArray(customerProfiles.partyId, ids))
      ).map((profile) => [profile.partyId, profile.type]),
    );
    const creditOf = new Map(
      (
        await tx
          .select({
            partyId: creditProfiles.partyId,
            status: creditProfiles.status,
            limitPaise: creditProfiles.limitPaise,
            creditDays: creditProfiles.creditDays,
          })
          .from(creditProfiles)
          .where(inArray(creditProfiles.partyId, ids))
      ).map((profile) => [profile.partyId, profile]),
    );
    const pendingRequests = new Map(
      (
        await tx
          .select({ partyId: creditRequests.partyId, number: creditRequests.number })
          .from(creditRequests)
          .where(and(inArray(creditRequests.partyId, ids), eq(creditRequests.status, 'pending')))
      ).map((request) => [request.partyId, request.number]),
    );

    /**
     * The credit a row gives (null for none or no change), or why it cannot:
     * blank cells keep the party's current limit and days; a party without
     * credit needs both.
     */
    const creditFor = (
      value: PartyRow,
      existing: PartyRecord | undefined,
      isCustomer: boolean,
    ): CreditTerms | null | [string, string] => {
      if (value.credit_limit === undefined && value.credit_days === undefined) return null;
      if (!auth.permissions.has(IMPORT_CREDIT_PERMISSION)) {
        return [
          'credit_limit',
          'Only credit approvers can set credit by import; ask for credit on the customer page',
        ];
      }
      if (!isCustomer) return ['credit_limit', 'Credit is for customers: add the customer role'];
      const pending = existing ? pendingRequests.get(existing.id) : undefined;
      if (pending) {
        return ['credit_limit', `${pending} is waiting for approval: approve or reject it first`];
      }
      const current = existing ? creditOf.get(existing.id) : undefined;
      const has = current !== undefined && current.status !== 'none';
      const limitPaise = value.credit_limit ?? (has ? current.limitPaise : undefined);
      const creditDays = value.credit_days ?? (has ? current.creditDays : undefined);
      if (limitPaise === undefined) {
        return ['credit_limit', 'Enter a credit limit: this party has no credit yet'];
      }
      if (creditDays === undefined) {
        return ['credit_days', 'Enter the credit days: this party has no credit yet'];
      }
      const unchanged =
        has && current.limitPaise === limitPaise && current.creditDays === creditDays;
      return unchanged ? null : { limitPaise, creditDays };
    };

    const planned: PlannedParty[] = [];
    for (const { row: rowNumber, value } of checked) {
      const problems: [string, string][] = [];
      let homeStoreId: string | null | undefined;
      if (value.home_store) {
        const store = storesByCode.get(value.home_store);
        if (!store?.isActive) problems.push(['home_store', 'Unknown store code']);
        else if (!canAccessStore(auth, store.id)) {
          problems.push(['home_store', 'You cannot add parties to a store you cannot access']);
        } else homeStoreId = store.id;
      }
      const viaPhone = value.phone ? byPhone.get(value.phone) : undefined;
      const viaGstin = value.gstin ? byGstin.get(value.gstin) : undefined;
      if (viaPhone && viaGstin && viaPhone.id !== viaGstin.id) {
        problems.push([
          'phone',
          `This number is ${viaPhone.displayName}'s, but the GSTIN is ${viaGstin.displayName}'s`,
        ]);
      }
      const existing = viaGstin ?? viaPhone;
      if (existing && !canSeeParty(auth, existing)) {
        problems.push(['name', 'Matches a party at a store you cannot access']);
      }
      const effectiveGstin = value.gstin ?? existing?.gstin;
      let panValue = value.pan;
      if (effectiveGstin) {
        panValue = panFromGstin(effectiveGstin);
        if (value.pan && value.pan !== panValue)
          problems.push(['pan', 'The PAN does not match the GSTIN']);
      }
      if (problems.length > 0) {
        for (const [column, message] of problems) fail(rowNumber, column, message);
        continue;
      }

      const wanted: Record<string, unknown> = {
        kind: value.kind,
        displayName: value.name,
        legalName: value.legal_name,
        contactPerson: value.contact_person,
        phone: value.phone,
        alternatePhone: value.alternate_phone,
        email: value.email,
        gstin: value.gstin,
        pan: panValue,
        addressLine: value.address,
        city: value.city,
        state: value.state,
        pincode: value.pincode,
        homeStoreId,
        notes: value.notes,
      };
      // Blank cells leave what is already saved alone.
      const fields = Object.fromEntries(
        Object.entries(wanted).filter(
          ([key, wantedValue]) =>
            wantedValue !== undefined && existing?.[key as keyof PartyRecord] !== wantedValue,
        ),
      ) as PartyChanges;
      const currentTags = existing?.tags ?? [];
      const tags = unique([...currentTags, ...value.tags]);
      if (tags.length !== currentTags.length) fields.tags = tags;

      const currentRoles = existing ? rolesOf(existing.id) : [];
      const newRoles = value.roles.filter((role) => !currentRoles.includes(role));
      const isCustomer = [...currentRoles, ...newRoles].includes('customer');
      const currentType = existing ? customerTypes.get(existing.id) : undefined;
      const customerType = value.customer_type ?? currentType ?? 'retail';
      const customer =
        isCustomer && (currentType === undefined || customerType !== currentType)
          ? { type: customerType, isNew: currentType === undefined }
          : null;
      const credit = creditFor(value, existing, isCustomer);
      if (Array.isArray(credit)) {
        fail(rowNumber, credit[0], credit[1]);
        continue;
      }

      const action: ImportAction = !existing
        ? 'create'
        : Object.keys(fields).length > 0 || newRoles.length > 0 || customer || credit
          ? 'update'
          : 'unchanged';
      planned.push({ row: rowNumber, value, action, existing, fields, newRoles, customer, credit });
    }

    return {
      rows: planned.map(({ row: rowNumber, value, action, credit }): RowPlan => ({
        row: rowNumber,
        action,
        label: credit
          ? `${value.name} · credit ${formatINR(credit.limitPaise)}, ${String(credit.creditDays)} days`
          : value.name,
      })),
      apply: (applyTx) => apply(applyTx, auth, planned),
    };
  },
};

async function apply(tx: Transaction, auth: AuthContext, planned: PlannedParty[]): Promise<void> {
  const organizationId = auth.organization.id;
  for (const { action, existing, fields, newRoles, customer, credit, value } of planned) {
    if (action === 'unchanged') continue;
    let partyId: string;
    if (existing) {
      partyId = existing.id;
      if (Object.keys(fields).length > 0) {
        await tx
          .update(parties)
          .set({ ...fields, updatedAt: sql`now()` })
          .where(eq(parties.id, partyId));
      }
    } else {
      partyId = crypto.randomUUID();
      await tx
        .insert(parties)
        .values({ ...fields, id: partyId, organizationId, displayName: value.name });
    }
    if (newRoles.length > 0) {
      await tx
        .insert(partyRoles)
        .values(newRoles.map((role) => ({ organizationId, partyId, role })));
    }
    if (customer?.isNew) {
      await tx
        .insert(customerProfiles)
        .values({ organizationId, partyId, customerType: customer.type });
    } else if (customer) {
      await tx
        .update(customerProfiles)
        .set({ customerType: customer.type, updatedAt: sql`now()` })
        .where(eq(customerProfiles.partyId, partyId));
    }
    if (credit) await setCreditTerms(tx, organizationId, partyId, credit, auth.memberId);
  }
}
