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
  Select,
  Table,
  useToast,
} from '@paint/ui';
import {
  PROFITABILITY_GROUPS,
  PROFITABILITY_SETTINGS_PERMISSION,
  currentQuarter,
  type BrandProfitabilityRow,
  type BrandProfitabilityView,
  type MarginFigures,
  type ProfitabilityGroup,
  type ProfitabilitySliceView,
} from '@paint/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { useUrlFilters } from '../lib/hooks.js';
import { isDate, todayInIndia } from '../lib/india-time.js';
import { ListRefreshing } from '../lib/ListPager.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import type { ProfitabilityFilters } from './profitability-api.js';
import { costOfMoneyBps, hundredths } from './profitability-input.js';
import { SettingsDialog } from './SettingsDialog.js';
import '../styles/brand-profitability.css';

const FILTERS = [
  'period',
  'from',
  'to',
  'storeId',
  'groupBy',
  'brandId',
  'brand',
  'costOfMoney',
] as const;

export const PERIODS = ['lastQuarter', 'thisQuarter', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

/** The period the address asks for; the last quarter when it asks for none or an unknown one. */
export function periodOf(value: string): Period {
  return PERIODS.find((period) => period === value) ?? 'lastQuarter';
}

/** The split the address asks for; brand only when it asks for none or an unknown one. */
export function groupOf(value: string): ProfitabilityGroup {
  return PROFITABILITY_GROUPS.find((group) => group === value) ?? 'brand';
}

/** The days to ask for: none for the last quarter (the API's default). */
export function periodDays(
  period: Period,
  from: string,
  to: string,
  today: string,
): { from?: string; to?: string } {
  if (period === 'thisQuarter') return currentQuarter(today);
  if (period === 'custom' && isDate(from) && isDate(to) && from <= to) return { from, to };
  return {};
}

const marginText = (i18n: I18n, bps: number | null) =>
  bps === null ? i18n.t('common.none') : `${i18n.number(bps / 100)}%`;

/** The figures of a brand or slice, one cell each. */
function FigureCells({ figures }: { readonly figures: MarginFigures }) {
  const i18n = useI18n();
  const { money } = i18n;
  return (
    <>
      <td className="ui-num">{money(figures.netSalesPaise)}</td>
      <td className="ui-num">{money(figures.costPaise)}</td>
      <td className="ui-num">{money(figures.grossMarginPaise)}</td>
      <td className="ui-num">{money(figures.schemeReceivedPaise + figures.schemeExpectedPaise)}</td>
      <td className="ui-num">{money(figures.creditCostPaise)}</td>
      <td className="ui-num">{money(figures.loyaltyPaise + figures.painterPointsPaise)}</td>
      <td className="ui-num">
        <strong>{money(figures.contributionPaise)}</strong>
      </td>
      <td className="ui-num">{marginText(i18n, figures.marginBps)}</td>
    </>
  );
}

function sliceName(t: I18n['t'], slice: ProfitabilitySliceView): string {
  if (slice.productName !== null) return slice.productName;
  if (slice.storeCode !== null) return `${slice.storeCode} · ${String(slice.storeName)}`;
  return t('brandProfitability.noProduct');
}

/** A bar as long as the brand's share of the largest contribution, drawn left of zero when a loss. */
function Bar({ value, largest }: { readonly value: number; readonly largest: number }) {
  const share = largest === 0 ? 0 : (Math.abs(value) / largest) * 100;
  return (
    <span className="profit__track" aria-hidden="true">
      <span
        className="profit__bar"
        data-loss={value < 0 ? 'true' : undefined}
        style={{ inlineSize: `${String(share)}%` }}
      />
    </span>
  );
}

function BrandRows({
  row,
  largest,
  onSplit,
}: {
  readonly row: BrandProfitabilityRow;
  readonly largest: number;
  readonly onSplit: (() => void) | null;
}) {
  const { t } = useI18n();
  return (
    <>
      <tr className="profit__brand">
        <th scope="row">
          {onSplit === null ? (
            row.brandName
          ) : (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('brandProfitability.split', { name: row.brandName })}
              onClick={onSplit}
            >
              {row.brandName}
            </Button>
          )}
          <Bar value={row.figures.contributionPaise} largest={largest} />
        </th>
        <FigureCells figures={row.figures} />
      </tr>
      {row.slices.map((slice) => (
        <tr key={`${String(slice.productId)}:${String(slice.storeId)}`} className="profit__slice">
          <th scope="row">{sliceName(t, slice)}</th>
          <FigureCells figures={slice} />
        </tr>
      ))}
    </>
  );
}

