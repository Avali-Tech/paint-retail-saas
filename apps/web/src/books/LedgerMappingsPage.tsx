import { Alert, Button, Card, Field, Input, PageHeader, Select, Table, useToast } from '@paint/ui';
import {
  LEDGER_MATCH_FIELDS,
  PAYMENT_MODE_KINDS,
  SUPPLY_TYPES,
  TALLY_GROUPS,
  TALLY_LEDGER_PURPOSES,
  TAX_NATURES,
  type LedgerMappingView,
  type PaymentModeView,
} from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type SyntheticEvent } from 'react';
import type { Store } from '../api/stock.js';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import { useLandingOnChange, usePageLanding } from '../sales/focus-landing.js';
import { storeLabel } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { AccountingNav } from './AccountingNav.js';
import {
  EMPTY_MAPPING,
  formOf,
  mappingRequest,
  type MappingForm,
  type MappingProblem,
} from './mapping-form.js';

export const mappingsKey = ['ledger-mappings'] as const;

/** What a mapping matches on, in words: "18% · Within the state · AMP · Ameerpet". */
function useMatchText(stores: readonly Store[], modes: readonly PaymentModeView[]) {
  const { t, label } = useI18n();
  return (mapping: LedgerMappingView) => {
    const store = stores.find((choice) => choice.id === mapping.storeId);
    const mode = modes.find((choice) => choice.id === mapping.modeId);
    const parts = [
      mapping.rateBasisPoints === null
        ? null
        : t('books.ledgers.ratePercent', { rate: mapping.rateBasisPoints / 100 }),
      mapping.nature === null ? null : label('taxNatures', mapping.nature),
      mapping.supplyType === null ? null : label('supplyTypes', mapping.supplyType),
      mapping.modeKind === null ? null : label('paymentModeKinds', mapping.modeKind),
      mode === undefined ? null : mode.name,
      mapping.partyName,
      store === undefined ? null : storeLabel(store),
    ].filter((part) => part !== null);
    return parts.length === 0 ? t('books.ledgers.any') : parts.join(' · ');
  };
}

