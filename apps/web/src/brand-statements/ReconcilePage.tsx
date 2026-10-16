import {
  STATEMENT_LINE_STATUSES,
  type BrandStatementDetail,
  type OurRecordView,
  type StatementLineStatus,
  type StatementLineView,
} from '@paint/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Textarea,
  useToast,
  type Tone,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { FormDialog } from '../lib/FormDialog.js';
import { optional } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { PURCHASING_SECTIONS } from '../purchasing/sections.js';
import { statementsKey } from './StatementsPage.js';

const TONES: Readonly<Record<StatementLineStatus, Tone>> = {
  matched: 'success',
  partial: 'warning',
  unmatched: 'danger',
  explained: 'info',
  untracked: 'neutral',
};

type Filter = 'all' | 'problems' | StatementLineStatus;
interface Action {
  readonly kind: 'match' | 'explain' | 'scheme';
  readonly line: StatementLineView;
}

const detailKey = (id: string) => [...statementsKey, id] as const;

/** Runs a change and puts the statement it answers in the cache. */
function useSaver(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  return async (work: () => Promise<BrandStatementDetail>) => {
    const detail = await work();
    queryClient.setQueryData(detailKey(id), detail);
    await queryClient.invalidateQueries({
      queryKey: statementsKey,
      exact: false,
      refetchType: 'none',
    });
    toast({ title: t('statements.reconcile.done'), tone: 'success' });
  };
}

