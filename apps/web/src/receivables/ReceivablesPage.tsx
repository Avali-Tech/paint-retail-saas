import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Select,
  Table,
  useToast,
} from '@paint/ui';
import {
  AGEING_BUCKETS,
  AGEING_GROUPS,
  type AgeingGroup,
  type AgeingPage,
  type AgeingRowView,
  type AgeingTotals,
  type ReceivablesSummaryView,
} from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { useDebouncedValue, useUrlFilters, type UrlFilters } from '../lib/hooks.js';
import { isDate } from '../lib/india-time.js';
import { ListRefreshing } from '../lib/ListPager.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import '../styles/receivables.css';

export const AGEING_PAGE_SIZE = 50;
const FILTERS = ['asOf', 'storeId', 'salespersonId', 'who', 'q', 'overdueOnly', 'groupBy'] as const;
type Filters = UrlFilters<(typeof FILTERS)[number]>;

/** The group the address asks for; customers when it asks for none or an unknown one. */
export function groupOf(value: string): AgeingGroup {
  return AGEING_GROUPS.find((group) => group === value) ?? 'customer';
}

/** Basis points as a percentage: 6000 -> 60, 6667 -> 66.67. */
const percent = (bps: number) => bps / 100;

function Tile({
  title,
  value,
  children,
}: {
  readonly title: string;
  readonly value: string;
  readonly children: ReactNode;
}) {
  return (
    <Card className="tile">
      <h2 className="tile__title">{title}</h2>
      <p className="tile__value">{value}</p>
      <div className="tile__details">{children}</div>
    </Card>
  );
}

/** Total outstanding, overdue and due soon, credit used (roadmap P2-M10 dashboard). */
function SummaryTiles({ summary }: { readonly summary: ReceivablesSummaryView }) {
  const { t, plural, money, number } = useI18n();
  const { credit } = summary;
  return (
    <section className="tiles" aria-label={t('receivables.tiles.label')}>
      <Tile
        title={t('receivables.tiles.outstanding')}
        value={money(summary.totals.outstandingPaise)}
      >
        <span className="muted">{plural('receivables.tiles.customers', summary.customers)}</span>
        {summary.totals.unappliedPaise > 0 && (
          <span className="muted">
            {t('receivables.tiles.advance', { amount: money(summary.totals.unappliedPaise) })}
          </span>
        )}
      </Tile>
      <Tile title={t('receivables.tiles.overdue')} value={money(summary.overduePaise)}>
        <span className="figure">
          <span className="muted">{t('receivables.tiles.dueToday')}</span>{' '}
          <strong>{money(summary.dueTodayPaise)}</strong>
        </span>
        <span className="figure">
          <span className="muted">{t('receivables.tiles.dueThisWeek')}</span>{' '}
          <strong>{money(summary.dueThisWeekPaise)}</strong>
        </span>
      </Tile>
      <Tile
        title={t('receivables.tiles.credit')}
        value={
          credit.utilisationBps === null
            ? t('common.none')
            : `${number(percent(credit.utilisationBps))}%`
        }
      >
        <span className="muted">
          {credit.utilisationBps === null
            ? t('receivables.tiles.noLimits')
            : t('receivables.tiles.ofLimit', { limit: money(credit.limitPaise) })}
        </span>
        {credit.overLimit > 0 && (
          <Badge tone="danger">{plural('receivables.tiles.overLimit', credit.overLimit)}</Badge>
        )}
      </Tile>
    </section>
  );
}

