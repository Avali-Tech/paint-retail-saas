import type { SessionGrant } from '@paint/shared';
import { CATEGORIES, type CategoryKey } from './catalogue.js';
import { DEMO_APP_NAME, DEMO_BUSINESS, DEMO_PASSWORD, DEMO_SLUG, type PartyPlan } from './plan.js';
import { must, type SeedContext, type SeededVariant } from './seed-context.js';

/** Reads the sign-in code texted to a mobile number (the seed's own SMS sender). */
export type ReadSmsCode = (phone: string) => string;

/** The demo business's look: a deep maroon and marigold, rounded and friendly. */
export const DEMO_BRANDING = {
  appName: DEMO_APP_NAME,
  primary: '#8c1d40',
  accent: '#c77700',
  mode: 'light',
  radius: 'large',
  density: 'comfortable',
  font: 'poppins',
} as const;

/** The loyalty programme: 1 point per ₹100, three tiers, points last a year. */
export const DEMO_LOYALTY = {
  earnPoints: 1,
  earnPerPaise: 10_000,
  tiers: [
    { name: 'Silver', minPoints: 0 },
    { name: 'Gold', minPoints: 2_500 },
    { name: 'Platinum', minPoints: 7_500 },
  ],
  expiryDays: 365,
  minRedemptionPoints: 500,
};

/**
 * Day one: the owner signs up, switches off the two-factor rule for the demo,
 * sets the branding, opens three stores and adds the team; everyone signs in
 * once (counter staff with a texted code).
 */
export async function setUpBusiness(context: SeedContext, readSmsCode: ReadSmsCode): Promise<void> {
  const { api, plan } = context;
  const { owner, team } = plan;
  const signup = await api.public.post<SessionGrant>('/auth/signup', {
    organizationName: DEMO_BUSINESS,
    fullName: owner.fullName,
    phone: owner.phone,
    email: owner.email,
    password: DEMO_PASSWORD,
  });
  const first = api.as(signup.token);
  // The demo signs in without an authenticator; one admin shows two-factor instead.
  await first.put('/organization/security', { twoFactorRequired: false });
  await first.post('/auth/logout');
  context.tokens.set(owner.key, await passwordSignIn(context, owner.phone));
  const o = context.as(owner.key);
  await o.put('/organization/branding', DEMO_BRANDING);
  // Shorter than the one sign-up derives from the name (sharma-paints-hardware).
  await o.put('/organization/slug', { slug: DEMO_SLUG });

  for (const store of plan.stores) {
    const created = await o.post('/stores', {
      name: store.name,
      code: store.code,
      city: store.city,
      state: store.state,
      gstin: store.gstin,
    });
    context.storeIds.set(store.key, created.id);
  }
  const roles = await o.get<{ id: string; key: string }[]>('/roles');
  for (const person of team) {
    const created = await o.post('/members', {
      fullName: person.fullName,
      phone: person.phone,
      ...(person.email === null ? {} : { email: person.email }),
      ...(person.hasPassword ? { password: DEMO_PASSWORD } : {}),
      roleId: must(
        roles.find((role) => role.key === person.roleKey),
        person.roleKey,
      ).id,
      allStores: person.allStores,
      storeIds: person.stores.map((store) => context.storeId(store)),
    });
    context.memberIds.set(person.key, created.id);
    context.tokens.set(
      person.key,
      person.hasPassword
        ? await passwordSignIn(context, person.phone)
        : await codeSignIn(context, person.phone, readSmsCode),
    );
  }
  const members = await o.get<{ id: string; user: { phone: string | null } }[]>('/members');
  context.memberIds.set(
    owner.key,
    must(
      members.find((m) => m.user.phone === owner.phone),
      'owner',
    ).id,
  );
  context.count('stores', plan.stores.length);
  context.count('team members', plan.team.length + 1);
}

async function passwordSignIn(context: SeedContext, phone: string): Promise<string> {
  const grant = await context.api.public.post<SessionGrant>('/auth/login', {
    identifier: phone,
    password: DEMO_PASSWORD,
  });
  return grant.token;
}

async function codeSignIn(
  context: SeedContext,
  phone: string,
  readSmsCode: ReadSmsCode,
): Promise<string> {
  await context.api.public.post('/auth/otp/request', { phone });
  const grant = await context.api.public.post<SessionGrant>('/auth/otp/verify', {
    phone,
    code: readSmsCode(phone),
  });
  return grant.token;
}

