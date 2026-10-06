import { Card, EmptyState, Icon, PageHeader, buttonStyle } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { reportText } from './report-filters.js';

export const reportsKey = ['reports'] as const;

/** The reports the member's role may run (GET /reports). */
export function useReports() {
  const api = useApi();
  return useQuery({ queryKey: reportsKey, queryFn: ({ signal }) => api.reports.list(signal) });
}

/** /reports — every report the member may run, each opening its filters, table and CSV. */
export function ReportsPage() {
  const { t } = useI18n();
  const reports = useReports();
  return (
    <>
      <PageHeader title={t('reports.title')} description={t('reports.description')} />
      <QueryState query={reports} error="reports.error">
        {(list) =>
          list.length === 0 ? (
            <Card>
              <EmptyState icon={<Icon name="dashboard" size={32} />} title={t('reports.empty')} />
            </Card>
          ) : (
            <div className="detail-grid">
              {list.map((report) => {
                const { title, description } = reportText(t, report);
                return (
                  <Card key={report.kind} title={title}>
                    <div className="stack">
                      {description !== null && <p className="muted">{description}</p>}
                      <div className="row">
                        <Link
                          to={`/reports/${report.kind}`}
                          aria-label={t('reports.open', { title })}
                          {...buttonStyle('secondary')}
                        >
                          {t('reports.openButton')}
                        </Link>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )
        }
      </QueryState>
    </>
  );
}