/** Who owes most, each with the way to their ledger. */
function TopCustomers({ summary }: { readonly summary: ReceivablesSummaryView }) {
  const { t, plural, money } = useI18n();
  return (
    <Card title={t('receivables.top.title')}>
      {summary.topCustomers.length === 0 ? (
        <p className="muted">{t('receivables.top.empty')}</p>
      ) : (
        <ol className="record-list">
          {summary.topCustomers.map((customer) => (
            <li key={customer.partyId} className="record-list__row">
              <Link to={`/parties/${customer.partyId}/ledger`}>{customer.name}</Link>
              <span className="record-list__meta">
                {[
                  money(customer.netPaise),
                  customer.overduePaise > 0
                    ? t('receivables.top.overdue', { amount: money(customer.overduePaise) })
                    : null,
                  customer.maxDaysPastDue !== null && customer.maxDaysPastDue > 0
                    ? plural('receivables.top.late', customer.maxDaysPastDue)
                    : null,
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** The amounts of a row: one cell per bucket, then total, advance and balance. */
function AmountCells({ totals }: { readonly totals: AgeingTotals }) {
  const { money } = useI18n();
  return (
    <>
      {AGEING_BUCKETS.map((bucket) => (
        <td key={bucket} className="ui-num">
          {money(totals.buckets[bucket])}
        </td>
      ))}
      <td className="ui-num">{money(totals.outstandingPaise)}</td>
      <td className="ui-num">{money(totals.unappliedPaise)}</td>
      <td className="ui-num">
        <strong>{money(totals.netPaise)}</strong>
      </td>
    </>
  );
}

/** A row's name: the customer's ledger, or the way into a salesperson's or a store's customers. */
function RowName({
  row,
  group,
  filters,
}: {
  readonly row: AgeingRowView;
  readonly group: AgeingGroup;
  readonly filters: Filters;
}) {
  const { t } = useI18n();
  if (group === 'customer') {
    return <Link to={`/parties/${String(row.id)}/ledger`}>{row.name}</Link>;
  }
  const name =
    row.name ??
    (group === 'salesperson' ? t('receivables.noSalesperson') : t('receivables.noStore'));
  // Opening balances belong to no store, so there is no store to narrow to.
  if (group === 'store' && row.id === null) return <>{name}</>;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t('receivables.ageing.showCustomers', { name })}
      onClick={() => {
        filters.setMany(
          group === 'store'
            ? { storeId: String(row.id), groupBy: '' }
            : { salespersonId: row.id ?? 'none', who: name, groupBy: '' },
        );
      }}
    >
      {row.code === null ? name : `${row.code} · ${name}`}
    </Button>
  );
}

function AgeingTable({
  page,
  group,
  filters,
}: {
  readonly page: AgeingPage;
  readonly group: AgeingGroup;
  readonly filters: Filters;
}) {
  const { t, label, number, money } = useI18n();
  const customers = group === 'customer';
  return (
    <Table label={t('receivables.ageing.table', { group: label('ageingGroups', group) })}>
      <thead>
        <tr>
          <th scope="col">{t('receivables.ageing.name')}</th>
          {!customers && (
            <th scope="col" className="ui-num">
              {t('receivables.ageing.customers')}
            </th>
          )}
          {AGEING_BUCKETS.map((bucket) => (
            <th key={bucket} scope="col" className="ui-num">
              {label('ageingBuckets', bucket)}
            </th>
          ))}
          <th scope="col" className="ui-num">
            {t('receivables.ageing.total')}
          </th>
          <th scope="col" className="ui-num">
            {t('receivables.ageing.advance')}
          </th>
          <th scope="col" className="ui-num">
            {t('receivables.ageing.balance')}
          </th>
          <th scope="col" className="ui-num">
            {t('receivables.ageing.late')}
          </th>
          {customers && (
            <>
              <th scope="col" className="ui-num">
                {t('receivables.ageing.limit')}
              </th>
              <th scope="col">{t('receivables.ageing.actions')}</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {page.rows.map((row) => (
          <tr key={String(row.id)}>
            <th scope="row">
              <RowName row={row} group={group} filters={filters} />
              {row.phone !== null && <span className="cell-meta">{row.phone}</span>}
            </th>
            {!customers && <td className="ui-num">{number(row.customers)}</td>}
            <AmountCells totals={row.totals} />
            <td className="ui-num">
              {row.maxDaysPastDue === null ? '' : number(row.maxDaysPastDue)}
            </td>
            {customers && (
              <>
                <td className="ui-num">{row.limitPaise === null ? '' : money(row.limitPaise)}</td>
                <td>
                  <span className="row">
                    <Link to={`/parties/${String(row.id)}/ledger`}>
                      {t('receivables.ageing.ledger')}
                    </Link>
                    <Link to={`/parties/${String(row.id)}/statement`}>
                      {t('receivables.ageing.statement')}
                    </Link>
                  </span>
                </td>
              </>
            )}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">{t('receivables.ageing.totals')}</th>
          {!customers && <td />}
          <AmountCells totals={page.totals} />
          <td />
          {customers && (
            <>
              <td />
              <td />
            </>
          )}
        </tr>
      </tfoot>
    </Table>
  );
}

/** The CSV of the ageing on screen, through the reports framework. */
function CsvButton({
  group,
  asOf,
  storeId,
}: {
  group: AgeingGroup;
  asOf?: string;
  storeId?: string;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={() => {
        setBusy(true);
        api.receivables
          .ageingCsv({ groupBy: group, asOf, storeId })
          .then((file) => {
            saveFile(file.blob, file.fileName ?? 'receivables-ageing.csv');
          })
          .catch((error: unknown) => {
            toast({
              title: t('receivables.ageing.csvFailed'),
              description: errorMessage(error),
              tone: 'danger',
            });
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {t('receivables.ageing.csv')}
    </Button>
  );
}

/** /receivables — what customers owe, aged as of any day, by customer, salesperson or store. */
export function ReceivablesPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const { values } = filters;
  const group = groupOf(values.groupBy);
  const scope = {
    asOf: isDate(values.asOf) ? values.asOf : undefined,
    storeId: values.storeId === '' ? undefined : values.storeId,
    salespersonId: values.salespersonId === '' ? undefined : values.salespersonId,
  };
  const summary = useQuery({
    queryKey: ['receivables', 'summary', scope],
    queryFn: ({ signal }) => api.receivables.summary(scope, signal),
    placeholderData: keepPreviousData,
  });
  // The search waits for typing to pause, as the customer list's does.
  const q = useDebouncedValue(values.q.trim(), 300);
  const query = {
    ...scope,
    groupBy: group,
    q: q === '' ? undefined : q,
    overdueOnly: values.overdueOnly === 'true' ? true : undefined,
    limit: AGEING_PAGE_SIZE,
    offset: filters.offset,
  };
  const ageing = useQuery({
    queryKey: ['receivables', 'ageing', query],
    queryFn: ({ signal }) => api.receivables.ageing(query, signal),
    placeholderData: keepPreviousData,
  });
  const salesperson =
    values.salespersonId === 'none'
      ? t('receivables.noSalesperson')
      : values.who === ''
        ? label('ageingGroups', 'salesperson')
        : values.who;
  return (
    <>
      <PageHeader title={t('receivables.title')} description={t('receivables.description')} />
      <Card title={t('receivables.filters')}>
        <div className="filters">
          <Field label={t('receivables.asOf')} hint={t('receivables.asOfHint')}>
            <Input
              type="date"
              value={values.asOf}
              onChange={(event) => {
                filters.set('asOf', event.target.value);
              }}
            />
          </Field>
          <StoreSelect
            label={label('ageingGroups', 'store')}
            value={values.storeId}
            onChange={(storeId) => {
              filters.set('storeId', storeId);
            }}
            emptyLabel={t('receivables.allStores')}
          />
          {values.salespersonId !== '' && (
            <span className="row">
              <Badge tone="primary">{t('receivables.salesperson', { name: salesperson })}</Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  filters.setMany({ salespersonId: '', who: '' });
                }}
              >
                {t('receivables.clear')}
              </Button>
            </span>
          )}
        </div>
      </Card>
      <QueryState query={summary} error="receivables.error">
        {(data) => (
          <div className="receivables__overview">
            <SummaryTiles summary={data} />
            <TopCustomers summary={data} />
          </div>
        )}
      </QueryState>
      <Card
        title={t('receivables.ageing.title')}
        actions={<CsvButton group={group} asOf={scope.asOf} storeId={scope.storeId} />}
      >
        <div className="filters">
          <Field label={t('receivables.ageing.groupBy')}>
            <Select
              value={group}
              onChange={(event) => {
                filters.set('groupBy', event.target.value === 'customer' ? '' : event.target.value);
              }}
            >
              {AGEING_GROUPS.map((value) => (
                <option key={value} value={value}>
                  {label('ageingGroups', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('receivables.search')}>
            <Input
              type="search"
              value={values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Checkbox
            label={t('receivables.overdueOnly')}
            checked={values.overdueOnly === 'true'}
            onChange={(event) => {
              filters.set('overdueOnly', event.target.checked ? 'true' : '');
            }}
          />
          <ListRefreshing query={ageing} />
        </div>
        <QueryState query={ageing} error="receivables.error">
          {(page) =>
            page.rows.length === 0 ? (
              <EmptyState
                icon={<Icon name="check" size={32} />}
                title={t('receivables.ageing.empty')}
              />
            ) : (
              <>
                <AgeingTable page={page} group={group} filters={filters} />
                <AgeingPager page={page} filters={filters} />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}

function AgeingPager({ page, filters }: { readonly page: AgeingPage; readonly filters: Filters }) {
  const { t, number } = useI18n();
  return (
    <Pagination
      offset={filters.offset}
      limit={AGEING_PAGE_SIZE}
      total={page.total}
      onChange={(offset) => {
        filters.setOffset(offset);
      }}
      label={t('receivables.ageing.pages')}
      range={(from, to, all) =>
        t('common.range', { from: number(from), to: number(to), total: number(all) })
      }
      previousLabel={t('common.previous')}
      nextLabel={t('common.next')}
    />
  );
}
