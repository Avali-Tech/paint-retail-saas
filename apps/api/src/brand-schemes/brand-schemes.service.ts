import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  nextDocumentNumber,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import {
  assertScheme,
  canAccessStore,
  claimsAgeing,
  formatDocumentNumber,
  type BenefitReceiptView,
  type BrandClaimView,
  type BrandScheme,
  type SchemeClaimsReport,
  type SchemeDetail,
  type SchemeSummary,
  type SchemesOverview,
  type SchemeView,
} from '@paint/shared';
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import { idempotent } from '../billing/idempotency.js';
import { only } from '../common/only.js';
import { DATABASE } from '../database/database.module.js';
import type {
  AsOfQuery,
  ClaimBody,
  ClaimStatusBody,
  EndSchemeBody,
  ListSchemesQuery,
  ReceiptBody,
  SchemeBody,
} from './brand-schemes.schemas.js';
import { evaluateSchemes, loadSchemes } from './scheme-data.js';

const {
  brandBenefitReceipts,
  brandClaims,
  brandSchemeBenefits,
  brandSchemeItems,
  brandSchemeSlabs,
  brandSchemes,
  brands,
  categories,
  goodsReceipts,
  organizationMembers,
  productVariants,
  products,
  users,
} = schema;

/** Schemes the screens count: everything but drafts and cancelled ones. */
const COUNTED = ['active', 'closed'] as const;

