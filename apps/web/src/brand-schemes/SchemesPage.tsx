import { SCHEME_STATUSES } from '@paint/shared';
import { Card, EmptyState, Field, Icon, PageHeader, Select, buttonStyle } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { CsvButton } from './CsvButton.js';
import { SchemeProgressBar, SchemeStatusBadge, schemesKey, useSchemeText } from './scheme-parts.js';

const FILTERS = ['status'] as const;

/**
 * /brand-schemes — each brand's schemes with how far purchases have come: a progress
 * bar to the next slab, what is left and what is needed a day, and what the brand owes.
 */
export function SchemesPage() {
  const api = useApi();
  const { t, label, date, money } = useI18n();
  const can = usePermissions();
  const { amount, nextSlab } = useSchemeText();
  const filters = useUrlFilters(FILTERS);
  const status = SCHEME_STATUSES.find((value) => value === filters.values.status);
  const schemes = useQuery({
    queryKey: [...schemesKey, { status }],
    queryFn: ({ signal }) => api.schemes.list({ status }, signal),
  });
  return (
    <>
      <PageHeader
        title={t('schemes.title')}
        description={t('schemes.description')}
        actions={
          <>
            <CsvButton kind="brand-schemes" />
            {can('schemes:manage') && (
              <Link to="/brand-schemes/new" {...buttonStyle('primary')}>
                {t('schemes.new')}
              </Link>
            )}
          </>
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('schemes.status')}>
            <Select
              value={status ?? ''}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('schemes.allStatuses')}</option>
              {SCHEME_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('schemeStatus', value)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      <QueryState query={schemes} error="schemes.error">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState icon={<Icon name="purchasing" size={32} />} title={t('schemes.none')} />
          ) : (
            <ul className="schemes__list" aria-label={t('schemes.title')}>
              {rows.map(({ scheme, progress, claim }) => (
                <li key={scheme.id}>
                  <Card>
                    <div className="stack">
                      <div className="scheme-card__head">
                        <Link to={`/brand-schemes/${scheme.id}`} className="scheme-card__name">
                          {scheme.brand.name} · {scheme.name}
                        </Link>
                        <SchemeStatusBadge status={scheme.status} />
                      </div>
                      <p className="muted">
                        {t('schemes.period', {
                          from: date(scheme.startsOn),
                          to: date(scheme.endsOn),
                        })}
                      </p>
                      <SchemeProgressBar scheme={scheme} progress={progress} />
                      <p>{nextSlab(scheme, progress)}</p>
                      <div className="scheme-figures">
                        <span>
                          <span className="muted">{t('schemes.achieved')}</span>{' '}
                          <strong>{amount(scheme.measure, progress.achieved)}</strong>
                        </span>
                        <span>
                          <span className="muted">{t('schemes.earned')}</span>{' '}
                          <strong>{money(claim.money.expectedPaise)}</strong>
                        </span>
                        <span>
                          <span className="muted">{t('schemes.outstanding')}</span>{' '}
                          <strong>{money(Math.max(claim.money.outstandingPaise, 0))}</strong>
                        </span>
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </>
  );
}
