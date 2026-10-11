import {
  MAX_COATS,
  MAX_SURFACE_DIMENSION_FT,
  MIN_COATS,
  defaultSurfaceTreatment,
  surfaceGrossAreaSqft,
  surfaceNetAreaSqft,
  type EstimateSurfaceRequest,
  type EstimateSurfaceView,
  type EstimatorSurface,
  type SurfaceCondition,
} from '@paint/shared';

// The estimate screen's rooms, as typed, and how they become the estimate's
// surfaces: four walls (perimeter × height) less the doors and windows, plus
// the ceiling (length × width) when it is painted too.

/** Typical openings deducted (spec §6.2): a 3 × 7 ft door and a 4 × 4 ft window. */
export const DOOR_SQFT = 21;
export const WINDOW_SQFT = 16;
const MAX_OPENINGS = 50;

/** A room as typed: text fields, so a half-typed number stays as it is. */
export interface RoomDraft {
  readonly key: string;
  readonly name: string;
  readonly lengthFt: string;
  readonly widthFt: string;
  readonly heightFt: string;
  readonly doors: string;
  readonly windows: string;
  /** Openings of a saved estimate that are not whole doors and windows. */
  readonly otherOpeningsSqft: number;
  readonly ceiling: boolean;
  /** Blank: the product's default coats. */
  readonly coats: string;
  readonly condition: SurfaceCondition;
}

export const blankRoom = (key: string, name: string): RoomDraft => ({
  key,
  name,
  lengthFt: '',
  widthFt: '',
  heightFt: '10',
  doors: '1',
  windows: '1',
  otherOpeningsSqft: 0,
  ceiling: false,
  coats: '',
  condition: 'repaint',
});

export type RoomProblem = 'name' | 'size' | 'openings' | 'coats';

const DECIMAL = /^\d{1,4}(\.\d{1,2})?$/;
const WHOLE = /^\d{1,2}$/;

const feet = (text: string): number | null => {
  const value = DECIMAL.test(text.trim()) ? Number(text) : null;
  return value !== null && value <= MAX_SURFACE_DIMENSION_FT ? value : null;
};
const count = (text: string): number | null =>
  WHOLE.test(text.trim()) && Number(text) <= MAX_OPENINGS ? Number(text) : null;
const twoDecimals = (value: number) => Math.round(value * 100) / 100;

export type RoomResult =
  { readonly surfaces: EstimateSurfaceRequest[] } | { readonly problem: RoomProblem };

/** The room's surfaces, or what stops them: a missing name or measure, too many openings. */
export function roomSurfaces(room: RoomDraft): RoomResult {
  const name = room.name.trim();
  if (name === '') return { problem: 'name' };
  const length = feet(room.lengthFt);
  const width = feet(room.widthFt);
  const height = feet(room.heightFt);
  if (
    length === null ||
    width === null ||
    height === null ||
    length + width === 0 ||
    height === 0
  ) {
    return { problem: 'size' };
  }
  if (room.ceiling && (length === 0 || width === 0)) return { problem: 'size' };
  const doors = count(room.doors);
  const windows = count(room.windows);
  if (doors === null || windows === null) return { problem: 'openings' };
  const coatsText = room.coats.trim();
  const coats = coatsText === '' ? undefined : Number(coatsText);
  if (
    coats !== undefined &&
    !(Number.isInteger(coats) && coats >= MIN_COATS && coats <= MAX_COATS)
  ) {
    return { problem: 'coats' };
  }
  const perimeter = twoDecimals(2 * (length + width));
  const openingsSqft = twoDecimals(
    doors * DOOR_SQFT + windows * WINDOW_SQFT + room.otherOpeningsSqft,
  );
  if (openingsSqft > surfaceGrossAreaSqft({ lengthFt: perimeter, heightFt: height })) {
    return { problem: 'openings' };
  }
  const common = {
    room: name,
    condition: room.condition,
    ...(coats === undefined ? {} : { coats }),
  };
  const walls: EstimateSurfaceRequest = {
    ...common,
    kind: 'interior_wall',
    lengthFt: perimeter,
    heightFt: height,
    openingsSqft,
  };
  return {
    surfaces: room.ceiling
      ? [walls, { ...common, kind: 'ceiling', lengthFt: length, heightFt: width }]
      : [walls],
  };
}

/** A surface as the estimator sees it, with primer and putty as the server defaults them. */
export function estimatorSurface(surface: EstimateSurfaceRequest): EstimatorSurface {
  const treatment = defaultSurfaceTreatment(surface.kind, surface.condition);
  return {
    netAreaSqft: surfaceNetAreaSqft(surface),
    coats: surface.coats ?? null,
    condition: surface.condition,
    primer: surface.primer ?? treatment.primer,
    putty: surface.putty ?? treatment.putty,
  };
}

/** Doors and windows that make up `sqft` exactly, else none and the rest as "other". */
function openingsOf(sqft: number): Pick<RoomDraft, 'doors' | 'windows' | 'otherOpeningsSqft'> {
  for (let doors = 0; doors <= MAX_OPENINGS && doors * DOOR_SQFT <= sqft; doors += 1) {
    const windows = (sqft - doors * DOOR_SQFT) / WINDOW_SQFT;
    if (Number.isInteger(windows) && windows <= MAX_OPENINGS) {
      return { doors: String(doors), windows: String(windows), otherOpeningsSqft: 0 };
    }
  }
  return { doors: '0', windows: '0', otherOpeningsSqft: sqft };
}

const text = (value: number | null) => (value === null ? '' : String(value));

/**
 * The rooms of a saved estimate, one per room name. The ceiling gives back the
 * length and width; without one the walls' perimeter comes back as the length.
 */
export function roomsOf(surfaces: readonly EstimateSurfaceView[]): RoomDraft[] {
  const rooms = new Map<string, [EstimateSurfaceView, ...EstimateSurfaceView[]]>();
  for (const surface of surfaces) {
    const room = rooms.get(surface.room);
    if (room === undefined) rooms.set(surface.room, [surface]);
    else room.push(surface);
  }
  return [...rooms].map(([name, parts], index) => {
    const [first] = parts;
    const walls = parts.find((part) => part.kind !== 'ceiling');
    const ceiling = parts.find((part) => part.kind === 'ceiling');
    const perimeter = walls?.lengthFt ?? walls?.grossAreaSqft ?? 0;
    const length = ceiling?.lengthFt ?? null;
    const width = ceiling?.heightFt ?? null;
    return {
      ...blankRoom(`saved-${String(index)}`, name),
      lengthFt: text(length ?? twoDecimals(perimeter / 2)),
      widthFt: text(width ?? 0),
      heightFt: walls === undefined ? '' : text(walls.heightFt ?? 1),
      ...openingsOf(walls?.openingsSqft ?? 0),
      ceiling: ceiling !== undefined,
      coats: text(first.coats),
      condition: first.condition,
    };
  });
}
