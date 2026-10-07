import { isPermission, toCsv } from '@paint/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Spinner,
  Table,
  buttonStyle,
  useToast,
  type Tone,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, errorMessage } from '../api/errors.js';
import type { ImportAction, ImportKind, ImportReport } from '../api/imports.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SpreadsheetError, readSpreadsheet, type SpreadsheetProblem } from './xlsx.js';

/** Rows shown in a report's tables; a 5,000-row file would freeze a phone. */
export const SHOWN_ROWS = 200;

const KIND_NAMES: Readonly<Record<string, MessageKey>> = {
  products: 'imports.kinds.products',
  parties: 'imports.kinds.parties',
  'opening-stock': 'imports.kinds.opening-stock',
};

/** Where to look at what was imported. */
const NEXT: Readonly<Record<string, { readonly to: string; readonly label: MessageKey }>> = {
  products: { to: '/products', label: 'imports.next.products' },
  parties: { to: '/parties', label: 'imports.next.parties' },
  'opening-stock': { to: '/stock', label: 'imports.next.opening-stock' },
};

const PROBLEMS: Readonly<Record<SpreadsheetProblem, MessageKey>> = {
  notSpreadsheet: 'imports.file.notSpreadsheet',
  unsupported: 'imports.file.unsupported',
  empty: 'imports.file.empty',
  tooLarge: 'imports.file.tooLarge',
  oldFormat: 'imports.file.oldFormat',
};

const ACTION_TONES: Readonly<Record<ImportAction, Tone>> = {
  create: 'success',
  update: 'info',
  unchanged: 'neutral',
};

/** The template to fill in: the kind's columns and an example row, with a BOM so Excel reads ₹. */
export function templateCsv(kind: ImportKind): string {
  return `\uFEFF${toCsv([
    kind.columns.map((column) => column.name),
    kind.columns.map((column) => column.example),
  ])}`;
}

function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

const isReport = (value: unknown): value is ImportReport =>
  typeof value === 'object' && value !== null && 'totals' in value;

/** The report a refused import (400) answers with, if any. */
function refusedReport(error: unknown): ImportReport | null {
  return error instanceof ApiError && isReport(error.body.report) ? error.body.report : null;
}

function useKindName() {
  const { t } = useI18n();
  return (kind: ImportKind) => {
    const key = KIND_NAMES[kind.kind];
    return key === undefined ? kind.title : t(key);
  };
}

/** The first rows of a list, and a note when there are more. */
function Capped({ total }: { readonly total: number }) {
  const { t } = useI18n();
  return total > SHOWN_ROWS ? (
    <p className="muted">{t('imports.preview.capped', { shown: SHOWN_ROWS, total })}</p>
  ) : null;
}

