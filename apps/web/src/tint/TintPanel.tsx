import { COLORANT_UNITS, type ColorantUnit, type TintRecordView } from '@paint/shared';
import { Button, Field, Input, Select, Spinner } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState, type Dispatch } from 'react';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import type { BillAction, BillLine } from '../pos/bill.js';
import {
  EMPTY_ROW,
  choiceFromRecord,
  formOf,
  isTintableProduct,
  parseTintForm,
  shadeLabel,
  type FormulaRow,
  type TintChoice,
  type TintForm,
  type TintProblems,
} from './tint.js';

// The tint panel on a bill or order line (spec §6.3): shown only for a tintable
// product's packs. It records the shade, formula and machine, and finds "the same
// shade as last time" in the customer's history at every store.

/**
 * Whether the line's product is tinted at the counter: known when it was scanned,
 * true once tinted, else looked up by SKU (a saved line read back).
 */
function useTintable(line: BillLine): boolean {
  const api = useApi();
  const known = line.tint ? true : line.tintable;
  const lookup = useQuery({
    queryKey: ['tintable', line.sku],
    queryFn: async () => isTintableProduct((await api.catalog.lookup(line.sku, true)).product),
    enabled: known === undefined && line.sku !== '',
    staleTime: Infinity,
  });
  return known ?? lookup.data === true;
}

const HISTORY_LIMIT = 20;

