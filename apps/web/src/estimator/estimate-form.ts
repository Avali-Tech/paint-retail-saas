import {
  ESTIMATE_TIERS,
  MAX_ESTIMATE_SURFACES,
  MAX_WASTAGE_BPS,
  estimateTiers,
  packsOf,
  type EstimateOptionRequest,
  type EstimateRequest,
  type EstimateSurfaceRequest,
  type EstimateTier,
  type EstimateView,
  type TierChoice,
  type TierOutcome,
} from '@paint/shared';
import type { PaintProduct } from './estimator-api.js';
import {
  blankRoom,
  estimatorSurface,
  roomSurfaces,
  roomsOf,
  type RoomDraft,
  type RoomProblem,
} from './rooms.js';

// The estimate screen's state, the request it saves and the live good / better /
// best it shows while the rooms are typed (the same pure estimator the server runs).

export interface ChosenParty {
  readonly id: string;
  readonly name: string;
}

export interface EstimateDraft {
  readonly storeId: string;
  readonly party: ChosenParty | null;
  readonly title: string;
  /** Percent as typed, e.g. "5". */
  readonly wastage: string;
  readonly rooms: readonly RoomDraft[];
  readonly tiers: Readonly<Record<EstimateTier, PaintProduct | null>>;
  /** Used by every tier, on the surfaces that take them. */
  readonly primer: PaintProduct | null;
  readonly putty: PaintProduct | null;
}

const NO_TIERS = { good: null, better: null, best: null } as const;

export const newDraft = (storeId: string, firstRoom: string): EstimateDraft => ({
  storeId,
  party: null,
  title: '',
  wastage: '5',
  rooms: [blankRoom('room-1', firstRoom)],
  tiers: NO_TIERS,
  primer: null,
  putty: null,
});

/** A saved estimate back into the form; `products` holds its options' products by id. */
export function draftOf(
  view: EstimateView,
  products: ReadonlyMap<string, PaintProduct>,
): EstimateDraft {
  const product = (id: string | undefined) =>
    id === undefined ? null : (products.get(id) ?? null);
  const tiers = { ...NO_TIERS } as Record<EstimateTier, PaintProduct | null>;
  for (const option of view.options) tiers[option.tier] = product(option.product.id);
  const first = view.options[0];
  return {
    storeId: view.storeId,
    party: view.party === null ? null : { id: view.party.id, name: view.party.name },
    title: view.title ?? '',
    wastage: String(view.wastageBps / 100),
    rooms: roomsOf(view.surfaces),
    tiers,
    primer: product(first?.primerProduct?.id),
    putty: product(first?.puttyProduct?.id),
  };
}

/** Every product id an estimate's options use, to load their packs. */
export const productIdsOf = (view: EstimateView): string[] => [
  ...new Set(
    view.options.flatMap((option) =>
      [option.product, option.primerProduct, option.puttyProduct].flatMap((ref) =>
        ref === null ? [] : [ref.id],
      ),
    ),
  ),
];

const WASTAGE = /^\d{1,2}(\.\d{1,2})?$/;

/** Wastage in basis points, or null when it is not 0 to 50 %. */
export function wastageBpsOf(text: string): number | null {
  if (!WASTAGE.test(text.trim())) return null;
  const bps = Math.round(Number(text) * 100);
  return bps <= MAX_WASTAGE_BPS ? bps : null;
}

export interface RoomCheck {
  readonly room: RoomDraft;
  readonly result: EstimateSurfaceRequest[] | RoomProblem;
}

export interface DraftCheck {
  /** Each room with its surfaces, or why it has none. */
  readonly rooms: readonly RoomCheck[];
  readonly surfaces: readonly EstimateSurfaceRequest[];
  readonly wastageBps: number | null;
  readonly problem: 'store' | 'rooms' | 'noRooms' | 'tooMany' | 'wastage' | null;
}

/** What the rooms add up to, and the first thing stopping a save. */
export function checkDraft(draft: EstimateDraft): DraftCheck {
  const rooms = draft.rooms.map((room): RoomCheck => {
    const result = roomSurfaces(room);
    return { room, result: 'problem' in result ? result.problem : result.surfaces };
  });
  const results = rooms.map((room) => room.result);
  const surfaces = results.flatMap((result) => (typeof result === 'string' ? [] : result));
  const wastageBps = wastageBpsOf(draft.wastage);
  const problem =
    draft.storeId === ''
      ? 'store'
      : draft.rooms.length === 0
        ? 'noRooms'
        : results.some((result) => typeof result === 'string')
          ? 'rooms'
          : surfaces.length > MAX_ESTIMATE_SURFACES
            ? 'tooMany'
            : wastageBps === null
              ? 'wastage'
              : null;
  return { rooms, surfaces, wastageBps, problem };
}

/** POST / PUT /estimates. Primer and putty go on every option. */
export function estimateRequest(draft: EstimateDraft, check: DraftCheck): EstimateRequest {
  const options: EstimateOptionRequest[] = ESTIMATE_TIERS.flatMap((tier) => {
    const product = draft.tiers[tier];
    return product === null
      ? []
      : [
          {
            tier,
            productId: product.id,
            ...(draft.primer === null ? {} : { primerProductId: draft.primer.id }),
            ...(draft.putty === null ? {} : { puttyProductId: draft.putty.id }),
          },
        ];
  });
  const title = draft.title.trim();
  return {
    storeId: draft.storeId,
    ...(draft.party === null ? {} : { partyId: draft.party.id }),
    ...(title === '' ? {} : { title }),
    ...(check.wastageBps === null ? {} : { wastageBps: check.wastageBps }),
    surfaces: check.surfaces,
    options,
  };
}

const coating = (product: PaintProduct) => ({
  coverageSqftPerLitre: product.coverageSqftPerLitre,
  defaultCoats: product.defaultCoats,
  packs: packsOf(product.variants, 'volume'),
});

/** Live good / better / best for the rooms typed so far (rooms with a problem left out). */
export function liveTiers(draft: EstimateDraft, check: DraftCheck): TierOutcome[] {
  const choices: TierChoice[] = ESTIMATE_TIERS.flatMap((tier) => {
    const product = draft.tiers[tier];
    return product === null
      ? []
      : [
          {
            tier,
            paint: coating(product),
            primer: draft.primer === null ? null : coating(draft.primer),
            putty: draft.putty === null ? null : { packs: packsOf(draft.putty.variants, 'weight') },
          },
        ];
  });
  return estimateTiers(
    check.surfaces.map(estimatorSurface),
    choices,
    check.wastageBps ?? undefined,
  );
}