/** The catalogue (by the inventory manager), parties, suppliers and the programmes. */
export async function setUpCatalogueAndParties(context: SeedContext): Promise<void> {
  const { plan } = context;
  const inventory = context.as('inventory');
  for (const brand of new Set(plan.catalogue.map((product) => product.brand))) {
    context.brandIds.set(brand, (await inventory.post('/brands', { name: brand })).id);
  }
  for (const key of Object.keys(CATEGORIES) as CategoryKey[]) {
    const spec = CATEGORIES[key];
    const id = (await inventory.post('/categories', { name: spec.name })).id;
    context.categoryIds.set(key, id);
    for (const sub of 'subcategories' in spec ? spec.subcategories : []) {
      const subId = (await inventory.post('/categories', { name: sub.name, parentId: id })).id;
      context.categoryIds.set(sub.name, subId);
    }
  }
  for (const product of plan.catalogue) {
    const created = await inventory.post<{ variants: { id: string; sku: string }[] }>('/products', {
      brandId: context.brandIds.get(product.brand),
      categoryId: context.categoryIds.get(product.subcategory ?? product.category),
      name: product.name,
      type: product.type,
      hsnCode: product.hsnCode,
      gstRatePercent: product.gstRatePercent,
      description: `${product.brand} ${product.name}`,
      variants: product.variants.map((variant) => ({
        sku: variant.sku,
        packSize: variant.packSize,
        unit: variant.unit,
        label: variant.label,
        mrpPaise: variant.mrpPaise,
        sellingPricePaise: variant.sellingPricePaise,
        barcodes: [variant.barcode],
      })),
    });
    for (const variant of product.variants) {
      const { id } = must(
        created.variants.find((entry) => entry.sku === variant.sku),
        variant.sku,
      );
      context.variants.push({ ...variant, id, product } satisfies SeededVariant);
    }
  }
  context.count('products', plan.catalogue.length);
  context.count('variants', context.variants.length);

  // Originals now; near-duplicates turn up later, the way they do at a busy counter.
  for (const party of plan.parties.filter((entry) => entry.duplicateOf === null)) {
    await createParty(context, party);
  }

  const purchasing = context.as('inventory');
  for (const supplier of context.partiesOf('supplier')) {
    await purchasing.put(`/suppliers/${supplier.id}/profile`, {
      paymentTermsDays: context.random.pick([30, 45, 60]),
      leadTimeDays: context.random.int(2, 6),
    });
    const products = context.variants
      .filter((variant) => variant.product.brand === supplier.brand)
      .map((variant) => ({ variantId: variant.id, supplierSku: `D-${variant.sku}` }));
    await purchasing.put(`/suppliers/${supplier.id}/products`, { products });
  }

  await context.as('owner').put('/loyalty-settings', DEMO_LOYALTY);
}

/** Creates a party as someone who works at its home store (business-wide ones by the admin). */
export async function createParty(context: SeedContext, party: PartyPlan): Promise<string> {
  const creator = party.homeStore === null ? 'admin' : context.managerOf(party.homeStore);
  const isCustomer = party.roles.includes('customer');
  const created = await context.as(creator).post('/parties', {
    kind: party.kind,
    displayName: party.displayName,
    ...(party.legalName === null ? {} : { legalName: party.legalName }),
    ...(party.contactPerson === null ? {} : { contactPerson: party.contactPerson }),
    phone: party.phone,
    ...(party.alternatePhone === null ? {} : { alternatePhone: party.alternatePhone }),
    ...(party.gstin === null ? {} : { gstin: party.gstin }),
    addressLine: party.addressLine,
    city: 'Hyderabad',
    state: 'Telangana',
    pincode: party.pincode,
    ...(party.homeStore === null ? {} : { homeStoreId: context.storeId(party.homeStore) }),
    tags: party.tags,
    roles: party.roles,
    ...(isCustomer && party.customerType !== null && party.homeStore !== null
      ? {
          customer: {
            customerType: party.customerType,
            preferredContact: party.kind === 'person' ? 'whatsapp' : 'phone',
            assignedMemberId: context.memberId(context.salesOf(party.homeStore)),
          },
        }
      : {}),
  });
  context.parties.set(party.key, { ...party, id: created.id });
  context.count('parties');
  return created.id;
}
