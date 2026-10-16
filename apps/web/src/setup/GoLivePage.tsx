import type { GoLiveOpeningView, GoLivePreview } from '@paint/shared';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Table,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { Facts } from '../leads/Facts.js';
import { FormDialog } from '../lib/FormDialog.js';
import { isDate, todayInIndia } from '../lib/india-time.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import '../styles/setup.css';
import { GO_LIVE_KEY } from './setup-api.js';

/** One customer's opening balance as shown: from the API, or changed on this page. */
export interface OpeningEntry {
  readonly partyId: string;
  readonly partyName: string;
  readonly amountPaise: number;
  readonly overdueSince: string | null;
  readonly source: GoLiveOpeningView['source'] | 'here';
}

/** The API's openings with this page's changes laid over them, and the customers added here. */
export function mergeOpenings(
  openings: readonly GoLiveOpeningView[],
  changes: ReadonlyMap<string, OpeningEntry>,
): OpeningEntry[] {
  const merged: OpeningEntry[] = openings.map((opening) => changes.get(opening.partyId) ?? opening);
  const known = new Set(openings.map((opening) => opening.partyId));
  for (const entry of changes.values()) if (!known.has(entry.partyId)) merged.push(entry);
  return merged;
}

/** Customers with something owed, the total, and those with an overdue date. */
export function openingTotals(entries: readonly OpeningEntry[]) {
  const owing = entries.filter((entry) => entry.amountPaise > 0);
  return {
    customers: owing.length,
    totalPaise: owing.reduce((sum, entry) => sum + entry.amountPaise, 0),
    overdue: owing.filter((entry) => entry.overdueSince !== null).length,
  };
}

function LiveCard({
  preview,
  posted,
}: {
  readonly preview: GoLivePreview;
  readonly posted: NonNullable<GoLivePreview['posted']>;
}) {
  const { t, date, money, number } = useI18n();
  return (
    <Card title={t('goLive.live.title')}>
      <div className="stack">
        <Alert tone="success">
          {t('goLive.live.since', { date: date(String(preview.billingLiveOn)) })}
        </Alert>
        <Facts
          facts={[
            [
              t('goLive.live.posted'),
              t('goLive.live.postedValue', {
                count: number(posted.entries),
                amount: money(posted.totalPaise),
              }),
            ],
          ]}
        />
        <p className="muted">{t('goLive.live.fixes')}</p>
        <div>
          <Link to="/receivables" {...buttonStyle('secondary')}>
            {t('goLive.live.next')}
          </Link>
        </div>
      </div>
    </Card>
  );
}

/** Edits one customer's opening balance and overdue date (CA-7, CA-40). */
function OpeningDialog({
  entry,
  onClose,
  onSave,
}: {
  readonly entry: OpeningEntry;
  readonly onClose: () => void;
  readonly onSave: (entry: OpeningEntry) => void;
}) {
  const { t } = useI18n();
  // Not in the future, as the opening-balances import checks.
  const today = todayInIndia();
  const [amount, setAmount] = useState(rupeesInput(entry.amountPaise));
  const [overdueSince, setOverdueSince] = useState(entry.overdueSince ?? '');
  const submit = () => {
    const amountPaise = parseRupees(amount);
    if (amountPaise === null || amountPaise < 0) return t('goLive.dialog.amountInvalid');
    if (overdueSince !== '' && (!isDate(overdueSince) || overdueSince > today)) {
      return t('goLive.dialog.overdueInvalid');
    }
    if (overdueSince !== '' && amountPaise === 0) return t('goLive.dialog.overdueNothing');
    onSave({
      ...entry,
      amountPaise,
      overdueSince: overdueSince === '' ? null : overdueSince,
      source: 'here',
    });
    return undefined;
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('goLive.dialog.title', { name: entry.partyName })}
      submitLabel={t('goLive.dialog.save')}
      onSubmit={submit}
    >
      <div className="form-grid">
        <Field label={t('goLive.dialog.amount')} hint={t('goLive.dialog.amountHint')} required>
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </Field>
        <Field label={t('goLive.dialog.overdueSince')} hint={t('goLive.dialog.overdueHint')}>
          <Input
            type="date"
            max={today}
            value={overdueSince}
            onChange={(event) => {
              setOverdueSince(event.target.value);
            }}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function ConfirmDialog({
  liveOn,
  entries,
  onClose,
}: {
  readonly liveOn: string;
  readonly entries: readonly OpeningEntry[];
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, date, money, number } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  // One key for this page: a retried post (a lost answer) goes live once.
  const [key] = useState(() => crypto.randomUUID());
  const [checked, setChecked] = useState(false);
  const totals = openingTotals(entries);
  const submit = async () => {
    if (!checked) return t('goLive.confirm.checkFirst');
    await api.setup.postGoLive(
      {
        liveOn,
        openings: entries
          .filter((entry) => entry.source === 'here')
          .map(({ partyId, amountPaise, overdueSince }) => ({
            partyId,
            amountPaise,
            overdueSince,
          })),
      },
      key,
    );
    await queryClient.invalidateQueries({ queryKey: GO_LIVE_KEY });
    toast({ title: t('goLive.confirm.done'), tone: 'success' });
    return undefined;
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('goLive.confirm.title', { date: date(liveOn) })}
      submitLabel={t('goLive.confirm.submit')}
      onSubmit={submit}
    >
      <Alert tone="warning">{t('goLive.confirm.warning')}</Alert>
      <p>
        {t('goLive.confirm.summary', {
          count: number(totals.customers),
          amount: money(totals.totalPaise),
        })}
      </p>
      <Checkbox
        label={t('goLive.confirm.checked')}
        checked={checked}
        onChange={(event) => {
          setChecked(event.target.checked);
        }}
      />
    </FormDialog>
  );
}