function ReportView({ report }: { readonly report: ImportReport }) {
  const { t, number } = useI18n();
  const facts: [MessageKey, number][] = [
    ['imports.preview.rows', report.totals.rows],
    ['imports.preview.create', report.totals.create],
    ['imports.preview.update', report.totals.update],
    ['imports.preview.unchanged', report.totals.unchanged],
    ['imports.preview.errors', report.totals.errors],
  ];
  return (
    <div className="stack">
      <dl className="facts" aria-label={t('imports.preview.totals')}>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd>{number(value)}</dd>
          </div>
        ))}
      </dl>
      {report.errors.length > 0 && (
        <>
          <Table label={t('imports.preview.errorList')}>
            <thead>
              <tr>
                <th scope="col" className="ui-num">
                  {t('imports.preview.row')}
                </th>
                <th scope="col">{t('imports.preview.column')}</th>
                <th scope="col">{t('imports.preview.problem')}</th>
              </tr>
            </thead>
            <tbody>
              {report.errors.slice(0, SHOWN_ROWS).map((error, index) => (
                <tr key={`${String(error.row)}-${String(index)}`}>
                  <td className="ui-num">{error.row}</td>
                  <td>{error.column ?? t('imports.preview.wholeRow')}</td>
                  <td>{error.message}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Capped total={report.errors.length} />
        </>
      )}
      {report.rows.length > 0 && (
        <>
          <Table label={t('imports.preview.planList')}>
            <thead>
              <tr>
                <th scope="col" className="ui-num">
                  {t('imports.preview.row')}
                </th>
                <th scope="col">{t('imports.preview.action')}</th>
                <th scope="col">{t('imports.preview.record')}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.slice(0, SHOWN_ROWS).map((row) => (
                <tr key={row.row}>
                  <td className="ui-num">{row.row}</td>
                  <td>
                    <Badge tone={ACTION_TONES[row.action]}>
                      {t(`imports.actions.${row.action}`)}
                    </Badge>
                  </td>
                  <td>{row.label}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Capped total={report.rows.length} />
        </>
      )}
    </div>
  );
}

interface Checked {
  readonly name: string;
  readonly csv: string;
  readonly report: ImportReport;
}

/** Choosing a file, checking it and importing it, for one kind. */
function ImportFlow({ kind }: { readonly kind: ImportKind }) {
  const api = useApi();
  const { t, plural } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const kindName = useKindName();
  const [reading, setReading] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [done, setDone] = useState<ImportReport | null>(null);
  // A new file input after "Import another file", so the same file can be chosen again.
  const [attempt, setAttempt] = useState(0);
  const next = NEXT[kind.kind];

  const choose = async (file: File | undefined) => {
    setChecked(null);
    setProblem(null);
    setMessage(null);
    if (file === undefined) return;
    setReading(file.name);
    try {
      const csv = await readSpreadsheet(file);
      const report = await api.imports.preview(kind.kind, csv);
      setChecked({ name: file.name, csv, report });
    } catch (error) {
      setProblem(
        error instanceof SpreadsheetError ? t(PROBLEMS[error.problem]) : errorMessage(error),
      );
    } finally {
      setReading(null);
    }
  };

  const commit = async (file: Checked) => {
    setCommitting(true);
    setMessage(null);
    try {
      const report = await api.imports.commit(kind.kind, file.csv);
      setDone(report);
      setChecked(null);
      toast({ title: t('imports.toast'), tone: 'success' });
      await queryClient.invalidateQueries();
    } catch (error) {
      const refused = refusedReport(error);
      if (refused === null) {
        setMessage(errorMessage(error));
      } else {
        setChecked({ ...file, report: refused });
        setMessage(t('imports.notSaved'));
      }
    } finally {
      setCommitting(false);
    }
  };

  if (done !== null) {
    return (
      <Card>
        <div className="stack">
          <Alert tone="success">
            {t('imports.committed', {
              create: done.totals.create,
              update: done.totals.update,
              unchanged: done.totals.unchanged,
            })}
          </Alert>
          <div className="row">
            {next !== undefined && (
              <Link to={next.to} {...buttonStyle()}>
                {t(next.label)}
              </Link>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setDone(null);
                setAttempt((value) => value + 1);
              }}
            >
              {t('imports.another')}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card title={t('imports.columns')}>
        <div className="stack">
          <Table label={t('imports.columnsList', { kind: kindName(kind) })}>
            <thead>
              <tr>
                <th scope="col">{t('imports.column')}</th>
                <th scope="col">{t('imports.meaning')}</th>
                <th scope="col">{t('imports.example')}</th>
              </tr>
            </thead>
            <tbody>
              {kind.columns.map((column) => (
                <tr key={column.name}>
                  <th scope="row">
                    <code>{column.name}</code>
                    <span className="cell-meta">
                      {column.required ? t('imports.required') : t('imports.optional')}
                    </span>
                  </th>
                  <td className="cell-wrap">{column.description}</td>
                  <td>{column.example}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => {
                download(`${kind.kind}-template.csv`, templateCsv(kind));
              }}
            >
              {t('imports.template')}
            </Button>
            <span className="muted">{t('imports.templateHint')}</span>
          </div>
        </div>
      </Card>

      <Card title={t('imports.preview.title')}>
        <div className="stack">
          <Field
            label={t('imports.file.label')}
            hint={t('imports.file.hint')}
            error={problem ?? undefined}
          >
            <Input
              key={attempt}
              type="file"
              className="import-file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                void choose(event.target.files?.[0]);
              }}
            />
          </Field>
          {reading !== null && <Spinner label={t('imports.file.reading', { name: reading })} />}
          {message !== null && <Alert tone="danger">{message}</Alert>}
          {checked !== null && (
            <>
              {checked.report.valid ? (
                <Alert tone="info">{t('imports.preview.valid', { name: checked.name })}</Alert>
              ) : (
                <Alert tone="warning">
                  {t('imports.preview.invalid', {
                    name: checked.name,
                    count: checked.report.totals.errors,
                  })}
                </Alert>
              )}
              <ReportView report={checked.report} />
              <div className="row row--end">
                <Button
                  disabled={!checked.report.valid}
                  loading={committing}
                  onClick={() => {
                    void commit(checked);
                  }}
                >
                  {plural('imports.commit', checked.report.totals.rows)}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
    </>
  );
}

/** /imports — products, parties or opening stock from a CSV or Excel file: check, then import. */
export function ImportsPage() {
  const api = useApi();
  const { t } = useI18n();
  const can = usePermissions();
  const kindName = useKindName();
  const filters = useUrlFilters(['kind'] as const);
  const kinds = useQuery({ queryKey: ['imports', 'kinds'], queryFn: () => api.imports.kinds() });

  return (
    <>
      <PageHeader title={t('imports.title')} description={t('imports.description')} />
      <QueryState query={kinds} error="imports.error">
        {(list) => {
          const allowed = list.filter(
            (kind) => isPermission(kind.permission) && can(kind.permission),
          );
          const [first] = allowed;
          if (first === undefined) {
            return (
              <EmptyState
                icon={<Icon name="alert" size={32} />}
                title={t('imports.noKinds')}
                description={t('imports.noKindsDescription')}
              />
            );
          }
          const chosen = allowed.find((kind) => kind.kind === filters.values.kind) ?? first;
          return (
            <div className="stack">
              <Card>
                <fieldset className="import-kinds">
                  <legend>{t('imports.kindLegend')}</legend>
                  {allowed.map((kind) => (
                    <label key={kind.kind} className="ui-checkbox">
                      <input
                        type="radio"
                        name="import-kind"
                        value={kind.kind}
                        checked={kind.kind === chosen.kind}
                        onChange={() => {
                          filters.set('kind', kind.kind);
                        }}
                      />
                      <span>{kindName(kind)}</span>
                    </label>
                  ))}
                </fieldset>
              </Card>
              <ImportFlow key={chosen.kind} kind={chosen} />
            </div>
          );
        }}
      </QueryState>
    </>
  );
}
