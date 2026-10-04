import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { MOVEMENT_KINDS, type MovementKind } from '../api/stock.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';
import { ProductPicker } from '../lib/ProductPicker.js';
import { parseQuantity } from '../lib/quantity.js';
import { StoreSelect } from './StoreSelect.js';
import { refreshInventory } from '../lib/refresh.js';

export interface Line {
  readonly variantId: string;
  readonly sku: string;
  readonly name: string;
  quantity: string;
  unitCost: string;
}

const isMovementKind = (value: string | null): value is MovementKind =>
  MOVEMENT_KINDS.some((kind) => kind === value);

/** A cost applies only to stock coming in (the API refuses it otherwise). */
export const takesCost = (type: MovementKind, quantity: number) =>
  type !== 'damage' && quantity > 0;

/** Problems with a movement before it is sent, by field ("note", "line-<variantId>"). */
export function checkMovement(
  type: MovementKind,
  note: string,
  lines: readonly Line[],
): Record<string, MessageKey> {
  const problems: Record<string, MessageKey> = {};
  const text = note.trim();
  if (type !== 'opening' && text.length < 3) problems.note = 'stock.movement.noteRequired';
  // Opening stock needs no note, but one that is given must say something.
  else if (text !== '' && text.length < 3) problems.note = 'stock.movement.noteShort';
  if (lines.length === 0) problems.lines = 'stock.movement.noLines';
  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);
    if (quantity === null || quantity === 0) {
      problems[`line-${line.variantId}`] = 'stock.movement.quantityInvalid';
    } else if (type !== 'adjustment' && quantity < 0) {
      problems[`line-${line.variantId}`] = 'stock.movement.positive';
    } else if (
      takesCost(type, quantity) &&
      line.unitCost.trim() !== '' &&
      parseRupees(line.unitCost) === null
    ) {
      problems[`cost-${line.variantId}`] = 'products.form.priceInvalid';
    }
  }
  return problems;
}

/** /stock/movements/new — correct counts, write off damage or enter opening stock. */
export function MovementPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const requestedType = params.get('type');
  const [storeId, setStoreId] = useState(params.get('store') ?? '');
  const [type, setType] = useState<MovementKind>(
    isMovementKind(requestedType) ? requestedType : 'adjustment',
  );
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [problems, setProblems] = useState<Record<string, MessageKey>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const problem = (key: string) => {
    const found = problems[key];
    return found === undefined ? undefined : t(found);
  };
  const change = (variantId: string, field: 'quantity' | 'unitCost', value: string) => {
    setLines((current) =>
      current.map((line) => (line.variantId === variantId ? { ...line, [field]: value } : line)),
    );
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const found = checkMovement(type, note, lines);
    if (storeId === '') found.store = 'stock.movement.chooseStore';
    setProblems(found);
    setMessage(null);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      await api.stock.record({
        storeId,
        type,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        lines: lines.map((line) => {
          const quantity = Number(parseQuantity(line.quantity));
          const cost =
            takesCost(type, quantity) && line.unitCost.trim() !== ''
              ? parseRupees(line.unitCost)
              : null;
          return {
            variantId: line.variantId,
            quantity,
            ...(cost === null ? {} : { unitCostPaise: cost }),
          };
        }),
      });
      await refreshInventory(queryClient);
      toast({ title: t('stock.movement.saved'), tone: 'success' });
      void navigate(`/stock?store=${storeId}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader title={t('stock.movement.title')} description={t('stock.movement.description')} />
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <Card>
          <div className="form-grid">
            <StoreSelect
              label={t('stock.movement.store')}
              emptyLabel={t('stock.movement.chooseStore')}
              required
              value={storeId}
              onChange={setStoreId}
              error={problem('store')}
            />
            <Field label={t('stock.movement.type')}>
              <Select
                value={type}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isMovementKind(value)) setType(value);
                }}
              >
                {MOVEMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {label('movementKinds', kind)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label={t('stock.movement.note')}
            hint={t('stock.movement.noteHint')}
            error={problem('note')}
            required={type !== 'opening'}
            className="form-wide"
          >
            <Textarea
              maxLength={500}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </Card>
        <Card title={t('stock.movement.lines')}>
          <div className="stack">
            {problem('lines') !== undefined && <Alert tone="danger">{problem('lines')}</Alert>}
            {lines.length > 0 && (
              <ul className="doc-lines">
                {lines.map((line) => (
                  <li key={line.variantId} className="doc-line">
                    <div className="doc-line__head">
                      <span className="doc-line__title">
                        {line.sku} <span className="muted">{line.name}</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setLines((current) =>
                            current.filter((item) => item.variantId !== line.variantId),
                          );
                        }}
                      >
                        {t('workflow.remove', { sku: line.sku })}
                      </Button>
                    </div>
                    <div className="doc-line__fields">
                      <Field
                        label={t('stock.movement.quantity', { sku: line.sku })}
                        {...(type === 'adjustment'
                          ? { hint: t('stock.movement.quantityHint') }
                          : {})}
                        error={problem(`line-${line.variantId}`)}
                      >
                        <Input
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) => {
                            change(line.variantId, 'quantity', event.target.value);
                          }}
                        />
                      </Field>
                      {/* Stock going out leaves at its average cost: no cost to type. */}
                      {type !== 'damage' && (parseQuantity(line.quantity) ?? 0) >= 0 && (
                        <Field
                          label={t('stock.movement.unitCost', { sku: line.sku })}
                          hint={t('stock.movement.unitCostHint')}
                          error={problem(`cost-${line.variantId}`)}
                        >
                          <Input
                            inputMode="decimal"
                            value={line.unitCost}
                            onChange={(event) => {
                              change(line.variantId, 'unitCost', event.target.value);
                            }}
                          />
                        </Field>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <ProductPicker
              includeInactive
              chosen={new Set(lines.map((line) => line.variantId))}
              onChoose={(picked) => {
                setLines((current) => [
                  ...current,
                  {
                    variantId: picked.variantId,
                    sku: picked.sku,
                    name: picked.name,
                    quantity: '',
                    unitCost: '',
                  },
                ]);
              }}
            />
          </div>
        </Card>
        <div className="row row--end">
          <Button type="submit" loading={pending}>
            {t('stock.movement.submit')}
          </Button>
        </div>
      </form>
    </>
  );
}