async function claimViews(tx: Transaction, where: SQL | undefined): Promise<BrandClaimView[]> {
  const rows = await tx
    .select({ claim: brandClaims, filedBy: users.fullName })
    .from(brandClaims)
    .innerJoin(organizationMembers, eq(organizationMembers.id, brandClaims.filedByMemberId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(where)
    .orderBy(desc(brandClaims.filedOn), desc(brandClaims.number));
  return rows.map(({ claim, filedBy }) => ({
    id: claim.id,
    number: claim.number,
    schemeId: claim.schemeId,
    filedOn: claim.filedOn,
    claimedPaise: claim.claimedPaise,
    brandReference: claim.brandReference,
    note: claim.note,
    status: claim.status,
    resolvedAt: claim.resolvedAt ? claim.resolvedAt.toISOString() : null,
    resolutionNote: claim.resolutionNote,
    filedBy,
  }));
}

/** Every scheme matching the filters, with its progress and claim as of a day. */
export async function schemeSummaries(
  tx: Transaction,
  query: ListSchemesQuery,
): Promise<SchemeSummary[]> {
  const asOf = query.asOf ?? (await indiaToday(tx));
  const records = await loadSchemes(
    tx,
    and(
      query.status ? eq(brandSchemes.status, query.status) : undefined,
      query.brandId ? eq(brandSchemes.brandId, query.brandId) : undefined,
    ),
  );
  const evaluated = await evaluateSchemes(tx, records, asOf);
  return evaluated.map(({ record, progress, claim }) => ({
    scheme: record.view,
    progress,
    claim,
  }));
}

/**
 * Active and closed schemes' claims as of a day. Ageing counts active schemes only: a
 * closed scheme expects nothing more, so what it still had owed is written off.
 */
export async function claimsReport(tx: Transaction, query: AsOfQuery): Promise<SchemeClaimsReport> {
  const asOf = query.asOf ?? (await indiaToday(tx));
  const records = await loadSchemes(
    tx,
    and(
      inArray(brandSchemes.status, [...COUNTED]),
      query.brandId ? eq(brandSchemes.brandId, query.brandId) : undefined,
    ),
  );
  const evaluated = await evaluateSchemes(tx, records, asOf);
  const filed = await claimViews(
    tx,
    inArray(
      brandClaims.schemeId,
      records.map((record) => record.view.id),
    ),
  );
  const rows = evaluated.map(({ record, claim }) => ({
    scheme: {
      id: record.view.id,
      name: record.view.name,
      brand: record.view.brand,
      status: record.view.status,
      startsOn: record.view.startsOn,
      endsOn: record.view.endsOn,
    },
    claim,
    filed: filed.find((row) => row.schemeId === record.view.id) ?? null,
  }));
  const ageing = claimsAgeing(
    evaluated.filter(({ record }) => record.view.status === 'active').map((row) => row.claim),
  );
  return { asOf, ageing, rows };
}

/**
 * Brand schemes (roadmap P2-M33, spec §6.3 and §3.8): schemes and their slabs,
 * progress from the brand's GRNs, what the brand issued, and claims with their age.
 * Viewing needs `purchasing:read`; changing anything needs `schemes:manage`
 * (controller). Figures are the business's: a scheme counts GRNs at every store, but
 * the GRN lines listed on a scheme are only those of the member's stores.
 */
@Injectable()
export class BrandSchemesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  private tenant<T>(auth: AuthContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return withTenant(this.connection.db, auth.organization.id, work);
  }

  list(auth: AuthContext, query: ListSchemesQuery): Promise<SchemeSummary[]> {
    return this.tenant(auth, (tx) => schemeSummaries(tx, query));
  }

  detail(auth: AuthContext, id: string, asOf?: string): Promise<SchemeDetail> {
    return this.tenant(auth, async (tx) =>
      this.detailIn(tx, auth, id, asOf ?? (await indiaToday(tx))),
    );
  }

  /** Active and closed schemes' claims: expected vs received, aged from their due dates. */
  claims(auth: AuthContext, query: AsOfQuery): Promise<SchemeClaimsReport> {
    return this.tenant(auth, (tx) => claimsReport(tx, query));
  }

  /** The dashboard tile: the nearest slab and what brands still owe. */
  overview(auth: AuthContext, asOf?: string): Promise<SchemesOverview> {
    return this.tenant(auth, async (tx) => {
      const day = asOf ?? (await indiaToday(tx));
      const records = await loadSchemes(tx, eq(brandSchemes.status, 'active'));
      const evaluated = await evaluateSchemes(tx, records, day);
      let nearest: SchemesOverview['nearest'] = null;
      let nearestShare = Number.POSITIVE_INFINITY;
      let outstanding = 0n;
      let openClaims = 0;
      let overdueClaims = 0;
      for (const { record, progress, claim } of evaluated) {
        outstanding += BigInt(Math.max(claim.money.outstandingPaise, 0));
        if (claim.final && claim.status === 'open') {
          openClaims += 1;
          if (claim.daysPastDue > 0) overdueClaims += 1;
        }
        const { next } = progress;
        // Running schemes only; nearest = the smallest share of its next target still to buy.
        if (next === null || progress.remainingDays === 0 || progress.elapsedDays === 0) continue;
        const share = next.distance / next.target;
        if (share < nearestShare) {
          nearestShare = share;
          nearest = {
            schemeId: record.view.id,
            schemeName: record.view.name,
            brandName: record.view.brand.name,
            measure: record.view.measure,
            distance: next.distance,
            perDayNeeded: next.perDayNeeded,
            remainingDays: progress.remainingDays,
          };
        }
      }
      return {
        asOf: day,
        activeSchemes: records.length,
        nearest,
        outstandingPaise: Number(outstanding),
        openClaims,
        overdueClaims,
      };
    });
  }

  create(auth: AuthContext, body: SchemeBody): Promise<SchemeView> {
    return this.tenant(auth, async (tx) => {
      await this.checkScheme(tx, body, null);
      const [row] = await tx
        .insert(brandSchemes)
        .values({
          organizationId: auth.organization.id,
          ...this.columns(body),
          brandId: body.brandId,
          createdByMemberId: auth.memberId,
        })
        .returning({ id: brandSchemes.id });
      const id = String(row?.id);
      await this.writeParts(tx, auth, id, body);
      return this.view(tx, id);
    });
  }

  update(auth: AuthContext, id: string, body: SchemeBody): Promise<SchemeView> {
    return this.tenant(auth, async (tx) => {
      const current = await this.locked(tx, id);
      if (current.status === 'closed' || current.status === 'cancelled') {
        throw new ConflictException(`A ${current.status} scheme cannot be changed`);
      }
      if (current.brandId !== body.brandId) {
        throw new ConflictException('A scheme keeps its brand: cancel it and enter a new one');
      }
      await this.checkScheme(tx, body, id);
      await tx
        .update(brandSchemes)
        .set({ ...this.columns(body), updatedAt: sql`now()` })
        .where(eq(brandSchemes.id, id));
      // Editing replaces what the scheme covers and its slabs (benefits go with them).
      await tx.delete(brandSchemeItems).where(eq(brandSchemeItems.schemeId, id));
      await tx.delete(brandSchemeSlabs).where(eq(brandSchemeSlabs.schemeId, id));
      await this.writeParts(tx, auth, id, body);
      return this.view(tx, id);
    });
  }

  /** A draft starts counting. */
  activate(auth: AuthContext, id: string): Promise<SchemeView> {
    return this.tenant(auth, async (tx) => {
      const current = await this.locked(tx, id);
      if (current.status !== 'draft') {
        throw new ConflictException(
          `Only a draft can be activated; this scheme is ${current.status}`,
        );
      }
      await tx
        .update(brandSchemes)
        .set({ status: 'active', updatedAt: sql`now()` })
        .where(eq(brandSchemes.id, id));
      return this.view(tx, id);
    });
  }

  /** Closes an active scheme (nothing more expected) or cancels a draft or active one. */
  end(
    auth: AuthContext,
    id: string,
    status: 'closed' | 'cancelled',
    body: EndSchemeBody,
  ): Promise<SchemeView> {
    return this.tenant(auth, async (tx) => {
      const current = await this.locked(tx, id);
      const allowed = status === 'closed' ? ['active'] : ['draft', 'active'];
      if (!allowed.includes(current.status)) {
        throw new ConflictException(
          status === 'closed'
            ? `Only an active scheme can be closed; this one is ${current.status}`
            : `This scheme is already ${current.status}`,
        );
      }
      await tx
        .update(brandSchemes)
        .set({
          status,
          endedAt: sql`now()`,
          endedByMemberId: auth.memberId,
          endNote: body.note,
          updatedAt: sql`now()`,
        })
        .where(eq(brandSchemes.id, id));
      return this.view(tx, id);
    });
  }

  /** Records a credit note, payment, free goods or points the brand issued. */
  recordReceipt(
    auth: AuthContext,
    id: string,
    body: ReceiptBody,
    idempotencyKey?: string,
  ): Promise<BenefitReceiptView> {
    const request = { method: 'POST', path: `/brand-schemes/${id}/receipts`, body };
    return this.tenant(auth, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        const current = await this.locked(tx, id);
        if (current.status !== 'active' && current.status !== 'closed') {
          throw new ConflictException(
            `Benefits are recorded on an active or closed scheme; this one is ${current.status}`,
          );
        }
        const today = await indiaToday(tx);
        if (body.receivedOn > today) throw new BadRequestException('Received in the future');
        if (body.claimId !== null) await this.claimOf(tx, body.claimId, id);
        const values = {
          organizationId: auth.organization.id,
          schemeId: id,
          kind: body.kind,
          receivedOn: body.receivedOn,
          reference: body.reference,
          note: body.note,
          claimId: body.claimId,
          recordedByMemberId: auth.memberId,
        };
        let row: { id: string } | undefined;
        switch (body.kind) {
          case 'money':
            [row] = await tx
              .insert(brandBenefitReceipts)
              .values({ ...values, amountPaise: body.amountPaise, moneyForm: body.moneyForm })
              .returning({ id: brandBenefitReceipts.id });
            break;
          case 'free_goods':
            await this.checkVariants(tx, [body.variantId]);
            if (body.goodsReceiptId !== null) {
              only(
                await tx
                  .select({ id: goodsReceipts.id })
                  .from(goodsReceipts)
                  .where(eq(goodsReceipts.id, body.goodsReceiptId)),
                'Goods receipt',
              );
            }
            [row] = await tx
              .insert(brandBenefitReceipts)
              .values({
                ...values,
                variantId: body.variantId,
                units: body.units,
                goodsReceiptId: body.goodsReceiptId,
              })
              .returning({ id: brandBenefitReceipts.id });
            break;
          case 'points':
            [row] = await tx
              .insert(brandBenefitReceipts)
              .values({ ...values, label: body.label, points: body.points })
              .returning({ id: brandBenefitReceipts.id });
            break;
        }
        const detail = await this.detailIn(tx, auth, id, today);
        return only(
          detail.receipts.filter((receipt) => receipt.id === row?.id),
          'Receipt',
        );
      }),
    );
  }

  /** Files a claim with the brand, by default for the money still owed on the day. */
  fileClaim(auth: AuthContext, id: string, body: ClaimBody): Promise<BrandClaimView> {
    return this.tenant(auth, async (tx) => {
      const current = await this.locked(tx, id);
      if (current.status !== 'active' && current.status !== 'closed') {
        throw new ConflictException(
          `Claims are filed on an active or closed scheme; this one is ${current.status}`,
        );
      }
      const today = await indiaToday(tx);
      if (body.filedOn > today) throw new BadRequestException('Filed in the future');
      let claimed = body.claimedPaise;
      if (claimed === undefined) {
        const detail = await this.detailIn(tx, auth, id, body.filedOn);
        claimed = Math.max(detail.claim.money.outstandingPaise, 0);
      }
      const number = formatDocumentNumber(
        'SC',
        await nextDocumentNumber(tx, auth.organization.id, 'brand_claim'),
      );
      const [row] = await tx
        .insert(brandClaims)
        .values({
          organizationId: auth.organization.id,
          schemeId: id,
          number,
          filedOn: body.filedOn,
          claimedPaise: claimed,
          brandReference: body.brandReference,
          note: body.note,
          filedByMemberId: auth.memberId,
        })
        .returning({ id: brandClaims.id });
      return only(await claimViews(tx, eq(brandClaims.id, String(row?.id))), 'Claim');
    });
  }

  /** Moves a claim on: acknowledged, settled, rejected or withdrawn. */
  setClaimStatus(
    auth: AuthContext,
    claimId: string,
    body: ClaimStatusBody,
  ): Promise<BrandClaimView> {
    return this.tenant(auth, async (tx) => {
      const [current] = await tx
        .select({ status: brandClaims.status, brandReference: brandClaims.brandReference })
        .from(brandClaims)
        .where(eq(brandClaims.id, claimId))
        .for('update');
      if (!current) throw new NotFoundException('Claim not found');
      const next: Record<string, readonly string[]> = {
        filed: ['acknowledged', 'settled', 'rejected', 'withdrawn'],
        acknowledged: ['settled', 'rejected', 'withdrawn'],
      };
      if (!(next[current.status] ?? []).includes(body.status)) {
        throw new ConflictException(
          `This claim is ${current.status}: it cannot become ${body.status}`,
        );
      }
      const resolved = body.status !== 'acknowledged';
      await tx
        .update(brandClaims)
        .set({
          status: body.status,
          brandReference: body.brandReference ?? current.brandReference,
          ...(resolved
            ? {
                resolvedAt: sql`now()`,
                resolvedByMemberId: auth.memberId,
                resolutionNote: body.note,
              }
            : body.note === null
              ? {}
              : { note: body.note }),
          updatedAt: sql`now()`,
        })
        .where(eq(brandClaims.id, claimId));
      return only(await claimViews(tx, eq(brandClaims.id, claimId)), 'Claim');
    });
  }

  private async detailIn(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    asOf: string,
  ): Promise<SchemeDetail> {
    const record = only(await loadSchemes(tx, eq(brandSchemes.id, id)), 'Scheme');
    const { lines, receipts, progress, claim } = only(
      await evaluateSchemes(tx, [record], asOf),
      'Scheme',
    );
    return {
      scheme: record.view,
      progress,
      claim,
      grnLines: lines.filter((line) => canAccessStore(auth, line.store.id)),
      receipts,
      claims: await claimViews(tx, eq(brandClaims.schemeId, id)),
    };
  }

  private async view(tx: Transaction, id: string): Promise<SchemeView> {
    return only(await loadSchemes(tx, eq(brandSchemes.id, id)), 'Scheme').view;
  }

  /** The scheme's row, locked for the rest of the transaction; 404 if not this business's. */
  private async locked(tx: Transaction, id: string) {
    return only(
      await tx
        .select({ status: brandSchemes.status, brandId: brandSchemes.brandId })
        .from(brandSchemes)
        .where(eq(brandSchemes.id, id))
        .for('update'),
      'Scheme',
    );
  }

  private async claimOf(tx: Transaction, claimId: string, schemeId: string) {
    const [claim] = await tx
      .select({ id: brandClaims.id })
      .from(brandClaims)
      .where(and(eq(brandClaims.id, claimId), eq(brandClaims.schemeId, schemeId)));
    if (!claim) throw new BadRequestException('That claim is not one of this scheme');
  }

  private columns(body: SchemeBody) {
    return {
      name: body.name,
      brandReference: body.brandReference,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      measure: body.measure,
      mode: body.mode,
      settlementDays: body.settlementDays,
      dateBasis: body.dateBasis,
      note: body.note,
    };
  }

  /**
   * What the database cannot check: the brand, products of that brand, categories and
   * free-goods packs exist; the name is free; slab targets rise; and the engine accepts
   * the scheme (an incremental scheme gives no benefit on the other basis, [PO-31]).
   */
  private async checkScheme(tx: Transaction, body: SchemeBody, id: string | null) {
    only(
      await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, body.brandId)),
      'Brand',
    );
    const productIds = [...new Set(body.productIds)];
    if (productIds.length > 0) {
      const found = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(inArray(products.id, productIds), eq(products.brandId, body.brandId)));
      if (found.length !== productIds.length) {
        throw new BadRequestException("Every product must be one of the scheme's brand");
      }
    }
    const categoryIds = [...new Set(body.categoryIds)];
    if (categoryIds.length > 0) {
      const found = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(inArray(categories.id, categoryIds));
      if (found.length !== categoryIds.length) throw new BadRequestException('Unknown category');
    }
    await this.checkVariants(
      tx,
      body.slabs.flatMap((slab) =>
        slab.benefits.flatMap((benefit) =>
          benefit.kind === 'free_goods' ? [benefit.variantId] : [],
        ),
      ),
    );
    const [clash] = await tx
      .select({ id: brandSchemes.id })
      .from(brandSchemes)
      .where(
        and(
          eq(brandSchemes.brandId, body.brandId),
          sql`lower(${brandSchemes.name}) = lower(${body.name})`,
          id === null ? undefined : ne(brandSchemes.id, id),
        ),
      );
    if (clash) throw new ConflictException(`This brand already has a scheme named ${body.name}`);
    body.slabs.forEach((slab, index) => {
      const previous = body.slabs[index - 1];
      if (previous !== undefined && slab.target <= previous.target) {
        throw new BadRequestException('Each slab’s target must be above the one before');
      }
    });
    const engine: BrandScheme = {
      id: id ?? 'new',
      brandId: body.brandId,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      measure: body.measure,
      mode: body.mode,
      productIds,
      categoryIds,
      settlementDays: body.settlementDays,
      slabs: body.slabs.map((slab, index) => ({ id: String(index), ...slab })),
    };
    try {
      assertScheme(engine);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private async checkVariants(tx: Transaction, variantIds: readonly string[]) {
    const unique = [...new Set(variantIds)];
    if (unique.length === 0) return;
    const found = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(inArray(productVariants.id, unique));
    if (found.length !== unique.length) throw new BadRequestException('Unknown product variant');
  }

  private async writeParts(tx: Transaction, auth: AuthContext, id: string, body: SchemeBody) {
    const organizationId = auth.organization.id;
    const items = [
      ...[...new Set(body.productIds)].map((productId) => ({
        organizationId,
        schemeId: id,
        productId,
      })),
      ...[...new Set(body.categoryIds)].map((categoryId) => ({
        organizationId,
        schemeId: id,
        categoryId,
      })),
    ];
    if (items.length > 0) await tx.insert(brandSchemeItems).values(items);
    const slabs = await tx
      .insert(brandSchemeSlabs)
      .values(
        body.slabs.map((slab, index) => ({
          organizationId,
          schemeId: id,
          position: index + 1,
          target: slab.target,
        })),
      )
      .returning({ id: brandSchemeSlabs.id, position: brandSchemeSlabs.position });
    const slabIds = new Map(slabs.map((slab) => [slab.position, slab.id]));
    await tx.insert(brandSchemeBenefits).values(
      body.slabs.flatMap((slab, index) =>
        slab.benefits.map((benefit, position) => ({
          organizationId,
          schemeId: id,
          slabId: String(slabIds.get(index + 1)),
          position: position + 1,
          kind: benefit.kind,
          ...(benefit.kind === 'rebate' ? { basisPoints: benefit.basisPoints } : {}),
          ...(benefit.kind === 'per_litre' ? { paisePerLitre: benefit.paisePerLitre } : {}),
          ...(benefit.kind === 'free_goods'
            ? {
                variantId: benefit.variantId,
                units: benefit.units,
                perMillilitres: benefit.perMillilitres,
              }
            : {}),
          ...(benefit.kind === 'points' ? { label: benefit.label, points: benefit.points } : {}),
        })),
      ),
    );
  }
}
