import {
  SURFACE_CONDITIONS,
  surfaceNetAreaSqft,
  type EstimateSurfaceRequest,
  type SurfaceCondition,
} from '@paint/shared';
import { Button, Card, Checkbox, Field, Input, Select } from '@paint/ui';
import { useRef } from 'react';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { useLandingOnChange } from '../sales/focus-landing.js';
import type { RoomCheck } from './estimate-form.js';
import type { RoomDraft, RoomProblem } from './rooms.js';

const ROOM_PROBLEM: Record<RoomProblem, MessageKey> = {
  name: 'estimator.rooms.problems.name',
  size: 'estimator.rooms.problems.size',
  openings: 'estimator.rooms.problems.openings',
  coats: 'estimator.rooms.problems.coats',
};

export const netAreaOf = (surfaces: readonly EstimateSurfaceRequest[]) =>
  Math.round(surfaces.reduce((sum, surface) => sum + surfaceNetAreaSqft(surface) * 100, 0)) / 100;

const NUMBER_FIELDS = [
  ['lengthFt', 'estimator.rooms.length', 'decimal'],
  ['widthFt', 'estimator.rooms.width', 'decimal'],
  ['heightFt', 'estimator.rooms.height', 'decimal'],
  ['doors', 'estimator.rooms.doors', 'numeric'],
  ['windows', 'estimator.rooms.windows', 'numeric'],
] as const;

/** The rooms of an estimate, each with its live area to paint (or what is wrong with it). */
export function RoomsCard({
  rooms,
  onChange,
  onAdd,
  onRemove,
}: {
  /** Every room as typed, with its surfaces or what is wrong with it. */
  readonly rooms: readonly RoomCheck[];
  readonly onChange: (key: string, change: Partial<RoomDraft>) => void;
  readonly onAdd: () => void;
  readonly onRemove: (key: string) => void;
}) {
  const { t, number, label } = useI18n();
  const addRef = useRef<HTMLButtonElement>(null);
  // A removed room takes its "Remove" button with it: the focus moves to "Add a room".
  useLandingOnChange(rooms.length, addRef);
  const total = rooms.reduce(
    (sum, { result }) => sum + (typeof result === 'string' ? 0 : netAreaOf(result)),
    0,
  );
  return (
    <Card title={t('estimator.rooms.title')}>
      <div className="stack">
        {rooms.map(({ room, result }) => {
          const name = room.name.trim() === '' ? t('estimator.rooms.name') : room.name;
          return (
            <fieldset key={room.key} className="estimator-room">
              <legend>{name}</legend>
              <div className="estimator-room__grid">
                <Field label={t('estimator.rooms.name')}>
                  <Input
                    value={room.name}
                    onChange={(event) => {
                      onChange(room.key, { name: event.target.value });
                    }}
                  />
                </Field>
                {NUMBER_FIELDS.map(([field, key, mode]) => (
                  <Field key={field} label={t(key)}>
                    <Input
                      inputMode={mode}
                      value={room[field]}
                      onChange={(event) => {
                        onChange(room.key, { [field]: event.target.value });
                      }}
                    />
                  </Field>
                ))}
                <Field label={t('estimator.rooms.coats')} hint={t('estimator.rooms.coatsHint')}>
                  <Input
                    inputMode="numeric"
                    value={room.coats}
                    onChange={(event) => {
                      onChange(room.key, { coats: event.target.value });
                    }}
                  />
                </Field>
                <Field label={t('estimator.rooms.condition')}>
                  <Select
                    value={room.condition}
                    onChange={(event) => {
                      onChange(room.key, { condition: event.target.value as SurfaceCondition });
                    }}
                  >
                    {SURFACE_CONDITIONS.map((condition) => (
                      <option key={condition} value={condition}>
                        {label('surfaceConditions', condition)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="row estimator-room__foot">
                <Checkbox
                  label={t('estimator.rooms.ceiling')}
                  checked={room.ceiling}
                  onChange={(event) => {
                    onChange(room.key, { ceiling: event.target.checked });
                  }}
                />
                {typeof result === 'string' ? (
                  <span className="estimator-room__problem" role="status">
                    {t(ROOM_PROBLEM[result])}
                  </span>
                ) : (
                  <span className="estimator-room__area" role="status">
                    {t('estimator.rooms.net', { area: number(netAreaOf(result)) })}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onRemove(room.key);
                  }}
                >
                  {t('estimator.rooms.remove', { name })}
                </Button>
              </div>
            </fieldset>
          );
        })}
        <div className="row">
          <Button ref={addRef} variant="secondary" onClick={onAdd}>
            {t('estimator.rooms.add')}
          </Button>
          <span className="estimator-total">
            {t('estimator.rooms.total', { area: number(Math.round(total * 100) / 100) })}
          </span>
        </div>
      </div>
    </Card>
  );
}
