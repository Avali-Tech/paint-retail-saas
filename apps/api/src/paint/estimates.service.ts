import 'reflect-metadata';
import {
  ConflictException,
  ForbiddenException,
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
  DEFAULT_WASTAGE_BPS,
  ESTIMATE_NUMBER_PREFIX,
  ESTIMATE_TIERS,
  canAccessStore,
  defaultSurfaceTreatment,
  formatDocumentNumber,
  surfaceGrossAreaSqft,
  surfaceNetAreaSqft,
  type EstimateOptionLine,
  type EstimateOptionView,
  type EstimatePage,
  type EstimateProductRef,
  type EstimateSurfaceView,
  type EstimateView,
} from '@paint/shared';
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { requireSaleParty, requireSaleSite } from '../billing/sale-parties.js';
import { idempotent } from '../billing/idempotency.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import { fieldError } from '../tax/tax-lookups.js';
import type { EstimateInput, ListEstimatesQuery } from './paint.schemas.js';

const {
  brands,
  estimateOptions,
  estimateSurfaces,
  estimates,
  parties,
  products,
  projects,
  quotations,
  stores,
} = schema;

type EstimateRow = typeof estimates.$inferSelect;
type SurfaceRow = typeof estimateSurfaces.$inferSelect;

/** Net area of saved surfaces, to the hundredth. */
const totalNetArea = (surfaces: readonly SurfaceRow[]) =>
  surfaces.reduce((sum, surface) => sum + Math.round(surfaceNetAreaSqft(surface) * 100), 0) / 100;

const surfaceView = (surface: SurfaceRow): EstimateSurfaceView => ({
  id: surface.id,
  position: surface.position,
  room: surface.room,
  kind: surface.kind,
  areaSqft: surface.areaSqft,
  lengthFt: surface.lengthFt,
  heightFt: surface.heightFt,
  openingsSqft: surface.openingsSqft,
  condition: surface.condition,
  coats: surface.coats,
  primer: surface.primer,
  putty: surface.putty,
  grossAreaSqft: surfaceGrossAreaSqft(surface),
  netAreaSqft: surfaceNetAreaSqft(surface),
});

/**
 * Paint estimates (P2-M29, spec §6.2): the surfaces of a job and up to three
 * product choices (good / better / best). The estimator (built after 5a) computes
 * each option's litres and pack mix and converts the chosen one into a
 * quotation; this keeps the estimate itself.
 */