function ProfitTable({
  view,
  onSplit,
}: {
  readonly view: BrandProfitabilityView;
  readonly onSplit: ((row: BrandProfitabilityRow) => void) | null;
}) {
  const { t } = useI18n();
  const largest = Math.max(...view.brands.map((row) => Math.abs(row.figures.contributionPaise)));
  const column = (key: keyof typeof headers) => (
    <th scope="col" className="ui-num">
      {headers[key]}
    </th>
  );
  const headers = {
    netSales: t('brandProfitability.columns.netSales'),
    cost: t('brandProfitability.columns.cost'),
    grossMargin: t('brandProfitability.columns.grossMargin'),
    schemes: t('brandProfitability.columns.schemes'),
    creditCost: t('brandProfitability.columns.creditCost'),
    points: t('brandProfitability.columns.points'),
    contribution: t('brandProfitability.columns.contribution'),
    margin: t('brandProfitability.columns.margin'),
  };
  return (
    <Table label={t('brandProfitability.table')}>
      <thead>
        <tr>
          <th scope="col">{t('brandProfitability.columns.brand')}</th>
          {column('netSales')}
          {column('cost')}
          {column('grossMargin')}
          {column('schemes')}
          {column('creditCost')}
          {column('points')}
          {column('contribution')}
          {column('margin')}
        </tr>
      </thead>
      <tbody>
        {view.brands.map((row) => (
          <BrandRows
            key={row.brandId}
            row={row}
            largest={largest}
            onSplit={
              onSplit === null
                ? null
                : () => {
                    onSplit(row);
                  }
            }
          />
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">{t('brandProfitability.total')}</th>
          <FigureCells figures={view.total} />
        </tr>
      </tfoot>
    </Table>
  );
}

/** "Which brand made the most money" for the period: the answer first (spec §7 demo). */
function Headline({ view }: { readonly view: BrandProfitabilityView }) {
  const i18n = useI18n();
  const { t, money, date } = i18n;
  const [top] = view.brands;
  return (
    <section className="profit__headline" aria-label={t('brandProfitability.headline.label')}>
      <p className="muted">
        {t('brandProfitability.periodRange', { from: date(view.from), to: date(view.to) })}
      </p>
      {top === undefined ? (
        <EmptyState
          icon={<Icon name="dashboard" size={32} />}
          title={t('brandProfitability.headline.none')}
          description={t('brandProfitability.headline.noneHint')}
        />
      ) : (
        <>
          <h2 className="profit__winner">
            {t('brandProfitability.headline.winner', { brand: top.brandName })}
          </h2>
          <p>
            {t('brandProfitability.headline.figures', {
              contribution: money(top.figures.contributionPaise),
              margin: marginText(i18n, top.figures.marginBps),
            })}
          </p>
        </>
      )}
    </section>
  );
}

function Explanation() {
  const { t } = useI18n();
  const terms = [
    'netSales',
    'cost',
    'schemes',
    'creditCost',
    'points',
    'contribution',
    'margin',
  ] as const;
  return (
    <Card title={t('brandProfitability.explain.title')}>
      <dl className="profit__terms">
        {terms.map((term) => (
          <div key={term}>
            <dt>{t(`brandProfitability.columns.${term}`)}</dt>
            <dd>{t(`brandProfitability.explain.${term}`)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function CsvButton({ filters }: { readonly filters: ProfitabilityFilters }) {
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
        api.brandProfitability
          .csv(filters)
          .then((file) => {
            saveFile(file.blob, file.fileName ?? 'brand-profitability.csv');
          })
          .catch((error: unknown) => {
            toast({
              title: t('brandProfitability.csvFailed'),
              description: errorMessage(error),
              tone: 'danger',
            });
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {t('brandProfitability.csv')}
    </Button>
  );
}

/** /reports/brand-profitability — which brand, product and store made the business money. */
export function BrandProfitabilityPage() {
  const api = useApi();
  const { t, plural, label } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const { values } = filters;
  const period = periodOf(values.period);
  const group = groupOf(values.groupBy);
  const query: ProfitabilityFilters = {
    ...periodDays(period, values.from, values.to, todayInIndia()),
    storeId: values.storeId === '' ? undefined : values.storeId,
    brandId: values.brandId === '' ? undefined : values.brandId,
    groupBy: group === 'brand' ? undefined : group,
    costOfMoneyBps: costOfMoneyBps(values.costOfMoney),
  };
  const view = useQuery({
    queryKey: ['brand-profitability', query],
    queryFn: ({ signal }) => api.brandProfitability.view(query, signal),
    placeholderData: keepPreviousData,
  });
  const can = usePermissions();
  const settings = view.data?.settings;
  return (
    <>
      <PageHeader
        title={t('brandProfitability.title')}
        description={t('brandProfitability.description')}
        actions={
          settings !== undefined && can(PROFITABILITY_SETTINGS_PERMISSION) ? (
            <SettingsDialog settings={settings} />
          ) : undefined
        }
      />
      <Card title={t('brandProfitability.filters')} actions={<CsvButton filters={query} />}>
        <div className="filters">
          <Field label={t('brandProfitability.period')}>
            <Select
              value={period}
              onChange={(event) => {
                filters.set(
                  'period',
                  event.target.value === 'lastQuarter' ? '' : event.target.value,
                );
              }}
            >
              {PERIODS.map((value) => (
                <option key={value} value={value}>
                  {label('profitabilityPeriods', value)}
                </option>
              ))}
            </Select>
          </Field>
          {period === 'custom' && (
            <>
              <Field label={t('brandProfitability.from')}>
                <Input
                  type="date"
                  value={values.from}
                  onChange={(event) => {
                    filters.set('from', event.target.value);
                  }}
                />
              </Field>
              <Field label={t('brandProfitability.to')}>
                <Input
                  type="date"
                  value={values.to}
                  onChange={(event) => {
                    filters.set('to', event.target.value);
                  }}
                />
              </Field>
            </>
          )}
          <StoreSelect
            label={label('profitabilityGroups', 'store')}
            value={values.storeId}
            onChange={(storeId) => {
              filters.set('storeId', storeId);
            }}
            emptyLabel={t('brandProfitability.allStores')}
          />
          <Field label={t('brandProfitability.splitBy')}>
            <Select
              value={group}
              onChange={(event) => {
                filters.set('groupBy', event.target.value === 'brand' ? '' : event.target.value);
              }}
            >
              {PROFITABILITY_GROUPS.map((value) => (
                <option key={value} value={value}>
                  {label('profitabilityGroups', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('brandProfitability.costOfMoney')}
            hint={t('brandProfitability.costOfMoneyHint')}
          >
            <Input
              inputMode="decimal"
              value={values.costOfMoney}
              placeholder={settings === undefined ? '' : hundredths(settings.costOfMoneyBps)}
              onChange={(event) => {
                filters.set('costOfMoney', event.target.value);
              }}
            />
          </Field>
          {values.brandId !== '' && (
            <span className="row">
              <Badge tone="primary">
                {t('brandProfitability.brandFilter', { name: values.brand })}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  filters.setMany({ brandId: '', brand: '', groupBy: '' });
                }}
              >
                {t('brandProfitability.allBrands')}
              </Button>
            </span>
          )}
          <ListRefreshing query={view} />
        </div>
      </Card>
      <QueryState query={view} error="brandProfitability.error">
        {(data) => (
          <div className="profit">
            <Card>
              <Headline view={data} />
            </Card>
            {!data.schemesCounted && (
              <Alert tone="info">{t('brandProfitability.schemesNotCounted')}</Alert>
            )}
            {data.uncostedLines > 0 && (
              <Alert tone="warning">
                {plural('brandProfitability.uncosted', data.uncostedLines)}
              </Alert>
            )}
            {data.brands.length > 0 && (
              <Card title={t('brandProfitability.table')}>
                <ProfitTable
                  view={data}
                  onSplit={
                    values.brandId === ''
                      ? (row) => {
                          filters.setMany({
                            brandId: row.brandId,
                            brand: row.brandName,
                            groupBy: 'product',
                          });
                        }
                      : null
                  }
                />
              </Card>
            )}
            <Explanation />
          </div>
        )}
      </QueryState>
    </>
  );
}