/** "Same shade as last time": the customer's shades at every store, or a search. */
function ShadeHistory({
  partyId,
  onPick,
}: {
  readonly partyId: string | null;
  readonly onPick: (record: TintRecordView) => void;
}) {
  const api = useApi();
  const { t, date, money } = useI18n();
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const enabled = partyId !== null || q !== '';
  const history = useQuery({
    queryKey: ['tint-records', { partyId, q }],
    queryFn: ({ signal }) =>
      api.tint.history(
        {
          ...(partyId === null || q !== '' ? {} : { partyId }),
          ...(q === '' ? {} : { q }),
          limit: HISTORY_LIMIT,
        },
        signal,
      ),
    enabled,
  });
  const records = history.data?.items ?? [];
  return (
    <section className="tint-history stack" aria-label={t('tint.history.title')}>
      <h3 className="tint-history__title">{t('tint.history.title')}</h3>
      <Field
        label={t('tint.history.search')}
        hint={partyId === null ? t('tint.history.searchHint') : t('tint.history.partyHint')}
      >
        <Input
          type="search"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter searches as you type already; it must not apply the tint.
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
      </Field>
      {!enabled ? (
        <p className="muted">{t('tint.history.typeToSearch')}</p>
      ) : history.isPending ? (
        <Spinner label={t('common.loading')} />
      ) : history.isError ? (
        <p role="alert">{t('tint.history.error')}</p>
      ) : records.length === 0 ? (
        <p className="muted">{t('tint.history.empty')}</p>
      ) : (
        <ul className="tint-history__list">
          {records.map((record) => (
            <li key={record.id} className="tint-history__item">
              <div className="tint-history__shade">
                <strong>{shadeLabel(record)}</strong>
                <span className="muted">
                  {t('tint.history.onBase', { base: record.baseVariant.description })}
                  {record.tintChargePaise > 0 &&
                    ` · ${t('tint.charge', { amount: money(record.tintChargePaise) })}`}
                </span>
                <span className="muted">
                  {[
                    record.party?.name,
                    t('tint.history.where', {
                      store: record.store.name,
                      date: date(record.document.date),
                    }),
                    record.document.number === null
                      ? null
                      : t('tint.history.document', {
                          kind: t(`tint.history.kinds.${record.document.kind}`),
                          number: record.document.number,
                        }),
                  ]
                    .filter((part) => part !== null && part !== undefined)
                    .join(' · ')}
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onPick(record);
                }}
              >
                {t('tint.history.use', { shade: record.shadeCode })}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The shade, formula, machine and charge of one line, with the history to copy from. */
function TintDialog({
  line,
  partyId,
  onApply,
  onClose,
}: {
  readonly line: BillLine;
  readonly partyId: string | null;
  readonly onApply: (tint: TintChoice | null) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<TintForm>(() => formOf(line.tint ?? null));
  const [problems, setProblems] = useState<TintProblems>({});
  const set = (change: Partial<TintForm>) => {
    setForm((current) => ({ ...current, ...change }));
  };
  const setRow = (at: number, change: Partial<FormulaRow>) => {
    set({
      formula: form.formula.map((row, index) => (index === at ? { ...row, ...change } : row)),
    });
  };
  const problem = (field: keyof TintProblems) => {
    const found = problems[field];
    return found === undefined ? undefined : t(`tint.problems.${found}`);
  };
  return (
    // The dialog's form must not submit a form the line sits in (the order editor's).
    <div
      onSubmit={(event) => {
        event.stopPropagation();
      }}
    >
      <FormDialog
        open
        onClose={onClose}
        title={t('tint.title', { name: line.name })}
        description={t('tint.description')}
        submitLabel={t('tint.apply')}
        onSubmit={() => {
          const parsed = parseTintForm(form);
          if (!parsed.ok) {
            setProblems(parsed.problems);
            return false;
          }
          onApply(parsed.tint);
          return undefined;
        }}
      >
        <ShadeHistory
          partyId={partyId}
          onPick={(record) => {
            setForm(formOf(choiceFromRecord(record)));
            setProblems({});
          }}
        />
        <p className="tint-dialog__base">
          <span className="muted">{t('tint.base')}</span> {line.name}
        </p>
        <div className="form-grid">
          <Field
            label={t('tint.shadeCode')}
            hint={t('tint.shadeCodeHint')}
            error={problem('shadeCode')}
            required
          >
            <Input
              value={form.shadeCode}
              onChange={(event) => {
                set({ shadeCode: event.target.value });
              }}
            />
          </Field>
          <Field label={t('tint.shadeName')} error={problem('shadeName')}>
            <Input
              value={form.shadeName}
              onChange={(event) => {
                set({ shadeName: event.target.value });
              }}
            />
          </Field>
          <Field label={t('tint.machine')} hint={t('tint.machineHint')} error={problem('machine')}>
            <Input
              value={form.machine}
              onChange={(event) => {
                set({ machine: event.target.value });
              }}
            />
          </Field>
          <Field label={t('tint.chargeLabel')} error={problem('charge')}>
            <Input
              inputMode="decimal"
              value={form.charge}
              onChange={(event) => {
                set({ charge: event.target.value });
              }}
            />
          </Field>
          <Field label={t('tint.costLabel')} hint={t('tint.costHint')} error={problem('cost')}>
            <Input
              inputMode="decimal"
              value={form.cost}
              onChange={(event) => {
                set({ cost: event.target.value });
              }}
            />
          </Field>
        </div>
        <fieldset className="tint-formula stack">
          <legend>{t('tint.formula')}</legend>
          <p className="muted">{t('tint.formulaHint')}</p>
          {form.formula.map((row, index) => {
            const number = String(index + 1);
            return (
              <div key={index} className="tint-formula__row">
                <Input
                  aria-label={t('tint.colorant', { number })}
                  value={row.colorant}
                  onChange={(event) => {
                    setRow(index, { colorant: event.target.value });
                  }}
                />
                <Input
                  aria-label={t('tint.amount', { number })}
                  inputMode="decimal"
                  value={row.amount}
                  onChange={(event) => {
                    setRow(index, { amount: event.target.value });
                  }}
                />
                <Select
                  aria-label={t('tint.unit', { number })}
                  value={row.unit}
                  onChange={(event) => {
                    // The select offers only COLORANT_UNITS.
                    setRow(index, { unit: event.target.value as ColorantUnit });
                  }}
                >
                  {COLORANT_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`tint.units.${unit}`)}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('tint.removeColorant', { number })}
                  onClick={() => {
                    const rest = form.formula.filter((_, at) => at !== index);
                    set({ formula: rest.length === 0 ? [EMPTY_ROW] : rest });
                  }}
                >
                  ×
                </Button>
              </div>
            );
          })}
          {problems.formula !== undefined && (
            <p className="tint-formula__error" role="alert">
              {problem('formula')}
            </p>
          )}
          <div className="row">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                set({ formula: [...form.formula, EMPTY_ROW] });
              }}
            >
              {t('tint.addColorant')}
            </Button>
          </div>
        </fieldset>
        {line.tint && (
          <div className="row">
            <Button
              variant="danger"
              onClick={() => {
                onApply(null);
              }}
            >
              {t('tint.remove')}
            </Button>
          </div>
        )}
      </FormDialog>
    </div>
  );
}

/** The line's shade and its Tint button; nothing for a product that is not tinted. */
export function TintControl({
  line,
  index,
  partyId,
  dispatch,
}: {
  readonly line: BillLine;
  readonly index: number;
  /** The bill-to, whose shade history is offered first. */
  readonly partyId: string | null;
  readonly dispatch: Dispatch<BillAction>;
}) {
  const { t, money } = useI18n();
  const tintable = useTintable(line);
  const [open, setOpen] = useState(false);
  if (!tintable) return null;
  const { tint } = line;
  return (
    <span className="pos-line__tint">
      {tint && (
        <span>
          {t('tint.shown', { shade: shadeLabel(tint) })}
          {tint.tintChargePaise > 0 &&
            ` · ${t('tint.charge', { amount: money(tint.tintChargePaise) })}`}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label={t(tint ? 'tint.editOf' : 'tint.buttonOf', { name: line.name })}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t(tint ? 'tint.edit' : 'tint.button')}
      </Button>
      {open && (
        <TintDialog
          line={line}
          partyId={partyId}
          onClose={() => {
            setOpen(false);
          }}
          onApply={(tint) => {
            dispatch({ type: 'tint', index, tint });
            setOpen(false);
          }}
        />
      )}
    </span>
  );
}