/** Adds a mapping, or edits the one chosen; only the facts its purpose has are offered. */
function MappingEditor({
  editing,
  stores,
  modes,
  onDone,
}: {
  readonly editing: LedgerMappingView | null;
  readonly stores: readonly Store[];
  readonly modes: readonly PaymentModeView[];
  readonly onDone: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<MappingForm>(() =>
    editing === null ? EMPTY_MAPPING : formOf(editing),
  );
  const [problems, setProblems] = useState<MappingProblem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const changeParty = useRef<HTMLButtonElement>(null);
  // The picker goes once a party is picked: the focus moves to "Change".
  useLandingOnChange(form.party === null, changeParty);
  const fields = LEDGER_MATCH_FIELDS[form.purpose];
  const change = (next: Partial<MappingForm>) => {
    setForm({ ...form, ...next });
  };
  const error = (problem: MappingProblem, key: Parameters<typeof t>[0]) =>
    problems.includes(problem) ? t(key) : undefined;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setMessage(null);
    const result = mappingRequest(form);
    if ('problems' in result) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    setPending(true);
    try {
      await (editing === null
        ? api.books.createMapping(result.request)
        : api.books.updateMapping(editing.id, result.request));
      await queryClient.invalidateQueries({ queryKey: mappingsKey });
      toast({ title: t('books.ledgers.saved'), tone: 'success' });
      onDone();
    } catch (caught) {
      setMessage(errorMessage(caught));
      setPending(false);
    }
  };

  return (
    <Card title={editing === null ? t('books.ledgers.addTitle') : t('books.ledgers.editTitle')}>
      <form
        className="stack"
        noValidate
        aria-label={editing === null ? t('books.ledgers.addTitle') : t('books.ledgers.editTitle')}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <div className="form-grid">
          <Field label={t('books.ledgers.purpose')}>
            <Select
              value={form.purpose}
              onChange={(event) => {
                change({ purpose: event.target.value as MappingForm['purpose'] });
              }}
            >
              {TALLY_LEDGER_PURPOSES.map((value) => (
                <option key={value} value={value}>
                  {label('ledgerPurposes', value)}
                </option>
              ))}
            </Select>
          </Field>
          {fields.includes('rateBasisPoints') && (
            <Field
              label={t('books.ledgers.rate')}
              hint={t('books.ledgers.rateHint')}
              error={error('rate', 'books.ledgers.rateInvalid')}
            >
              <Input
                inputMode="decimal"
                value={form.rate}
                onChange={(event) => {
                  change({ rate: event.target.value });
                }}
              />
            </Field>
          )}
          {fields.includes('nature') && (
            <Field label={t('books.ledgers.nature')}>
              <Select
                value={form.nature}
                onChange={(event) => {
                  change({ nature: event.target.value as MappingForm['nature'] });
                }}
              >
                <option value="">{t('books.ledgers.any')}</option>
                {TAX_NATURES.map((value) => (
                  <option key={value} value={value}>
                    {label('taxNatures', value)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {fields.includes('supplyType') && (
            <Field label={t('books.ledgers.supply')}>
              <Select
                value={form.supplyType}
                onChange={(event) => {
                  change({ supplyType: event.target.value as MappingForm['supplyType'] });
                }}
              >
                <option value="">{t('books.ledgers.any')}</option>
                {SUPPLY_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {label('supplyTypes', value)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {fields.includes('modeKind') && (
            <Field label={t('books.ledgers.modeKind')}>
              <Select
                value={form.modeKind}
                onChange={(event) => {
                  change({ modeKind: event.target.value as MappingForm['modeKind'] });
                }}
              >
                <option value="">{t('books.ledgers.any')}</option>
                {PAYMENT_MODE_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {label('paymentModeKinds', value)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {fields.includes('modeId') && (
            <Field label={t('books.ledgers.mode')}>
              <Select
                value={form.modeId}
                onChange={(event) => {
                  change({ modeId: event.target.value });
                }}
              >
                <option value="">{t('books.ledgers.any')}</option>
                {modes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('books.ledgers.store')}>
            <Select
              value={form.storeId}
              onChange={(event) => {
                change({ storeId: event.target.value });
              }}
            >
              <option value="">{t('books.ledgers.anyStore')}</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {storeLabel(store)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('books.ledgers.ledger')} error={error('ledgerName', 'common.required')}>
            <Input
              value={form.ledgerName}
              maxLength={200}
              onChange={(event) => {
                change({ ledgerName: event.target.value });
              }}
            />
          </Field>
          <Field label={t('books.ledgers.group')} hint={t('books.ledgers.groupHint')}>
            <Select
              value={form.group}
              onChange={(event) => {
                change({ group: event.target.value as MappingForm['group'] });
              }}
            >
              <option value="">{t('books.ledgers.usualGroup')}</option>
              {TALLY_GROUPS.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('books.ledgers.position')}
            hint={t('books.ledgers.positionHint')}
            error={error('position', 'books.ledgers.positionInvalid')}
          >
            <Input
              inputMode="numeric"
              value={form.position}
              onChange={(event) => {
                change({ position: event.target.value });
              }}
            />
          </Field>
        </div>
        {form.purpose === 'party' &&
          (form.party === null ? (
            <>
              {problems.includes('party') && (
                <Alert tone="danger">{t('books.ledgers.partyRequired')}</Alert>
              )}
              <PartyPicker
                title={t('books.ledgers.chooseParty')}
                onPick={(party) => {
                  change({ party: { id: party.id, name: party.displayName } });
                }}
              />
            </>
          ) : (
            <div className="row">
              <span>{t('books.ledgers.partyChosen', { name: form.party.name })}</span>
              <Button
                ref={changeParty}
                size="sm"
                variant="ghost"
                onClick={() => {
                  change({ party: null });
                }}
              >
                {t('books.ledgers.changeParty')}
              </Button>
            </div>
          ))}
        <div className="row row--end">
          {editing !== null && (
            <Button variant="ghost" onClick={onDone}>
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" loading={pending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Mappings({
  mappings,
  stores,
  modes,
}: {
  readonly mappings: readonly LedgerMappingView[];
  readonly stores: readonly Store[];
  readonly modes: readonly PaymentModeView[];
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const matchText = useMatchText(stores, modes);
  const [editing, setEditing] = useState<LedgerMappingView | null>(null);
  // A new editor for each mapping edited, and a fresh one after a save.
  const [round, setRound] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  // A removed row, or a saved editor, takes the button that had the focus with it.
  usePageLanding(true, `${String(round)}:${String(mappings.length)}`);

  const remove = async (mapping: LedgerMappingView) => {
    setMessage(null);
    try {
      await api.books.deleteMapping(mapping.id);
      await queryClient.invalidateQueries({ queryKey: mappingsKey });
      toast({ title: t('books.ledgers.removed'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  return (
    <div className="stack">
      <Card title={t('books.ledgers.title')}>
        <div className="stack">
          <p className="muted">{t('books.ledgers.defaults')}</p>
          {message !== null && <Alert tone="danger">{message}</Alert>}
          {mappings.length === 0 ? (
            <p>{t('books.ledgers.empty')}</p>
          ) : (
            <Table label={t('books.ledgers.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('books.ledgers.purpose')}</th>
                  <th scope="col">{t('books.ledgers.matches')}</th>
                  <th scope="col">{t('books.ledgers.ledger')}</th>
                  <th scope="col">{t('books.ledgers.group')}</th>
                  <th scope="col">{t('books.ledgers.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping) => (
                  <tr key={mapping.id}>
                    <th scope="row">{label('ledgerPurposes', mapping.purpose)}</th>
                    <td>{matchText(mapping)}</td>
                    <td>{mapping.ledgerName}</td>
                    <td>{mapping.group ?? t('books.ledgers.usualGroup')}</td>
                    <td>
                      <div className="row">
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={t('books.ledgers.editOf', { name: mapping.ledgerName })}
                          onClick={() => {
                            setEditing(mapping);
                            setRound(round + 1);
                          }}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('books.ledgers.removeOf', { name: mapping.ledgerName })}
                          onClick={() => {
                            void remove(mapping);
                          }}
                        >
                          {t('books.ledgers.remove')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>
      <MappingEditor
        key={round}
        editing={editing}
        stores={stores}
        modes={modes}
        onDone={() => {
          setEditing(null);
          setRound(round + 1);
        }}
      />
    </div>
  );
}

/** /accounting/ledgers — which Tally ledger each amount posts to (spec §6.1). */
export function LedgerMappingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const mappings = useQuery({
    queryKey: mappingsKey,
    queryFn: ({ signal }) => api.books.mappings(signal),
  });
  const modes = useQuery({
    queryKey: ['payment-modes', 'all'],
    queryFn: ({ signal }) => api.books.paymentModes(signal),
  });
  const stores = useStores();
  return (
    <>
      <PageHeader
        title={t('books.accounting.title')}
        description={t('books.accounting.description')}
      />
      <AccountingNav />
      <QueryState query={mappings} error="books.ledgers.error">
        {(list) => (
          <QueryState query={modes} error="books.ledgers.error">
            {(modeList) => (
              <QueryState query={stores} error="books.ledgers.error">
                {(storeList) => <Mappings mappings={list} stores={storeList} modes={modeList} />}
              </QueryState>
            )}
          </QueryState>
        )}
      </QueryState>
    </>
  );
}
