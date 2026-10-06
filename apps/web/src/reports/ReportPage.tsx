import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { ReportFilter, ReportFilters, ReportSummary, ReportValue } from '../api/reports.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { useUrlFilters, type UrlFilters } from '../lib/hooks.js';
import { dateRangeProblems } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { columnHeader, filterChoices, filterLabel, reportText } from './report-filters.js';
import { useReports } from './ReportsPage.js';

export const REPORT_PAGE_SIZE = 50;

function SupplierFilter({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const suppliers = useQuery({
    queryKey: ['suppliers', { report: true }],
    queryFn: ({ signal }) => api.purchasing.suppliers({ limit: 200 }, signal),
  });
  return (
    <Field label={label}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('reports.any')}</option>
        {(suppliers.data?.items ?? []).map((supplier) => (
          <option key={supplier.id} value={supplier.id}>
            {supplier.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** One filter's control, by the type the API gives: a store, a tick box, a date, a choice or plain text. */
function FilterControl({
  filter,
  filters,
  error,
}: {
  readonly filter: ReportFilter;
  readonly filters: UrlFilters<string>;
  readonly error: string | undefined;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const label = filterLabel(t, filter.name);
  // Every filter of the report is in the address's filters, "" when not set.
  const value = String(filters.values[filter.name]);
  const set = (next: string) => {
    filters.set(filter.name, next);
  };
  switch (filter.type) {
    case 'store':
      return (
        <StoreSelect
          label={label}
          value={value}
          onChange={set}
          emptyLabel={t('reports.filters.allStores')}
        />
      );
    case 'boolean': {
      // Left out, the API's default applies; only a change from it goes in the address.
      const fallback = filter.default === 'true';
      return (
        <Checkbox
          label={label}
          checked={value === '' ? fallback : value === 'true'}
          onChange={(event) => {
            set(event.target.checked === fallback ? '' : String(event.target.checked));
          }}
        />
      );
    }
    case 'supplier':
      return <SupplierFilter label={label} value={value} onChange={set} />;
    case 'enum':
      return (
        <Field label={label}>
          <Select
            value={value}
            onChange={(event) => {
              set(event.target.value);
            }}
          >
            <option value="">{t('reports.any')}</option>
            {filterChoices(i18n, filter).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'date':
      return (
        <Field label={label} error={error} hint={t('reports.dateHint')}>
          <Input
            type="date"
            value={value}
            onChange={(event) => {
              set(event.target.value);
            }}
          />
        </Field>
      );
    default:
      // Any kind of filter this version of the app does not know yet, as text.
      return (
        <Field label={label}>
          <Input
            value={value}
            onChange={(event) => {
              set(event.target.value);
            }}
          />
        </Field>
      );
  }
}

function Report({ report }: { readonly report: ReportSummary }) {
  const api = useApi();
  const { t, number } = useI18n();
  const toast = useToast();
  const filters = useUrlFilters(report.filters.map((filter) => filter.name));
  const [downloading, setDownloading] = useState(false);
  const { title, description } = reportText(t, report);
  const problems = dateRangeProblems(filters.values.from ?? '', filters.values.to ?? '');
  const errors: Record<string, string | undefined> = {
    from: problems.from === undefined ? undefined : t(`reports.${problems.from}`),
    to: problems.to === undefined ? undefined : t(`reports.${problems.to}`),
  };
  // Only filters with a value, and dates only once they are valid.
  const sent: ReportFilters = Object.fromEntries(
    Object.entries(filters.values).filter(
      ([name, value]) => value !== '' && errors[name] === undefined,
    ),
  );
  const page = useQuery({
    queryKey: ['report', report.kind, sent, filters.offset],
    queryFn: ({ signal }) =>
      api.reports.page(
        report.kind,
        sent,
        { limit: REPORT_PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  const download = async () => {
    setDownloading(true);
    try {
      const file = await api.reports.csv(report.kind, sent);
      saveFile(file.blob, file.fileName ?? `${report.kind}.csv`);
    } catch (error) {
      toast({ title: t('reports.csvFailed'), description: errorMessage(error), tone: 'danger' });
    } finally {
      setDownloading(false);
    }
  };

  const cell = (value: ReportValue | undefined) =>
    value === null || value === undefined
      ? t('common.none')
      : typeof value === 'number'
        ? number(value)
        : value;

  return (
    <>
      <PageHeader
        title={title}
        {...(description === null ? {} : { description })}
        actions={
          <>
            <Link to="/reports" {...buttonStyle('ghost')}>
              {t('reports.all')}
            </Link>
            <Button
              loading={downloading}
              onClick={() => {
                void download();
              }}
            >
              {t('reports.csv')}
            </Button>
          </>
        }
      />
      <Card>
        {report.filters.length > 0 && (
          <div className="filters">
            {report.filters.map((filter) => (
              <FilterControl
                key={filter.name}
                filter={filter}
                filters={filters}
                error={errors[filter.name]}
              />
            ))}
          </div>
        )}
        <QueryState query={page} error="reports.reportError">
          {(data) =>
            data.rows.length === 0 ? (
              <p className="muted">{t('reports.noRows')}</p>
            ) : (
              <>
                <Table label={title}>
                  <thead>
                    <tr>
                      {data.columns.map((column) => (
                        <th key={column.key} scope="col">
                          {columnHeader(t, column)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, index) => (
                      // Report rows have no id of their own; their order is fixed by the API.
                      <tr key={`${String(filters.offset)}-${String(index)}`}>
                        {data.columns.map((column) => (
                          <td
                            key={column.key}
                            className={typeof row[column.key] === 'number' ? 'ui-num' : undefined}
                          >
                            {cell(row[column.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={REPORT_PAGE_SIZE}
                  total={data.total}
                  onChange={filters.setOffset}
                  label={t('reports.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}

/** /reports/:kind — a report's filters, a paged table and the whole report as CSV. */
export function ReportPage() {
  const { t } = useI18n();
  const kind = String(useParams().kind);
  const reports = useReports();
  return (
    <QueryState query={reports} error="reports.error">
      {(list) => {
        const report = list.find((candidate) => candidate.kind === kind);
        return report === undefined ? (
          <Alert
            tone="warning"
            title={t('reports.reportError')}
            action={<Link to="/reports">{t('reports.all')}</Link>}
          >
            {t('reports.unknown')}
          </Alert>
        ) : (
          <Report key={kind} report={report} />
        );
      }}
    </QueryState>
  );
}