@Injectable()
export class EstimatesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(auth: AuthContext, input: EstimateInput, idempotencyKey?: string): Promise<EstimateView> {
    const request = { method: 'POST', path: '/estimates', body: input };
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      idempotent(tx, auth, idempotencyKey, request, async () => {
        await this.checkReferences(tx, auth, input);
        const number = formatDocumentNumber(
          ESTIMATE_NUMBER_PREFIX,
          await nextDocumentNumber(tx, auth.organization.id, 'estimate'),
        );
        const [row] = (await tx
          .insert(estimates)
          .values({
            ...this.header(input),
            organizationId: auth.organization.id,
            number,
            createdByMemberId: auth.memberId,
          })
          .returning()) as [EstimateRow];
        await this.writeParts(tx, auth, row.id, input);
        return this.view(tx, row);
      }),
    );
  }

  /** Replaces a draft's header, surfaces and options (clearing every computed result). */
  update(auth: AuthContext, id: string, input: EstimateInput): Promise<EstimateView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      this.assertDraft(await this.load(tx, auth, id, true));
      await this.checkReferences(tx, auth, input);
      const [row] = (await tx
        .update(estimates)
        .set({ ...this.header(input), updatedAt: sql`now()` })
        .where(eq(estimates.id, id))
        .returning()) as [EstimateRow];
      await tx.delete(estimateSurfaces).where(eq(estimateSurfaces.estimateId, id));
      await tx.delete(estimateOptions).where(eq(estimateOptions.estimateId, id));
      await this.writeParts(tx, auth, id, input);
      return this.view(tx, row);
    });
  }

  /** Discards a draft. */
  remove(auth: AuthContext, id: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      this.assertDraft(await this.load(tx, auth, id, true));
      await tx.delete(estimates).where(eq(estimates.id, id));
    });
  }

  get(auth: AuthContext, id: string): Promise<EstimateView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) =>
      this.view(tx, await this.load(tx, auth, id)),
    );
  }

  list(auth: AuthContext, query: ListEstimatesQuery): Promise<EstimatePage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const pattern = query.q === undefined ? null : containsPattern(query.q);
      const where = and(
        auth.allStores ? undefined : inArray(estimates.storeId, [...auth.storeIds]),
        query.storeId === undefined ? undefined : eq(estimates.storeId, query.storeId),
        query.partyId === undefined ? undefined : eq(estimates.partyId, query.partyId),
        query.projectId === undefined ? undefined : eq(estimates.projectId, query.projectId),
        query.status === undefined ? undefined : eq(estimates.status, query.status),
        pattern === null
          ? undefined
          : or(
              ilike(estimates.number, pattern),
              ilike(estimates.title, pattern),
              ilike(parties.displayName, pattern),
            ),
      );
      const rows = await tx
        .select({ estimate: estimates, partyName: parties.displayName })
        .from(estimates)
        .leftJoin(parties, eq(parties.id, estimates.partyId))
        .where(where)
        .orderBy(desc(estimates.createdAt), desc(estimates.id))
        .limit(query.limit)
        .offset(query.offset);
      const [total] = await tx
        .select({ value: count() })
        .from(estimates)
        .leftJoin(parties, eq(parties.id, estimates.partyId))
        .where(where);
      const surfaces = await this.surfacesOf(
        tx,
        rows.map((row) => row.estimate.id),
      );
      return {
        items: rows.map(({ estimate, partyName }) => ({
          id: estimate.id,
          number: estimate.number,
          status: estimate.status,
          storeId: estimate.storeId,
          partyId: estimate.partyId,
          partyName,
          projectId: estimate.projectId,
          title: estimate.title,
          totalNetAreaSqft: totalNetArea(
            surfaces.filter((surface) => surface.estimateId === estimate.id),
          ),
          quotationId: estimate.quotationId,
          createdAt: estimate.createdAt.toISOString(),
        })),
        total: Number(total?.value),
      };
    });
  }

  // Helpers -----------------------------------------------------------------

  /** The estimate, locked when `lock` is set; one at a store the member cannot see is "not found". */
  private async load(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    lock = false,
  ): Promise<EstimateRow> {
    const query = tx.select().from(estimates).where(eq(estimates.id, id));
    const [row] = lock ? await query.for('update') : await query;
    if (!row || !canAccessStore(auth, row.storeId)) {
      throw new NotFoundException('Estimate not found');
    }
    return row;
  }

  private assertDraft(estimate: EstimateRow): void {
    if (estimate.status !== 'draft') {
      throw new ConflictException('This estimate became a quotation: change the quotation instead');
    }
  }

  private header(input: EstimateInput) {
    return {
      storeId: input.storeId,
      partyId: input.partyId ?? null,
      projectId: input.projectId ?? null,
      title: input.title ?? null,
      wastageBps: input.wastageBps ?? DEFAULT_WASTAGE_BPS,
      note: input.note ?? null,
    };
  }

  /** The store, party, site and products the request names exist and may be used. */
  private async checkReferences(
    tx: Transaction,
    auth: AuthContext,
    input: EstimateInput,
  ): Promise<void> {
    const [store] = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, input.storeId), eq(stores.isActive, true)));
    if (!store) throw fieldError('storeId', 'Unknown store');
    if (!canAccessStore(auth, input.storeId)) {
      throw new ForbiddenException('You can estimate only at a store you work at');
    }
    if (input.partyId !== undefined) await requireSaleParty(tx, input.partyId, 'partyId');
    if (input.projectId !== undefined) await requireSaleSite(tx, input.projectId);
    const options = input.options ?? [];
    const wanted = options.flatMap((option, index) => [
      { id: option.productId, path: `options.${String(index)}.productId`, coverage: true },
      ...(option.primerProductId === undefined
        ? []
        : [
            {
              id: option.primerProductId,
              path: `options.${String(index)}.primerProductId`,
              coverage: true,
            },
          ]),
      ...(option.puttyProductId === undefined
        ? []
        : [
            {
              id: option.puttyProductId,
              path: `options.${String(index)}.puttyProductId`,
              coverage: false,
            },
          ]),
    ]);
    if (wanted.length === 0) return;
    const found = await tx
      .select({ id: products.id, coverage: products.coverageSqftPerLitre })
      .from(products)
      .where(
        and(
          inArray(
            products.id,
            wanted.map((item) => item.id),
          ),
          eq(products.isActive, true),
        ),
      );
    for (const item of wanted) {
      const product = found.find((row) => row.id === item.id);
      if (!product) throw fieldError(item.path, 'Unknown product');
      if (item.coverage && product.coverage === null) {
        throw fieldError(item.path, 'Enter this product’s coverage (sq ft per litre) first');
      }
    }
  }

  private async writeParts(
    tx: Transaction,
    auth: AuthContext,
    estimateId: string,
    input: EstimateInput,
  ): Promise<void> {
    const organizationId = auth.organization.id;
    await tx.insert(estimateSurfaces).values(
      input.surfaces.map((surface, index) => {
        const treatment = defaultSurfaceTreatment(surface.kind, surface.condition);
        return {
          organizationId,
          estimateId,
          position: index + 1,
          room: surface.room,
          kind: surface.kind,
          areaSqft: surface.areaSqft ?? null,
          lengthFt: surface.lengthFt ?? null,
          heightFt: surface.heightFt ?? null,
          openingsSqft: surface.openingsSqft ?? 0,
          condition: surface.condition,
          coats: surface.coats ?? null,
          primer: surface.primer ?? treatment.primer,
          putty: surface.putty ?? treatment.putty,
        };
      }),
    );
    const options = input.options ?? [];
    if (options.length > 0) {
      await tx.insert(estimateOptions).values(
        options.map((option) => ({
          organizationId,
          estimateId,
          tier: option.tier,
          productId: option.productId,
          primerProductId: option.primerProductId ?? null,
          puttyProductId: option.puttyProductId ?? null,
        })),
      );
    }
  }

  private surfacesOf(tx: Transaction, estimateIds: readonly string[]): Promise<SurfaceRow[]> {
    return tx
      .select()
      .from(estimateSurfaces)
      .where(inArray(estimateSurfaces.estimateId, [...estimateIds]))
      .orderBy(asc(estimateSurfaces.position));
  }

  private async view(tx: Transaction, row: EstimateRow): Promise<EstimateView> {
    const [refs] = (await tx
      .select({
        partyName: parties.displayName,
        partyPhone: parties.phone,
        projectName: projects.name,
        quotationNumber: quotations.number,
      })
      .from(estimates)
      .leftJoin(parties, eq(parties.id, estimates.partyId))
      .leftJoin(projects, eq(projects.id, estimates.projectId))
      .leftJoin(quotations, eq(quotations.id, estimates.quotationId))
      .where(eq(estimates.id, row.id))) as [
      {
        partyName: string | null;
        partyPhone: string | null;
        projectName: string | null;
        quotationNumber: string | null;
      },
    ];
    const surfaces = await this.surfacesOf(tx, [row.id]);
    const options = await tx
      .select()
      .from(estimateOptions)
      .where(eq(estimateOptions.estimateId, row.id));
    const productIds = options.flatMap((option) =>
      [option.productId, option.primerProductId, option.puttyProductId].filter(
        (productId) => productId !== null,
      ),
    );
    const refsOfProducts = await tx
      .select({
        id: products.id,
        name: products.name,
        brandName: brands.name,
        coverageSqftPerLitre: products.coverageSqftPerLitre,
        defaultCoats: products.defaultCoats,
        isActive: products.isActive,
      })
      .from(products)
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(inArray(products.id, productIds));
    const product = (productId: string): EstimateProductRef =>
      refsOfProducts.find((ref) => ref.id === productId) as EstimateProductRef;
    const optional = (productId: string | null) => (productId === null ? null : product(productId));
    const optionViews = options
      .map((option): EstimateOptionView => ({
        id: option.id,
        tier: option.tier,
        product: product(option.productId),
        primerProduct: optional(option.primerProductId),
        puttyProduct: optional(option.puttyProductId),
        result:
          option.computedAt === null
            ? null
            : {
                litres: Number(option.litres),
                lines: option.lines as EstimateOptionLine[],
                totalPaise: Number(option.totalPaise),
                computedAt: option.computedAt.toISOString(),
              },
      }))
      .sort((x, y) => ESTIMATE_TIERS.indexOf(x.tier) - ESTIMATE_TIERS.indexOf(y.tier));
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      storeId: row.storeId,
      party:
        row.partyId === null
          ? null
          : { id: row.partyId, name: String(refs.partyName), phone: refs.partyPhone },
      project:
        row.projectId === null ? null : { id: row.projectId, name: String(refs.projectName) },
      title: row.title,
      wastageBps: row.wastageBps,
      note: row.note,
      totalNetAreaSqft: totalNetArea(surfaces),
      surfaces: surfaces.map(surfaceView),
      options: optionViews,
      quotationId: row.quotationId,
      quotationNumber: refs.quotationNumber,
      convertedTier: row.convertedTier,
      convertedAt: row.convertedAt?.toISOString() ?? null,
      createdByMemberId: row.createdByMemberId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
