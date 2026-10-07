import { createHash, randomUUID } from 'node:crypto';
import {
  createDatabase,
  postStockMovementsInBulk,
  runAsMember,
  schema,
  sql,
  withTenant,
  type BulkStockMovement,
  type TenantTransaction,
} from '@paint/db';
import { formatDocumentNumber, type AuthProfile } from '@paint/shared';
import type { PgInsertValue, PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { BRAND_CODES } from './catalogue.js';
import { dayOpensAt, indiaDate } from './history-clock.js';
import { personName } from './identity.js';
import {
  buildLargeCatalogue,
  buildLargeParties,
  EXTRA_BRANDS,
  EXTRA_STORES,
  weighted,
  type LargePartyPlan,
  type LargeScale,
} from './large-plan.js';
import { DEMO_PASSWORD, DEMO_SEED, surname } from './plan.js';
import { Random } from './random.js';
import { must, type SeedContext } from './seed-context.js';
import { DEMO_LOYALTY } from './seed-setup.js';

const {
  activities,
  brands,
  customerProfiles,
  documentSequences,
  documents,
  goodsReceiptLines,
  goodsReceipts,
  leads,
  loyaltyAccounts,
  loyaltyLedger,
  lowStockAlerts,
  notifications,
  opportunities,
  parties,
  partyRoles,
  productBarcodes,
  productVariants,
  products,
  projectParties,
  projects,
  purchaseOrderLines,
  purchaseOrders,
  reorderRules,
  supplierProducts,
  supplierProfiles,
} = schema;

/** A store of the large shop and who works there. */
interface LargeStore {
  readonly id: string;
  readonly manager: string;
  readonly sales: string;
}

interface BulkVariant {
  readonly id: string;
  readonly brand: string;
  readonly costPaise: number;
}

interface BulkParty extends LargePartyPlan {
  readonly id: string;
}

/** A record activities and documents can be about. */
interface CrmRecord {
  readonly type: 'party' | 'lead' | 'opportunity' | 'project';
  readonly id: string;
  readonly storeId: string;
  readonly assigned: string;
}

/** Rows per INSERT: inside PostgreSQL's 65,535 parameters for the widest table here. */
const CHUNK = 2_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function insertAll<T extends PgTable>(
  tx: TenantTransaction,
  table: T,
  rows: readonly PgInsertValue<T>[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += CHUNK) {
    await tx.insert(table).values(rows.slice(start, start + CHUNK));
  }
}

/**
 * Adds a large shop's volume to the full demo (`DEMO_SIZE=large`): more stores
 * and staff through the API, then tens of thousands of products, parties,
 * stock movements, orders, leads, activities, documents (metadata only),
 * notifications and loyalty entries written in bulk inside the business's
 * tenant scope (row-level security applies), as its owner (the audit log names
 * them). Stock goes through postStockMovementsInBulk, so balances equal the
 * ledger; document numbers continue each series. Everything is back-dated
 * over `scale.historyDays` and comes from a fixed seed.
 */
export async function seedLargeShop(
  context: SeedContext,
  databaseUrl: string,
  scale: LargeScale,
  now: Date,
): Promise<void> {
  const random = new Random(DEMO_SEED + 100);
  const owner = context.as('owner');
  const { organization } = await owner.get<AuthProfile>('/auth/me');
  const organizationId = organization.id;
  const ownerId = context.memberId('owner');

  const stores: LargeStore[] = context.plan.stores.map((store) => ({
    id: context.storeId(store.key),
    manager: context.memberId(context.managerOf(store.key)),
    sales: context.memberId(context.salesOf(store.key)),
  }));
  const roles = await owner.get<{ id: string; key: string }[]>('/roles');
  const roleId = (key: string) =>
    must(
      roles.find((role) => role.key === key),
      key,
    ).id;
  const { gstin } = must(context.plan.stores[0], 'store');
  for (const [index, extra] of EXTRA_STORES.slice(0, scale.extraStores).entries()) {
    const store = await owner.post('/stores', {
      name: extra.name,
      code: extra.code,
      city: 'Hyderabad',
      state: 'Telangana',
      gstin,
    });
    const hire = async (role: string, mobile: string) =>
      (
        await owner.post('/members', {
          fullName: personName(random),
          phone: `+91${mobile}`,
          password: DEMO_PASSWORD,
          roleId: roleId(role),
          allStores: false,
          storeIds: [store.id],
        })
      ).id;
    stores.push({
      id: store.id,
      manager: await hire('branch_manager', `900000005${String(index)}`),
      sales: await hire('sales_executive', `900000006${String(index)}`),
    });
  }
  context.count('stores', scale.extraStores);
  context.count('team members', 2 * scale.extraStores);

  /** A moment in business hours (10:00–19:00 India time) `daysAgo` days back. */
  const at = (daysAgo: number, fraction = random.next()) =>
    new Date(dayOpensAt(daysAgo, now).getTime() + fraction * 9 * HOUR);
  const pastDay = () => random.int(1, scale.historyDays);
  const later = (from: Date, maxDays: number) =>
    new Date(Math.min(from.getTime() + random.int(1, maxDays) * DAY, now.getTime() - HOUR));

  const connection = createDatabase(databaseUrl);
  const tenant = <T>(work: (tx: TenantTransaction) => Promise<T>) =>
    runAsMember(ownerId, () => withTenant(connection.db, organizationId, work));
  try {
    // ── Catalogue ───────────────────────────────────────────────────────────
    const brandIds = new Map(context.brandIds);
    const brandCodes: [string, string][] = [
      ...Object.entries(BRAND_CODES),
      ...EXTRA_BRANDS.map(([name, code]): [string, string] => [name, code]),
    ];
    const catalogue = buildLargeCatalogue(random, scale.products, brandCodes);
    const variants: BulkVariant[] = [];
    await tenant(async (tx) => {
      const newBrands = EXTRA_BRANDS.map(([name]) => ({ id: randomUUID(), organizationId, name }));
      for (const brand of newBrands) brandIds.set(brand.name, brand.id);
      await insertAll(tx, brands, newBrands);
      const productRows: PgInsertValue<typeof products>[] = [];
      const variantRows: PgInsertValue<typeof productVariants>[] = [];
      const barcodeRows: PgInsertValue<typeof productBarcodes>[] = [];
      for (const product of catalogue) {
        const productId = randomUUID();
        productRows.push({
          id: productId,
          organizationId,
          brandId: must(brandIds.get(product.brand), product.brand),
          categoryId: context.categoryIds.get(product.subcategory ?? product.category),
          name: product.name,
          type: product.type,
          hsnCode: product.hsnCode,
          gstRateBps: 1800,
          description: `${product.brand} ${product.name}`,
        });
        for (const variant of product.variants) {
          const id = randomUUID();
          variantRows.push({
            id,
            organizationId,
            productId,
            sku: variant.sku,
            packSize: variant.packSize,
            unit: variant.unit,
            mrpPaise: variant.mrpPaise,
            sellingPricePaise: variant.sellingPricePaise,
          });
          barcodeRows.push({ organizationId, barcode: variant.barcode, variantId: id });
          variants.push({ id, brand: product.brand, costPaise: variant.costPaise });
        }
      }
      await insertAll(tx, products, productRows);
      await insertAll(tx, productVariants, variantRows);
      await insertAll(tx, productBarcodes, barcodeRows);
    });
    context.count('products', catalogue.length);
    context.count('variants', variants.length);

    // ── Parties ─────────────────────────────────────────────────────────────
    const storyParties = [...context.parties.values()];
    const usedGstins = new Set(storyParties.flatMap((party) => party.gstin ?? []));
    const bulkParties: BulkParty[] = buildLargeParties(
      random,
      scale.parties,
      stores.length,
      usedGstins,
    ).map((party) => ({ ...party, id: randomUUID() }));
    const storeOf = (index: number) => must(stores[index], 'store');
    await tenant(async (tx) => {
      await insertAll(
        tx,
        parties,
        bulkParties.map((party) => ({
          id: party.id,
          organizationId,
          kind: party.kind,
          displayName: party.displayName,
          legalName: party.legalName,
          contactPerson: party.contactPerson,
          phone: party.phone,
          email: party.email,
          gstin: party.gstin,
          pan: party.gstin === null ? null : party.gstin.slice(2, 12),
          addressLine: party.addressLine,
          city: 'Hyderabad',
          state: 'Telangana',
          pincode: party.pincode,
          homeStoreId: party.homeStore === null ? null : storeOf(party.homeStore).id,
          tags: [...party.tags],
          createdAt: at(random.int(scale.historyDays, 2 * scale.historyDays)),
        })),
      );
      await insertAll(
        tx,
        partyRoles,
        bulkParties.flatMap((party) =>
          party.roles.map((role) => ({ organizationId, partyId: party.id, role })),
        ),
      );
      await insertAll(
        tx,
        customerProfiles,
        bulkParties.flatMap((party) =>
          party.customerType === null || party.homeStore === null
            ? []
            : [
                {
                  partyId: party.id,
                  organizationId,
                  customerType: party.customerType,
                  assignedMemberId: storeOf(party.homeStore).sales,
                  preferredContact:
                    party.kind === 'person' ? ('whatsapp' as const) : ('phone' as const),
                },
              ],
        ),
      );
      await insertAll(
        tx,
        supplierProfiles,
        bulkParties
          .filter((party) => party.segment === 'supplier')
          .map((party) => ({
            partyId: party.id,
            organizationId,
            paymentTermsDays: random.pick([15, 30, 45, 60]),
            leadTimeDays: random.int(2, 10),
          })),
      );
    });
    context.count('parties', bulkParties.length);

    // Each brand's distributor: the demo's suppliers and the new ones share the brands out.
    const suppliers = [
      ...storyParties.filter((party) => party.segment === 'supplier').map((party) => party.id),
      ...bulkParties.filter((party) => party.segment === 'supplier').map((party) => party.id),
    ];
    const supplierOf = new Map(
      brandCodes.map(([brand], index) => [
        brand,
        must(suppliers[index % suppliers.length], 'supplier'),
      ]),
    );

    // ── Stock, purchase orders and goods receipts ───────────────────────────
    const inEvents: BulkStockMovement[] = [];
    const stocked = stores.map(() => new Map<string, BulkVariant[]>());
    for (const variant of variants) {
      stores.forEach((store, index) => {
        if (!random.chance(scale.stockedShare)) return;
        const byBrand = must(stocked[index], 'store');
        let list = byBrand.get(variant.brand);
        if (list === undefined) {
          list = [];
          byBrand.set(variant.brand, list);
        }
        list.push(variant);
        inEvents.push({
          organizationId,
          storeId: store.id,
          variantId: variant.id,
          movementType: 'opening',
          quantity: random.int(8, 40),
          unitCostPaise: variant.costPaise,
          note: 'Opening stock',
          createdByMemberId: store.manager,
          createdAt: at(scale.historyDays, random.next() / 4),
        });
      });
    }
    const openings = inEvents.length;
    context.count('opening stock lines', openings);

    const orderRows: PgInsertValue<typeof purchaseOrders>[] = [];
    const orderLineRows: PgInsertValue<typeof purchaseOrderLines>[] = [];
    const receiptRows: PgInsertValue<typeof goodsReceipts>[] = [];
    const receipts: { id: string; manager: string }[] = [];
    const receiptLineRows: PgInsertValue<typeof goodsReceiptLines>[] = [];
    // Every store stocks a share of the catalogue, so each has brands to order.
    const stockedStores = stocked.map((byBrand, index) => ({
      index,
      brands: [...byBrand.entries()],
    }));
    await tenant(async (tx) => {
      const numbers = await numbering(tx);
      for (let order = 0; order < scale.purchaseOrders; order++) {
        const { index, brands: stockedBrands } = random.pick(stockedStores);
        const store = storeOf(index);
        const [brand, lines] = random.pick(stockedBrands);
        const supplierPartyId = must(supplierOf.get(brand), brand);
        const ordered = random.sample(lines, Math.min(lines.length, random.int(3, 10)));
        const id = randomUUID();
        const placedDay = random.int(2, scale.historyDays - 1);
        const placedAt = at(placedDay);
        const status = weighted(random, [
          ['received', 60],
          ['partially_received', 10],
          ['open', 18],
          ['cancelled', 6],
          ['closed', 6],
        ] as const);
        const closedAt = status === 'cancelled' || status === 'closed' ? later(placedAt, 20) : null;
        orderRows.push({
          id,
          organizationId,
          number: formatDocumentNumber('PO', numbers.next('purchase_order')),
          supplierPartyId,
          storeId: store.id,
          status,
          expectedDate: indiaDate(placedDay - 5, now),
          createdByMemberId: store.manager,
          closedByMemberId: closedAt === null ? null : store.manager,
          closingReason: status === 'closed' ? 'Balance not needed any more' : null,
          createdAt: placedAt,
          closedAt,
          updatedAt: closedAt ?? placedAt,
        });
        const received = status !== 'open' && status !== 'cancelled';
        const receiptId = randomUUID();
        const receiptNumber = received
          ? formatDocumentNumber('GRN', numbers.next('goods_receipt'))
          : '';
        const receivedAt = at(Math.max(1, placedDay - random.int(1, 5)));
        ordered.forEach((variant, line) => {
          const quantity = random.int(6, 48);
          const short = status !== 'received' && line === 0;
          const got = received ? (short ? Math.ceil(quantity / 2) : quantity) : 0;
          orderLineRows.push({
            organizationId,
            purchaseOrderId: id,
            variantId: variant.id,
            orderedQuantity: quantity,
            unitCostPaise: variant.costPaise,
            receivedQuantity: got,
          });
          if (!received) return;
          const free = random.chance(0.1) ? Math.floor(got / 10) : 0;
          receiptLineRows.push({
            organizationId,
            goodsReceiptId: receiptId,
            variantId: variant.id,
            quantity: got,
            freeQuantity: free,
            unitCostPaise: variant.costPaise,
          });
          const base = {
            organizationId,
            storeId: store.id,
            variantId: variant.id,
            movementType: 'purchase_receipt' as const,
            referenceType: 'goods_receipt',
            referenceId: receiptId,
            createdByMemberId: store.manager,
          };
          inEvents.push({
            ...base,
            quantity: got,
            unitCostPaise: variant.costPaise,
            note: receiptNumber,
            createdAt: receivedAt,
          });
          if (free > 0) {
            inEvents.push({
              ...base,
              quantity: free,
              unitCostPaise: 0,
              note: `${receiptNumber} free (scheme)`,
              createdAt: receivedAt,
            });
          }
        });
        if (received) {
          receipts.push({ id: receiptId, manager: store.manager });
          receiptRows.push({
            id: receiptId,
            organizationId,
            number: receiptNumber,
            storeId: store.id,
            supplierPartyId,
            purchaseOrderId: id,
            supplierInvoiceNumber: `INV/${String(order + 1)}`,
            supplierInvoiceDate: indiaDate(Math.max(1, placedDay - 1), now),
            receivedByMemberId: store.manager,
            receivedAt,
          });
        }
      }
      await insertAll(tx, purchaseOrders, orderRows);
      await insertAll(tx, purchaseOrderLines, orderLineRows);
      await insertAll(tx, goodsReceipts, receiptRows);
      await insertAll(tx, goodsReceiptLines, receiptLineRows);
      await insertAll(
        tx,
        supplierProducts,
        variants.map((variant) => ({
          organizationId,
          supplierPartyId: must(supplierOf.get(variant.brand), variant.brand),
          variantId: variant.id,
          supplierSku: `D-${variant.id.slice(0, 8).toUpperCase()}`,
          lastCostPaise: variant.costPaise,
        })),
      );
      await numbers.save();
    });
    context.count('purchase orders', orderRows.length);
    context.count('goods receipts', receiptRows.length);

    // Sales and the odd write-off between the receipts, never taking stock below zero.
    const outCount = Math.max(0, scale.ledgerEntries - inEvents.length);
    const outEvents = Array.from({ length: outCount }, () => {
      const opening = must(inEvents[random.int(0, openings - 1)], 'opening');
      return { opening, createdAt: at(random.int(1, scale.historyDays - 1)), roll: random.next() };
    });
    const timeline = [
      ...inEvents.map((movement) => ({ time: Number(movement.createdAt), movement, out: null })),
      ...outEvents.map((out) => ({ time: out.createdAt.getTime(), movement: null, out })),
    ].sort((a, b) => a.time - b.time);
    const onHand = new Map<string, number>();
    const movements: BulkStockMovement[] = [];
    for (const { movement, out } of timeline) {
      if (movement !== null) {
        const key = `${movement.storeId}:${movement.variantId}`;
        onHand.set(key, (onHand.get(key) ?? 0) + movement.quantity);
        movements.push(movement);
        continue;
      }
      const { opening, createdAt, roll } = out;
      const key = `${opening.storeId}:${opening.variantId}`;
      // Opening stock (the first day) always comes before any sale.
      const held = Number(onHand.get(key));
      const quantity = Math.min(held, 1 + Math.floor(roll * 4));
      if (quantity === 0) continue;
      onHand.set(key, held - quantity);
      movements.push({
        organizationId,
        storeId: opening.storeId,
        variantId: opening.variantId,
        movementType: roll < 0.97 ? 'sale' : roll < 0.99 ? 'damage' : 'adjustment',
        quantity: -quantity,
        note: roll < 0.97 ? undefined : roll < 0.99 ? 'Damaged tin' : 'Count difference',
        createdByMemberId: opening.createdByMemberId,
        createdAt,
      });
    }
    const loadStarted = new Date();
    const ruleCount = await tenant(async (tx) => {
      await postStockMovementsInBulk(tx, movements);
      const rules = inEvents.slice(0, openings).filter(() => random.chance(0.5));
      const ruleRows = rules.map((opening) => {
        const reorderLevel = random.int(4, 12);
        return {
          organizationId,
          storeId: opening.storeId,
          variantId: opening.variantId,
          minQuantity: Math.floor(reorderLevel / 2),
          reorderLevel,
          maxQuantity: reorderLevel * 4,
          updatedByMemberId: opening.createdByMemberId,
        };
      });
      await insertAll(tx, reorderRules, ruleRows);
      const low = ruleRows.filter(
        (rule) => Number(onHand.get(`${rule.storeId}:${rule.variantId}`)) <= rule.reorderLevel,
      );
      // Already announced (the bell has the bulk notifications below), so the worker stays quiet.
      await insertAll(
        tx,
        lowStockAlerts,
        low.map((rule) => ({
          organizationId,
          storeId: rule.storeId,
          variantId: rule.variantId,
          alertedAt: at(1),
        })),
      );
      return ruleRows.length;
    });
    await backDateStockAudit(databaseUrl, organizationId, loadStarted);
    context.count('stock ledger entries', movements.length);
    context.count('reorder rules', ruleCount);

    // ── Leads, opportunities, projects ──────────────────────────────────────
    const customers = bulkParties.filter(
      (party): party is BulkParty & { homeStore: number } =>
        party.customerType !== null && party.homeStore !== null,
    );
    // Key accounts (builders, big contractors) bring a share of all the business.
    const keyAccounts = customers.slice(0, 25);
    const pickCustomer = () => random.pick(random.chance(0.15) ? keyAccounts : customers);
    const referrers = {
      architect: storyParties.filter((party) => party.segment === 'architect'),
      contractor: storyParties.filter((party) => party.segment === 'contractor'),
      painter: storyParties.filter((party) => party.segment === 'painter'),
    };
    const records: Record<CrmRecord['type'], CrmRecord[]> = {
      party: customers.map((party) => ({
        type: 'party',
        id: party.id,
        storeId: storeOf(party.homeStore).id,
        assigned: storeOf(party.homeStore).sales,
      })),
      lead: [],
      opportunity: [],
      project: [],
    };
    const leadRows: PgInsertValue<typeof leads>[] = [];
    const opportunityRows: PgInsertValue<typeof opportunities>[] = [];
    const projectRows: PgInsertValue<typeof projects>[] = [];
    const projectPartyRows: PgInsertValue<typeof projectParties>[] = [];
    const wonOpportunities: { id: string; partyId: string; storeIndex: number }[] = [];
    await tenant(async (tx) => {
      const numbers = await numbering(tx);
      for (let index = 0; index < scale.leads; index++) {
        const party = pickCustomer();
        const store = storeOf(party.homeStore);
        const assigned = random.chance(0.7) ? store.sales : store.manager;
        const stage = weighted(random, [
          ['new', 22],
          ['contacted', 18],
          ['qualified', 14],
          ['opportunity', 16],
          ['won', 12],
          ['lost', 18],
        ] as const);
        const source = weighted(random, [
          ['walk_in', 30],
          ['phone_call', 20],
          ['referral', 10],
          ['architect', 10],
          ['contractor', 10],
          ['painter', 8],
          ['website', 6],
          ['social_media', 6],
        ] as const);
        const referredBy =
          source === 'architect' || source === 'contractor' || source === 'painter'
            ? random.pick(referrers[source]).id
            : null;
        const createdAt = at(pastDay());
        const closed = stage === 'won' || stage === 'lost';
        const closedAt = closed ? later(createdAt, 30) : null;
        const value = random.int(20, 800) * 100_000;
        const id = randomUUID();
        const title = `${random.pick(JOBS)} for ${party.displayName}`;
        leadRows.push({
          id,
          organizationId,
          number: formatDocumentNumber('LD', numbers.next('lead')),
          storeId: store.id,
          partyId: party.id,
          title,
          requirement: `${String(random.int(2, 40) * 100)} sq ft, ${random.pick(['premium', 'mid-range', 'economy'])} finish`,
          source,
          referredByPartyId: referredBy,
          estimatedValuePaise: value,
          expectedOrderDate: indiaDate(-random.int(7, 60), now),
          assignedMemberId: assigned,
          stage,
          lostReason: stage === 'lost' ? random.pick(LOST_REASONS) : null,
          createdByMemberId: assigned,
          createdAt,
          updatedAt: closedAt ?? createdAt,
          closedAt,
        });
        records.lead.push({ type: 'lead', id, storeId: store.id, assigned });
        if (stage === 'opportunity' || (stage === 'won' && random.chance(0.6))) {
          const opportunityStage =
            stage === 'won'
              ? 'won'
              : weighted(random, [
                  ['discovery', 40],
                  ['proposal', 35],
                  ['negotiation', 25],
                ] as const);
          const opportunityId = randomUUID();
          opportunityRows.push({
            id: opportunityId,
            organizationId,
            number: formatDocumentNumber('OP', numbers.next('opportunity')),
            storeId: store.id,
            partyId: party.id,
            leadId: id,
            title,
            expectedValuePaise: value,
            expectedQuantity: random.int(20, 800),
            expectedOrderDate: indiaDate(-random.int(7, 45), now),
            categoryId: context.categoryIds.get(random.pick(['interior', 'exterior', 'putty'])),
            salespersonMemberId: assigned,
            probability: PROBABILITY[opportunityStage],
            stage: opportunityStage,
            createdByMemberId: assigned,
            createdAt,
            updatedAt: closedAt ?? createdAt,
            closedAt,
          });
          records.opportunity.push({
            type: 'opportunity',
            id: opportunityId,
            storeId: store.id,
            assigned,
          });
          if (stage === 'won') {
            wonOpportunities.push({
              id: opportunityId,
              partyId: party.id,
              storeIndex: party.homeStore,
            });
          }
        }
      }
      for (let index = 0; index < scale.projects; index++) {
        const party = pickCustomer();
        const from = index % 3 === 0 ? wonOpportunities.pop() : undefined;
        const storeIndex = from?.storeIndex ?? party.homeStore;
        const store = storeOf(storeIndex);
        const stage = weighted(random, [
          ['identified', 12],
          ['survey', 12],
          ['specification', 10],
          ['quotation', 12],
          ['negotiation', 10],
          ['order', 10],
          ['execution', 12],
          ['completed', 16],
          ['cancelled', 6],
        ] as const);
        const createdAt = at(pastDay());
        const closedAt =
          stage === 'completed' || stage === 'cancelled' ? later(createdAt, 40) : null;
        const startDay = random.int(-30, scale.historyDays);
        const id = randomUUID();
        const area = party.addressLine.slice(party.addressLine.lastIndexOf(', ') + 2);
        projectRows.push({
          id,
          organizationId,
          number: formatDocumentNumber('PJ', numbers.next('project')),
          storeId: store.id,
          name: `${random.pick(PROJECT_KINDS)}, ${area}`,
          customerPartyId: from?.partyId ?? party.id,
          opportunityId: from?.id ?? null,
          addressLine: party.addressLine,
          city: 'Hyderabad',
          state: 'Telangana',
          pincode: party.pincode,
          latitude: Number((17.3 + random.next() * 0.25).toFixed(6)),
          longitude: Number((78.3 + random.next() * 0.3).toFixed(6)),
          startDate: indiaDate(startDay, now),
          expectedCompletionDate: indiaDate(startDay - random.int(10, 90), now),
          estimatedAreaSqFt: random.int(8, 400) * 100,
          estimatedPaintLitres: random.int(20, 2_000),
          expectedOrderValuePaise: random.int(50, 5_000) * 100_000,
          stage,
          cancelReason: CANCEL_REASONS[stage],
          assignedMemberId: store.sales,
          createdByMemberId: store.manager,
          createdAt,
          updatedAt: closedAt ?? createdAt,
          closedAt,
        });
        for (const role of ['architect', 'contractor', 'painter'] as const) {
          if (random.chance(0.6)) {
            projectPartyRows.push({
              organizationId,
              projectId: id,
              partyId: random.pick(referrers[role]).id,
              role,
            });
          }
        }
        records.project.push({ type: 'project', id, storeId: store.id, assigned: store.sales });
      }
      await insertAll(tx, leads, leadRows);
      await insertAll(tx, opportunities, opportunityRows);
      await insertAll(tx, projects, projectRows);
      await insertAll(tx, projectParties, projectPartyRows);
      await numbers.save();
    });
    context.count('leads', leadRows.length);
    context.count('opportunities', opportunityRows.length);
    context.count('projects', projectRows.length);

    // ── Activities, documents, notifications ────────────────────────────────
    const keyRecords = records.party.slice(0, keyAccounts.length);
    const pickRecord = () => {
      const type = weighted(random, [
        ['party', 35],
        ['lead', 40],
        ['opportunity', 12],
        ['project', 13],
      ] as const);
      return random.pick(type === 'party' && random.chance(0.15) ? keyRecords : records[type]);
    };
    const activityRows: PgInsertValue<typeof activities>[] = [];
    for (let index = 0; index < scale.activities; index++) {
      const record = pickRecord();
      const state = weighted(random, [
        ['done', 82],
        ['open', 14],
        ['cancelled', 4],
      ] as const);
      const base = {
        organizationId,
        recordType: record.type,
        recordId: record.id,
        storeId: record.storeId,
        assignedMemberId: record.assigned,
        createdByMemberId: record.assigned,
      };
      if (state === 'open') {
        const when = weighted(random, [
          ['overdue', 35],
          ['today', 20],
          ['upcoming', 45],
        ] as const);
        const dueDay =
          when === 'overdue' ? random.int(1, 10) : when === 'today' ? 0 : -random.int(1, 14);
        const dueAt = at(dueDay);
        const createdAt = new Date(
          Math.min(dueAt.getTime(), now.getTime()) - random.int(1, 5) * DAY,
        );
        activityRows.push({
          ...base,
          type: random.pick(['follow_up', 'call', 'visit'] as const),
          subject: random.pick(FOLLOW_UPS),
          dueAt,
          // Reminders for what is already due went out on the day.
          remindedAt:
            dueAt.getTime() <= now.getTime() + 15 * 60_000
              ? new Date(dueAt.getTime() - 15 * 60_000)
              : null,
          createdAt,
          updatedAt: createdAt,
        });
        continue;
      }
      const moment = at(pastDay());
      activityRows.push({
        ...base,
        type: random.pick(['call', 'visit', 'meeting', 'whatsapp', 'email', 'note'] as const),
        subject: random.pick(TOUCHES),
        notes: random.chance(0.4) ? 'Discussed shades and quantities.' : null,
        outcome: state === 'done' ? random.pick(OUTCOMES) : null,
        dueAt: state === 'cancelled' ? moment : null,
        completedAt: state === 'done' ? moment : null,
        cancelledAt: state === 'cancelled' ? moment : null,
        createdAt: moment,
        updatedAt: moment,
      });
    }

    const documentRows: PgInsertValue<typeof documents>[] = [];
    const documentRecords = [
      ...records.party.map((record) => ({ ...record, categories: PARTY_DOCUMENTS })),
      ...records.lead.map((record) => ({ ...record, categories: SALES_DOCUMENTS })),
      ...records.project.map((record) => ({ ...record, categories: PROJECT_DOCUMENTS })),
      ...receipts.map((receipt) => ({
        type: 'goods_receipt' as const,
        id: receipt.id,
        assigned: receipt.manager,
        categories: RECEIPT_DOCUMENTS,
      })),
    ];
    for (let index = 0; index < scale.documents; index++) {
      const record = random.pick(documentRecords);
      const category = random.pick(record.categories);
      const photo = category.endsWith('photo');
      const id = randomUUID();
      const createdAt = at(pastDay());
      const deleted = random.chance(0.03);
      documentRows.push({
        id,
        organizationId,
        recordType: record.type,
        recordId: record.id,
        category,
        fileName: `${category.replaceAll('_', '-')}-${String(index + 1)}.${photo ? 'jpg' : 'pdf'}`,
        contentType: photo ? 'image/jpeg' : 'application/pdf',
        sizeBytes: random.int(40_000, 4_000_000),
        sha256: createHash('sha256')
          .update(`large-demo-document-${String(index)}`)
          .digest('hex'),
        // Metadata only: no file is stored, so downloading one answers that storage has nothing.
        storageKey: `${organizationId}/documents/${id}`,
        uploadedByMemberId: record.assigned,
        createdAt,
        deletedByMemberId: deleted ? record.assigned : null,
        deletedAt: deleted ? later(createdAt, 10) : null,
      });
    }

    const members = [ownerId, ...stores.flatMap((store) => [store.manager, store.sales])];
    const notificationRows: PgInsertValue<typeof notifications>[] = [];
    for (let index = 0; index < scale.notifications; index++) {
      const memberId = random.chance(0.25) ? ownerId : random.pick(members);
      const daysAgo = random.int(0, scale.historyDays);
      const createdAt =
        daysAgo === 0 ? new Date(now.getTime() - random.int(1, 8) * HOUR) : at(daysAgo);
      const unread = daysAgo <= 2 && random.chance(0.5);
      const kind = weighted(random, [
        ['follow_up_due', 50],
        ['low_stock', 35],
        ['loyalty_tier_reached', 15],
      ] as const);
      const record =
        kind === 'follow_up_due' ? random.pick(records.lead) : random.pick(records.party);
      const store = random.pick(stores);
      const content =
        kind === 'follow_up_due'
          ? {
              title: `Follow-up due: ${random.pick(FOLLOW_UPS)}`,
              body: 'A lead is waiting for a call back',
              link: `/leads/${record.id}`,
            }
          : kind === 'low_stock'
            ? {
                title: 'Stock at reorder level',
                body: `${String(random.int(2, 40))} products need reordering`,
                link: `/stock/low?storeId=${store.id}`,
              }
            : {
                title: 'Loyalty tier reached',
                body: 'A painter reached the Gold tier',
                link: `/parties/${record.id}`,
              };
      notificationRows.push({
        organizationId,
        memberId,
        event: kind,
        ...content,
        createdAt,
        readAt: unread ? null : new Date(createdAt.getTime() + random.int(1, 20) * HOUR),
      });
    }

    await tenant(async (tx) => {
      await insertAll(tx, activities, activityRows);
      await insertAll(tx, documents, documentRows);
      await insertAll(tx, notifications, notificationRows);
    });
    context.count('activities', activityRows.length);
    context.count('documents', documentRows.length);
    context.count('notifications', notificationRows.length);

    // ── Loyalty ─────────────────────────────────────────────────────────────
    const loyal = bulkParties
      .filter(
        (party): party is BulkParty & { homeStore: number } =>
          (party.segment === 'painter' || party.segment === 'contractor') &&
          party.homeStore !== null,
      )
      .slice(0, scale.loyaltyAccounts);
    const accounts = loyal.map((party) => ({
      id: randomUUID(),
      organizationId,
      partyId: party.id,
      assignedMemberId: storeOf(party.homeStore).sales,
      createdByMemberId: storeOf(party.homeStore).sales,
      createdAt: at(scale.historyDays),
    }));
    const entries = Array.from({ length: scale.loyaltyEntries }, () => ({
      account: random.pick(accounts),
      createdAt: at(random.int(1, scale.historyDays - 1)),
      roll: random.next(),
    })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const balances = new Map<string, number>();
    const ledgerRows: PgInsertValue<typeof loyaltyLedger>[] = entries.map(
      ({ account, createdAt, roll }, index) => {
        const balance = balances.get(account.id) ?? 0;
        const base = {
          organizationId,
          accountId: account.id,
          createdByMemberId: account.assignedMemberId,
          createdAt,
        };
        if (roll < 0.1 && balance >= DEMO_LOYALTY.minRedemptionPoints) {
          const points = Math.min(balance, random.int(DEMO_LOYALTY.minRedemptionPoints, 2_000));
          balances.set(account.id, balance - points);
          return {
            ...base,
            kind: 'redeem' as const,
            points: -points,
            note: 'Redeemed for a gift voucher',
          };
        }
        const expiresOn = indiaDate(
          Math.round((now.getTime() - createdAt.getTime()) / DAY) - DEMO_LOYALTY.expiryDays,
          now,
        );
        if (roll < 0.8) {
          const paise = random.int(100, 50_000) * 100;
          const points = Math.floor((paise * DEMO_LOYALTY.earnPoints) / DEMO_LOYALTY.earnPerPaise);
          balances.set(account.id, balance + points);
          return {
            ...base,
            kind: 'purchase' as const,
            points,
            manualPurchasePaise: paise,
            reference: `BILL-${String(index + 1)}`,
            expiresOn,
          };
        }
        const points = random.int(50, 500);
        balances.set(account.id, balance + points);
        return roll < 0.9
          ? { ...base, kind: 'award' as const, points, note: 'Site visit bonus', expiresOn }
          : { ...base, kind: 'campaign' as const, points, reference: 'Painter meet', expiresOn };
      },
    );
    await tenant(async (tx) => {
      await insertAll(tx, loyaltyAccounts, accounts);
      await insertAll(tx, loyaltyLedger, ledgerRows);
    });
    context.count('loyalty members', accounts.length);
    context.count('loyalty entries', ledgerRows.length);
  } finally {
    await connection.close();
  }
}

type Series = 'purchase_order' | 'goods_receipt' | 'lead' | 'opportunity' | 'project';

/**
 * Other paint shops on the platform, onboarded the way the platform's operators
 * do it (POST /platform/tenants), so the console's list of businesses is long.
 */
export async function onboardBusinesses(
  context: SeedContext,
  operatorToken: string,
  count: number,
): Promise<void> {
  const random = new Random(DEMO_SEED + 200);
  const operator = context.api.as(operatorToken);
  for (let index = 0; index < count; index++) {
    const owner = personName(random);
    await operator.post('/platform/tenants', {
      organizationName: `${surname(owner)} ${random.pick(SHOP_STYLES)} ${String(index + 1)}`,
      plan: random.pick(['trial', 'standard', 'enterprise'] as const),
      owner: { fullName: owner, phone: `+916${String(100_000_000 + index)}` },
    });
  }
  context.count('other businesses', count);
}

const SHOP_STYLES = ['Paints', 'Paint House', 'Hardware & Paints', 'Colour Centre'] as const;

/** Gap-free document numbers for rows written in bulk, saved back once at the end. */
async function numbering(tx: TenantTransaction) {
  const last: Record<Series, number> = {
    purchase_order: 0,
    goods_receipt: 0,
    lead: 0,
    opportunity: 0,
    project: 0,
  };
  const current = await tx
    .select({ series: documentSequences.series, lastValue: documentSequences.lastValue })
    .from(documentSequences);
  for (const row of current) {
    if (row.series in last) last[row.series as Series] = row.lastValue;
  }
  const organizationId = await tx.execute<{ id: string }>(
    sql`select current_setting('app.current_organization_id') as id`,
  );
  return {
    next(series: Series): number {
      last[series] += 1;
      return last[series];
    },
    async save(): Promise<void> {
      const { id } = must(organizationId.rows[0], 'organization');
      for (const [series, lastValue] of Object.entries(last)) {
        await tx
          .insert(documentSequences)
          .values({ organizationId: id, series, lastValue })
          .onConflictDoUpdate({
            target: [documentSequences.organizationId, documentSequences.series],
            set: { lastValue },
          });
      }
    },
  };
}

/**
 * The audit log stamps stock write-offs with the time they were written; the
 * bulk ledger is back-dated, so move their audit entries onto the ledger's
 * times. Like the history clock, this needs a superuser (the log refuses edits
 * otherwise) and is the demo's only way to give the log a past.
 */
async function backDateStockAudit(
  databaseUrl: string,
  organizationId: string,
  since: Date,
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `UPDATE audit_log a SET occurred_at = l.created_at
         FROM stock_ledger l
        WHERE a.organization_id = $1 AND a.table_name = 'stock_ledger'
          AND a.record_id = l.id::text AND a.occurred_at >= $2`,
      [organizationId, since.toISOString()],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

const JOBS = [
  '3BHK repaint',
  'Villa exterior',
  'Office interiors',
  'Apartment block exterior',
  'Waterproofing terrace',
  'Wood polish for doors',
  'New house painting',
  'Showroom makeover',
  'School repaint',
  'Hospital wing interiors',
] as const;

const PROJECT_KINDS = [
  'Villa repaint',
  'Apartment exterior',
  'Office fit-out',
  'Gated community',
  'Commercial complex',
  'Independent house',
] as const;

const LOST_REASONS = [
  'Went with a cheaper quote',
  'Customer postponed',
  'Bought from another dealer',
  'Budget cut',
] as const;

const PROBABILITY = { discovery: 20, proposal: 40, negotiation: 60, won: 100 } as const;

/** Only a cancelled project has a reason. */
const CANCEL_REASONS: Partial<Record<string, string>> = {
  cancelled: 'Customer postponed the work',
};

const FOLLOW_UPS = [
  'Call back about the quotation',
  'Visit site for measurements',
  'Share shade card',
  'Confirm delivery date',
  'Collect payment',
] as const;

const TOUCHES = [
  'Called about requirements',
  'Site visit',
  'Showed shade cards',
  'Sent quotation on WhatsApp',
  'Discussed credit terms',
  'Met the contractor',
] as const;

const OUTCOMES = [
  'Interested, wants a quotation',
  'Asked to call next week',
  'Order expected this month',
  'Comparing with another brand',
] as const;

const PARTY_DOCUMENTS = [
  'gst_certificate',
  'pan_card',
  'trade_licence',
  'cancelled_cheque',
] as const;
const SALES_DOCUMENTS = ['quotation', 'photo'] as const;
const PROJECT_DOCUMENTS = ['before_photo', 'after_photo', 'quotation'] as const;
const RECEIPT_DOCUMENTS = ['invoice', 'delivery_challan'] as const;