function OpeningsTable({
  entries,
  onEdit,
}: {
  readonly entries: readonly OpeningEntry[];
  readonly onEdit: (entry: OpeningEntry) => void;
}) {
  const { t, date, money } = useI18n();
  if (entries.length === 0) {
    return (
      <EmptyState icon={<Icon name="customers" size={32} />} title={t('goLive.openings.empty')} />
    );
  }
  return (
    <Table label={t('goLive.openings.table')}>
      <thead>
        <tr>
          <th scope="col">{t('goLive.openings.party')}</th>
          <th scope="col">{t('goLive.openings.source')}</th>
          <th scope="col" className="num">
            {t('goLive.openings.amount')}
          </th>
          <th scope="col">{t('goLive.openings.overdueSince')}</th>
          <th scope="col">
            <span className="ui-visually-hidden">{t('goLive.openings.edit')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.partyId}>
            <td>{entry.partyName}</td>
            <td>{t(`goLive.openings.sources.${entry.source}`)}</td>
            <td className="num">{money(entry.amountPaise)}</td>
            <td>
              {entry.overdueSince === null
                ? t('goLive.openings.notOverdue')
                : date(entry.overdueSince)}
            </td>
            <td>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('goLive.openings.editLabel', { name: entry.partyName })}
                onClick={() => {
                  onEdit(entry);
                }}
              >
                {t('goLive.openings.edit')}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Setup({
  preview,
  liveOn,
  setLiveOn,
  dateValid,
}: {
  readonly preview: GoLivePreview;
  readonly liveOn: string;
  readonly setLiveOn: (value: string) => void;
  readonly dateValid: boolean;
}) {
  const { t, date, money, number } = useI18n();
  const [changes, setChanges] = useState<ReadonlyMap<string, OpeningEntry>>(new Map());
  const [editing, setEditing] = useState<OpeningEntry | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const entries = mergeOpenings(preview.openings, changes);
  const totals = openingTotals(entries);
  const save = (entry: OpeningEntry) => {
    setChanges((current) => new Map(current).set(entry.partyId, entry));
  };
  return (
    <div className="stack">
      <Card title={t('goLive.date.title')}>
        <Field
          label={t('goLive.date.label')}
          hint={t('goLive.date.hint')}
          error={dateValid ? undefined : t('goLive.date.invalid')}
        >
          <Input
            type="date"
            max={todayInIndia()}
            value={liveOn}
            onChange={(event) => {
              setLiveOn(event.target.value);
            }}
          />
        </Field>
      </Card>
      <Card
        title={t('goLive.openings.title')}
        actions={
          <span className="setup-actions">
            <Link to="/imports?kind=opening-balances" {...buttonStyle('secondary', 'sm')}>
              {t('goLive.openings.import')}
            </Link>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPicking(true);
              }}
            >
              {t('goLive.openings.add')}
            </Button>
          </span>
        }
      >
        <div className="stack">
          <p className="muted">{t('goLive.openings.intro')}</p>
          <Alert tone="info">{t('goLive.openings.blankRule')}</Alert>
          <OpeningsTable entries={entries} onEdit={setEditing} />
        </div>
      </Card>
      <Card title={t('goLive.review.title')}>
        <div className="stack">
          <Facts
            facts={[
              [t('goLive.review.customers'), number(totals.customers)],
              [t('goLive.review.total'), money(totals.totalPaise)],
              [t('goLive.review.overdue'), number(totals.overdue)],
              [t('goLive.review.loyalty'), number(preview.loyaltyAccounts)],
            ]}
          />
          {changes.size > 0 && <p className="muted">{t('goLive.review.unsaved')}</p>}
          <div className="row row--end">
            <Button
              disabled={!dateValid}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t('goLive.review.start', { date: dateValid ? date(liveOn) : liveOn })}
            </Button>
          </div>
        </div>
      </Card>
      {editing !== null && (
        <OpeningDialog
          entry={editing}
          onSave={save}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      <Dialog
        open={picking}
        onOpenChange={setPicking}
        title={t('goLive.openings.pick')}
        closeLabel={t('common.close')}
      >
        <PartyPicker
          title={t('goLive.openings.add')}
          onPick={(party) => {
            setPicking(false);
            setEditing(
              entries.find((entry) => entry.partyId === party.id) ?? {
                partyId: party.id,
                partyName: party.displayName,
                amountPaise: 0,
                overdueSince: null,
                source: 'here',
              },
            );
          }}
        />
      </Dialog>
      {confirming && (
        <ConfirmDialog
          liveOn={liveOn}
          entries={entries}
          onClose={() => {
            setConfirming(false);
          }}
        />
      )}
    </div>
  );
}

/** /settings/go-live — the day billing starts, with each customer's opening balance (PO-100). */
export function GoLivePage() {
  const api = useApi();
  const { t } = useI18n();
  const [liveOn, setLiveOn] = useState(todayInIndia);
  const dateValid = isDate(liveOn) && liveOn <= todayInIndia();
  const preview = useQuery({
    queryKey: [...GO_LIVE_KEY, liveOn],
    queryFn: ({ signal }) => api.setup.goLive(liveOn, signal),
    enabled: dateValid,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title={t('goLive.title')} description={t('goLive.description')} />
      <QueryState query={preview} error="goLive.error">
        {(data) =>
          // Posted is set exactly when billing is live.
          data.posted ? (
            <LiveCard preview={data} posted={data.posted} />
          ) : (
            <Setup preview={data} liveOn={liveOn} setLiveOn={setLiveOn} dateValid={dateValid} />
          )
        }
      </QueryState>
    </>
  );
}