function MatchDialog({
  detail,
  line,
  onClose,
}: {
  readonly detail: BrandStatementDetail;
  readonly line: StatementLineView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, money, date, label } = useI18n();
  const save = useSaver(detail.statement.id);
  const [recordKey, setRecordKey] = useState('');
  const [note, setNote] = useState('');
  const open = detail.ours.filter((record) => record.lineId === null && !record.elsewhere);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('statements.reconcile.matchTitle', { row: String(line.rowNumber) })}
      description={t('statements.reconcile.matchHint')}
      submitLabel={t('statements.reconcile.matchSubmit')}
      onSubmit={async () => {
        if (recordKey === '') return t('statements.reconcile.chooseRecord');
        await save(() =>
          api.statements.match(detail.statement.id, line.id, { recordKey, note: optional(note) }),
        );
        return undefined;
      }}
    >
      {open.length === 0 ? (
        <p className="muted">{t('statements.reconcile.noRecords2')}</p>
      ) : (
        <Field label={t('statements.reconcile.record')}>
          <Select
            value={recordKey}
            onChange={(event) => {
              setRecordKey(event.target.value);
            }}
          >
            <option value="">{t('statements.reconcile.chooseRecord')}</option>
            {open.map((record) => (
              <option key={record.key} value={record.key}>
                {label('ourRecordKind', record.kind)} {record.number} · {record.reference ?? '—'} ·{' '}
                {date(record.date)} · {money(record.amountPaise)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t('statements.reconcile.noteOptional')}>
        <Input
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function ExplainDialog({
  detail,
  line,
  onClose,
}: {
  readonly detail: BrandStatementDetail;
  readonly line: StatementLineView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const save = useSaver(detail.statement.id);
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('statements.reconcile.explainTitle', { row: String(line.rowNumber) })}
      submitLabel={t('statements.reconcile.explainSubmit')}
      onSubmit={async () => {
        const text = note.trim();
        if (text === '') return t('statements.reconcile.explainRequired');
        await save(() => api.statements.explain(detail.statement.id, line.id, text));
        return undefined;
      }}
    >
      <Field
        label={t('statements.reconcile.explainNote')}
        hint={t('statements.reconcile.explainHint')}
      >
        <Textarea
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function SchemeDialog({
  detail,
  line,
  onClose,
}: {
  readonly detail: BrandStatementDetail;
  readonly line: StatementLineView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const save = useSaver(detail.statement.id);
  const brandId = String(detail.statement.brand?.id);
  const schemes = useQuery({
    queryKey: ['brand-schemes', { brandId }],
    queryFn: ({ signal }) => api.schemes.list({ brandId }, signal),
  });
  const choices = (schemes.data ?? []).filter(
    ({ scheme }) => scheme.status === 'active' || scheme.status === 'closed',
  );
  const [schemeId, setSchemeId] = useState('');
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('statements.reconcile.schemeTitle', { row: String(line.rowNumber) })}
      description={t('statements.reconcile.schemeHint')}
      submitLabel={t('statements.reconcile.schemeSubmit')}
      onSubmit={async () => {
        if (schemeId === '') return t('statements.reconcile.chooseScheme');
        await save(() =>
          api.statements.schemeReceipt(detail.statement.id, line.id, {
            schemeId,
            claimId: null,
            note: optional(note),
          }),
        );
        return undefined;
      }}
    >
      {schemes.isSuccess && choices.length === 0 ? (
        <p className="muted">{t('statements.reconcile.noSchemes')}</p>
      ) : (
        <Field label={t('statements.reconcile.scheme')}>
          <Select
            value={schemeId}
            onChange={(event) => {
              setSchemeId(event.target.value);
            }}
          >
            <option value="">{t('statements.reconcile.chooseScheme')}</option>
            {choices.map(({ scheme }) => (
              <option key={scheme.id} value={scheme.id}>
                {scheme.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t('statements.reconcile.noteOptional')}>
        <Input
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function Summary({ detail }: { readonly detail: BrandStatementDetail }) {
  const { t, money, number } = useI18n();
  const { summary, tolerance } = detail;
  const figure = (key: Parameters<typeof t>[0], paise: number) => (
    <>
      <dt>{t(key)}</dt>
      <dd className="numeric">{money(paise)}</dd>
    </>
  );
  return (
    <Card title={t('statements.reconcile.summary')}>
      <div className="statement-summary">
        <dl className="facts">
          {figure('statements.reconcile.brandMovement', summary.brandMovementPaise)}
          {figure('statements.reconcile.ourMovement', summary.ourMovementPaise)}
          <dt>
            <strong>{t('statements.reconcile.difference')}</strong>
          </dt>
          <dd className="numeric">
            <strong>{money(summary.differencePaise)}</strong>
          </dd>
        </dl>
        <dl className="facts" aria-label={t('statements.reconcile.explainedBy')}>
          {figure('statements.reconcile.amountDifferences', summary.amountDifferencesPaise)}
          {figure('statements.reconcile.unmatchedLines', summary.unmatchedLinesPaise)}
          {figure('statements.reconcile.explainedLines', summary.explainedLinesPaise)}
          {figure('statements.reconcile.untrackedLines', summary.untrackedLinesPaise)}
          <dt>
            {t('statements.reconcile.ourUnmatched', { count: number(summary.ourUnmatchedCount) })}
          </dt>
          <dd className="numeric">{money(-summary.ourUnmatchedPaise)}</dd>
        </dl>
        <dl className="facts">
          {summary.openingBalancePaise !== null &&
            figure('statements.reconcile.opening', summary.openingBalancePaise)}
          {summary.brandClosingPaise !== null &&
            figure('statements.reconcile.brandClosing', summary.brandClosingPaise)}
          {summary.printedClosingPaise !== null &&
            figure('statements.reconcile.printedClosing', summary.printedClosingPaise)}
        </dl>
      </div>
      <p className="muted">
        {t('statements.reconcile.tolerance', {
          days: number(tolerance.dateWindowDays),
          amount: money(tolerance.amountTolerancePaise),
        })}{' '}
        {summary.counts.untracked > 0 && t('statements.reconcile.untrackedHint')}
      </p>
    </Card>
  );
}

function MatchCell({
  line,
  records,
}: {
  readonly line: StatementLineView;
  readonly records: ReadonlyMap<string, OurRecordView>;
}) {
  const { t, money, label } = useI18n();
  const { match } = line;
  if (match === null) return <span className="muted">—</span>;
  const record = match.recordKey === null ? undefined : records.get(match.recordKey);
  return (
    <span className="statement-match">
      {record !== undefined && (
        <span>
          {label('ourRecordKind', record.kind)} {record.number}
          {record.reference !== null && ` · ${record.reference}`}
        </span>
      )}
      <span className="muted">
        {match.source === 'auto'
          ? t('statements.reconcile.auto')
          : t('statements.reconcile.manualBy', { name: String(match.by) })}
      </span>
      {match.differencePaise !== null && match.differencePaise !== 0 && (
        <span>{t('statements.reconcile.differs', { amount: money(match.differencePaise) })}</span>
      )}
      {match.note !== null && <span>{t('statements.reconcile.note', { note: match.note })}</span>}
    </span>
  );
}

function ReconcileView({ detail }: { readonly detail: BrandStatementDetail }) {
  const api = useApi();
  const { t, money, date, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const save = useSaver(detail.statement.id);
  const [filter, setFilter] = useState<Filter>('all');
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const active = detail.statement.status === 'active';
  const manage = active && can('schemes:manage');
  const records = new Map(detail.ours.map((record) => [record.key, record]));
  const shown = detail.lines.filter(
    (line) =>
      line.kind !== 'opening' &&
      (filter === 'all' ||
        (filter === 'problems'
          ? line.status === 'unmatched' || line.status === 'partial'
          : line.status === filter)),
  );
  const rowOf = new Map(detail.lines.map((line) => [line.id, line.rowNumber]));
  const attempt = (work: () => Promise<unknown>) => {
    setMessage(null);
    work().catch((error: unknown) => {
      setMessage(errorMessage(error));
    });
  };
  const download = (kind: 'csv' | 'file') => {
    const file =
      kind === 'csv'
        ? api.statements.csv(detail.statement.id)
        : api.statements.file(detail.statement.id);
    file
      .then((downloaded) => {
        saveFile(downloaded.blob, downloaded.fileName ?? detail.statement.fileName);
      })
      .catch((error: unknown) => {
        toast({
          title: t('statements.reconcile.csvFailed'),
          description: errorMessage(error),
          tone: 'danger',
        });
      });
  };

  return (
    <div className="stack">
      {!active && <Alert tone="warning">{t('statements.reconcile.isDiscarded')}</Alert>}
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Summary detail={detail} />
      <div className="row">
        {manage && (
          <Button
            variant="secondary"
            onClick={() => {
              attempt(async () => {
                const run = await api.statements.rematch(detail.statement.id);
                queryClient.setQueryData(detailKey(detail.statement.id), run.detail);
                toast({
                  title: t('statements.reconcile.rematched', {
                    added: String(run.added),
                    removed: String(run.removed),
                  }),
                  tone: 'success',
                });
              });
            }}
          >
            {t('statements.reconcile.rematch')}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            download('csv');
          }}
        >
          {t('statements.reconcile.export')}
        </Button>
        {detail.statement.fileKept ? (
          <Button
            variant="ghost"
            onClick={() => {
              download('file');
            }}
          >
            {t('statements.reconcile.file')}
          </Button>
        ) : (
          <span className="muted">{t('statements.reconcile.fileNotKept')}</span>
        )}
        {manage && (
          <Button
            variant="danger"
            onClick={() => {
              setDiscarding(true);
            }}
          >
            {t('statements.reconcile.discard')}
          </Button>
        )}
      </div>
      <Card>
        <Field label={t('statements.reconcile.status')}>
          <Select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as Filter);
            }}
          >
            <option value="all">{t('statements.reconcile.all')}</option>
            <option value="problems">{t('statements.reconcile.problems')}</option>
            {STATEMENT_LINE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label('statementLineStatus', status)}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      <div className="statement-sides">
        <Card title={t('statements.reconcile.brandSide')}>
          {shown.length === 0 ? (
            <p className="muted">{t('statements.reconcile.noLines')}</p>
          ) : (
            <Table label={t('statements.reconcile.brandSide')}>
              <thead>
                <tr>
                  <th scope="col">{t('statements.reconcile.columns.date')}</th>
                  <th scope="col">{t('statements.reconcile.columns.document')}</th>
                  <th scope="col">{t('statements.reconcile.columns.amount')}</th>
                  <th scope="col">{t('statements.reconcile.columns.status')}</th>
                  <th scope="col">{t('statements.reconcile.columns.match')}</th>
                  {manage && <th scope="col">{t('statements.reconcile.columns.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((line) => (
                  <tr key={line.id}>
                    <td>{date(line.lineDate)}</td>
                    <th scope="row">
                      {line.documentNumber ?? '—'}
                      <span className="muted">
                        {' '}
                        · {label('statementLineKind', line.kind)} ·{' '}
                        {t('statements.reconcile.line', { row: String(line.rowNumber) })}
                      </span>
                      {line.description !== null && (
                        <span className="muted"> · {line.description}</span>
                      )}
                    </th>
                    <td className="numeric">{money(line.amountPaise)}</td>
                    <td>
                      <Badge tone={TONES[line.status]}>
                        {label('statementLineStatus', line.status)}
                      </Badge>
                    </td>
                    <td>
                      <MatchCell line={line} records={records} />
                    </td>
                    {manage && (
                      <td>
                        <div className="row">
                          {line.match === null ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setAction({ kind: 'match', line });
                                }}
                              >
                                {t('statements.reconcile.match')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setAction({ kind: 'explain', line });
                                }}
                              >
                                {t('statements.reconcile.explain')}
                              </Button>
                              {line.amountPaise < 0 && detail.statement.brand !== null && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setAction({ kind: 'scheme', line });
                                  }}
                                >
                                  {t('statements.reconcile.schemeReceipt')}
                                </Button>
                              )}
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                attempt(() =>
                                  save(() => api.statements.unmatch(detail.statement.id, line.id)),
                                );
                              }}
                            >
                              {t('statements.reconcile.unmatch')}
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title={t('statements.reconcile.ourSide')}>
          {detail.ours.length === 0 ? (
            <p className="muted">{t('statements.reconcile.noRecords')}</p>
          ) : (
            <Table label={t('statements.reconcile.ourSide')}>
              <thead>
                <tr>
                  <th scope="col">{t('statements.reconcile.columns.date')}</th>
                  <th scope="col">{t('statements.reconcile.columns.record')}</th>
                  <th scope="col">{t('statements.reconcile.columns.amount')}</th>
                  <th scope="col">{t('statements.reconcile.columns.settles')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.ours.map((record) => (
                  <tr key={record.key}>
                    <td>{date(record.date)}</td>
                    <th scope="row">
                      {label('ourRecordKind', record.kind)} {record.number}
                      {record.reference !== null && (
                        <span className="muted"> · {record.reference}</span>
                      )}
                    </th>
                    <td className="numeric">{money(record.amountPaise)}</td>
                    <td>
                      {record.lineId !== null ? (
                        t('statements.reconcile.line', { row: String(rowOf.get(record.lineId)) })
                      ) : record.elsewhere ? (
                        <span className="muted">{t('statements.reconcile.elsewhere')}</span>
                      ) : record.inPeriod ? (
                        <Badge tone="danger">{t('statements.reconcile.unsettled')}</Badge>
                      ) : (
                        <span className="muted">{t('statements.reconcile.outside')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      {action?.kind === 'match' && (
        <MatchDialog
          detail={detail}
          line={action.line}
          onClose={() => {
            setAction(null);
          }}
        />
      )}
      {action?.kind === 'explain' && (
        <ExplainDialog
          detail={detail}
          line={action.line}
          onClose={() => {
            setAction(null);
          }}
        />
      )}
      {action?.kind === 'scheme' && (
        <SchemeDialog
          detail={detail}
          line={action.line}
          onClose={() => {
            setAction(null);
          }}
        />
      )}
      <Dialog
        open={discarding}
        onOpenChange={setDiscarding}
        title={t('statements.reconcile.discardTitle')}
        description={t('statements.reconcile.discardBody')}
        footer={
          <Button
            variant="danger"
            onClick={() => {
              setDiscarding(false);
              attempt(async () => {
                await api.statements.discard(detail.statement.id);
                await queryClient.invalidateQueries({ queryKey: statementsKey });
                toast({ title: t('statements.reconcile.discarded'), tone: 'success' });
              });
            }}
          >
            {t('statements.reconcile.discard')}
          </Button>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}

/** /brand-statements/:id — the reconciliation: both sides, how each line stands, the figures. */
export function ReconcilePage() {
  const api = useApi();
  const { t, date } = useI18n();
  const { id = '' } = useParams();
  const detail = useQuery({
    queryKey: detailKey(id),
    queryFn: ({ signal }) => api.statements.detail(id, signal),
  });
  return (
    <>
      <PageHeader
        title={
          detail.data === undefined
            ? t('statements.title')
            : t('statements.reconcile.title', {
                number: detail.data.statement.number,
                supplier: detail.data.statement.supplier.name,
              })
        }
        description={
          detail.data === undefined
            ? undefined
            : t('statements.period', {
                from: date(detail.data.statement.periodFrom),
                to: date(detail.data.statement.periodTo),
              })
        }
      />
      <SectionNav label="purchasing.sections" links={PURCHASING_SECTIONS} />
      <QueryState query={detail} error="statements.reconcile.error">
        {(data) => <ReconcileView detail={data} />}
      </QueryState>
    </>
  );
}
