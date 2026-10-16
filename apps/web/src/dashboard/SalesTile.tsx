import { Badge, Card, Skeleton } from '@paint/ui';
import type { SalesOverview, SalesPeriod } from '@paint/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import '../styles/sales.css';

/**
 * The dashboard's sales tile (MVP 3 round 7b): net sales before GST today, this week and
 * this month, each against the same stretch before, with bills and the average bill, and
 * the last 14 days as bars (a table for screen readers). Only for members who read sales;
 * its own request, so the rest of the dashboard never waits. Each period opens the sales
 * report for its days.
 */
export function SalesTile({ storeId }: { readonly storeId: string | null }) {
  const can = usePermissions();
  if (!can('sales:read')) return null;
  return <Sales storeId={storeId} />;
}

function reportLink(period: SalesPeriod, storeId: string | null): string {
  const query = new URLSearchParams({ from: period.range.from, to: period.range.to });
  if (storeId !== null) query.set('storeId', storeId);
  return `/reports/sales-by-period?${query.toString()}`;
}

function Change({ period }: { readonly period: SalesPeriod }) {
  const { t, number } = useI18n();
  const previous = t(`salesTile.previous.${period.key}`);
  if (period.changeBps === null) {
    return <span className="muted">{t('salesTile.noComparison', { previous })}</span>;
  }
  const percent = number(Math.abs(period.changeBps) / 100);
  const up = period.changeBps >= 0;
  return (
    <Badge tone={up ? 'success' : 'warning'}>
      {t(up ? 'salesTile.up' : 'salesTile.down', { percent, previous })}
    </Badge>
  );
}

function Period({
  period,
  storeId,
}: {
  readonly period: SalesPeriod;
  readonly storeId: string | null;
}) {
  const { t, money, number } = useI18n();
  const { figures } = period;
  return (
    <div className="sales-tile__period">
      <h3 className="sales-tile__label">{t(`salesTile.period.${period.key}`)}</h3>
      <p className="sales-tile__value">
        <Link to={reportLink(period, storeId)}>{money(figures.taxablePaise)}</Link>
      </p>
      <p className="sales-tile__sub muted">
        {t('salesTile.withGst', { amount: money(figures.valuePaise) })}
      </p>
      <Change period={period} />
      <p className="sales-tile__sub">
        {t('salesTile.bills', { count: number(figures.bills) })}
        {figures.averageBillPaise !== null &&
          ` · ${t('salesTile.average', { amount: money(figures.averageBillPaise) })}`}
      </p>
    </div>
  );
}

function Trend({ days }: { readonly days: SalesOverview['days'] }) {
  const { t, money, date } = useI18n();
  const largest = Math.max(0, ...days.map((day) => day.taxablePaise));
  return (
    <figure className="sales-tile__trend">
      <figcaption className="sales-tile__label">{t('salesTile.trend')}</figcaption>
      <div className="sales-tile__bars" aria-hidden="true">
        {days.map((day) => (
          <span
            key={day.day}
            className="sales-tile__bar"
            title={`${date(day.day)}: ${money(day.taxablePaise)}`}
            style={{
              blockSize: `${String(largest > 0 ? Math.max(0, day.taxablePaise / largest) * 100 : 0)}%`,
            }}
          />
        ))}
      </div>
      {/* A table ignores the 1px box that hides it, so its wrapper is what is hidden. */}
      <div className="ui-visually-hidden">
        <table>
          <caption>{t('salesTile.trend')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('salesTile.day')}</th>
              <th scope="col">{t('salesTile.netSales')}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{date(day.day)}</th>
                <td>{money(day.taxablePaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function Sales({ storeId }: { readonly storeId: string | null }) {
  const api = useApi();
  const { t } = useI18n();
  const overview = useQuery({
    queryKey: ['dashboard', 'sales', storeId ?? 'all'],
    queryFn: ({ signal }) => api.dashboardSales(storeId ?? undefined, signal),
  });
  const data = overview.data;
  return (
    <Card className="tile sales-tile">
      <h2 className="tile__title">{t('salesTile.title')}</h2>
      {overview.isError ? (
        <p className="muted">{t('salesTile.error')}</p>
      ) : data === undefined ? (
        <Skeleton className="tile__skeleton" />
      ) : (
        <>
          <div className="sales-tile__periods">
            {data.periods.map((period) => (
              <Period key={period.key} period={period} storeId={storeId} />
            ))}
          </div>
          <Trend days={data.days} />
          <p className="sales-tile__sub muted">{t('salesTile.note')}</p>
          <Link to="/reports#sales">{t('salesTile.open')}</Link>
        </>
      )}
    </Card>
  );
}
