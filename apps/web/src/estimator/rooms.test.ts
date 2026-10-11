import type { EstimateSurfaceView } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { blankRoom, estimatorSurface, roomSurfaces, roomsOf } from './rooms.js';

const HALL = { ...blankRoom('r1', 'Hall'), lengthFt: '14', widthFt: '12', heightFt: '10' };

const view = (overrides: Partial<EstimateSurfaceView>): EstimateSurfaceView => ({
  id: 's1',
  position: 1,
  room: 'Hall',
  kind: 'interior_wall',
  areaSqft: null,
  lengthFt: 52,
  heightFt: 10,
  openingsSqft: 37,
  condition: 'repaint',
  coats: null,
  primer: false,
  putty: false,
  grossAreaSqft: 520,
  netAreaSqft: 483,
  ...overrides,
});

describe('roomSurfaces', () => {
  it('takes four walls less one door and one window by default', () => {
    expect(roomSurfaces(HALL)).toEqual({
      surfaces: [
        {
          room: 'Hall',
          condition: 'repaint',
          kind: 'interior_wall',
          lengthFt: 52,
          heightFt: 10,
          openingsSqft: 37,
        },
      ],
    });
  });

  it('adds the ceiling, with the coats typed', () => {
    expect(
      roomSurfaces({
        ...HALL,
        ceiling: true,
        doors: '0',
        windows: '2',
        coats: '3',
        widthFt: '12.5',
        condition: 'new',
      }),
    ).toEqual({
      surfaces: [
        {
          room: 'Hall',
          condition: 'new',
          coats: 3,
          kind: 'interior_wall',
          lengthFt: 53,
          heightFt: 10,
          openingsSqft: 32,
        },
        { room: 'Hall', condition: 'new', coats: 3, kind: 'ceiling', lengthFt: 14, heightFt: 12.5 },
      ],
    });
  });

  it('says what is wrong with a room', () => {
    expect(roomSurfaces({ ...HALL, name: ' ' })).toEqual({ problem: 'name' });
    expect(roomSurfaces(blankRoom('r1', 'Hall'))).toEqual({ problem: 'size' });
    expect(roomSurfaces({ ...HALL, widthFt: 'x' })).toEqual({ problem: 'size' });
    expect(roomSurfaces({ ...HALL, heightFt: '1.234' })).toEqual({ problem: 'size' });
    expect(roomSurfaces({ ...HALL, heightFt: '1001' })).toEqual({ problem: 'size' });
    expect(roomSurfaces({ ...HALL, heightFt: '0' })).toEqual({ problem: 'size' });
    expect(roomSurfaces({ ...HALL, lengthFt: '0', widthFt: '0' })).toEqual({ problem: 'size' });
    expect(roomSurfaces({ ...HALL, widthFt: '0', ceiling: true })).toEqual({ problem: 'size' });
    expect(roomSurfaces({ ...HALL, doors: '' })).toEqual({ problem: 'openings' });
    expect(roomSurfaces({ ...HALL, windows: '51' })).toEqual({ problem: 'openings' });
    expect(roomSurfaces({ ...HALL, heightFt: '1', doors: '3' })).toEqual({ problem: 'openings' });
    expect(roomSurfaces({ ...HALL, coats: '0' })).toEqual({ problem: 'coats' });
    expect(roomSurfaces({ ...HALL, coats: '6' })).toEqual({ problem: 'coats' });
    expect(roomSurfaces({ ...HALL, coats: 'two' })).toEqual({ problem: 'coats' });
  });
});

describe('estimatorSurface', () => {
  it('takes the net area and the server default primer and putty', () => {
    expect(
      estimatorSurface({
        room: 'Hall',
        kind: 'interior_wall',
        lengthFt: 52,
        heightFt: 10,
        openingsSqft: 37,
        condition: 'new',
      }),
    ).toEqual({ netAreaSqft: 483, coats: null, condition: 'new', primer: true, putty: true });
    expect(
      estimatorSurface({
        room: 'Gate',
        kind: 'metal',
        areaSqft: 40,
        condition: 'repaint',
        coats: 1,
        primer: true,
        putty: false,
      }),
    ).toEqual({ netAreaSqft: 40, coats: 1, condition: 'repaint', primer: true, putty: false });
  });
});

describe('roomsOf', () => {
  it('gives back the rooms typed, the ceiling giving back length and width', () => {
    const [hall, bed] = roomsOf([
      view({}),
      view({ id: 's2', kind: 'ceiling', lengthFt: 14, heightFt: 12, openingsSqft: 0, coats: 3 }),
      view({
        id: 's3',
        room: 'Bedroom',
        lengthFt: 44,
        openingsSqft: 32,
        coats: 3,
        condition: 'new',
      }),
    ]);
    expect(hall).toMatchObject({
      name: 'Hall',
      lengthFt: '14',
      widthFt: '12',
      heightFt: '10',
      doors: '1',
      windows: '1',
      otherOpeningsSqft: 0,
      ceiling: true,
      coats: '',
      condition: 'repaint',
    });
    expect(roomSurfaces(hall ?? HALL)).toMatchObject({
      surfaces: [{ lengthFt: 52, openingsSqft: 37 }, {}],
    });
    expect(bed).toMatchObject({
      lengthFt: '22',
      widthFt: '0',
      doors: '0',
      windows: '2',
      coats: '3',
      condition: 'new',
    });
  });

  it('keeps openings that are not whole doors and windows, and walls given by area', () => {
    const [room] = roomsOf([
      view({
        lengthFt: null,
        heightFt: null,
        areaSqft: 300,
        grossAreaSqft: 300,
        openingsSqft: 10.5,
      }),
    ]);
    expect(room).toMatchObject({
      lengthFt: '150',
      widthFt: '0',
      heightFt: '1',
      doors: '0',
      windows: '0',
      otherOpeningsSqft: 10.5,
    });
    expect(roomSurfaces(room ?? HALL)).toMatchObject({
      surfaces: [{ lengthFt: 300, heightFt: 1, openingsSqft: 10.5 }],
    });
  });

  it('keeps a ceiling-only room for the member to finish', () => {
    expect(roomsOf([view({ kind: 'ceiling', lengthFt: 10, heightFt: 12 })])).toMatchObject([
      { lengthFt: '10', widthFt: '12', heightFt: '', ceiling: true },
    ]);
  });
});
