import { Badge, Card, EmptyState, Icon, PageHeader, Table } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { CsvButton } from './CsvButton.js';
import { schemesKey } from './scheme-parts.js';

/**
 * /brand-schemes/claims — expected against received for every running or closed
 * scheme, the claims still open by age (from each scheme's due date), and the claim
 * filed with the brand.
 */
export function SchemeClaimsPage() {
  const api = useApi();
  const { t, money, number, date, label } = useI18n();
  const report = useQuery({
    queryKey: [...schemesKey, 'claims'],
    queryFn: ({ signal }) => api.schemes.claims(signal),
  });
  return (
    <>
      <PageHeader
        title={t('schemes.claims.title')}
        description={t('schemes.claims.description')}
        actions={<CsvButton kind="brand-scheme-claims" />}
      />
      <QueryState query={report} error="schemes.claims.error">
        {(data) =>
          data.rows.length === 0 ? (
            <EmptyState
              icon={<Icon name="purchasing" size={32} />}
              title={t('schemes.claims.none')}
            />
          ) : (
            <div className="stack">
              <Card title={t('schemes.claims.ageing')}>
                <Table label={t('schemes.claims.ageing')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('schemes.claims.age')}</th>
                      <th scope="col">{t('schemes.claims.open')}</th>
                      <th scope="col">{t('schemes.claims.owed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ageing.map((row) => (
                      <tr key={row.bucket}>
                        <th scope="row">{label('ageingBuckets', row.bucket)}</th>
                        <td>{number(row.claims)}</td>
                        <td>{money(row.outstandingPaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <Card title={t('schemes.claims.schemes')}>
                <Table label={t('schemes.claims.schemes')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('schemes.claims.scheme')}</th>
                      <th scope="col">{t('schemes.claims.due')}</th>
                      <th scope="col">{t('schemes.detail.expected')}</th>
                      <th scope="col">{t('schemes.detail.received')}</th>
                      <th scope="col">{t('schemes.detail.outstanding')}</th>
                      <th scope="col">{t('schemes.claims.state')}</th>
                      <th scope="col">{t('schemes.claims.filed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map(({ scheme, claim, filed }) => (
                      <tr key={scheme.id}>
                        <th scope="row">
                          <Link to={`/brand-schemes/${scheme.id}`}>
                            {scheme.brand.name} · {scheme.name}
                          </Link>
                          {scheme.status === 'closed' && (
                            <span className="muted"> · {label('schemeStatus', 'closed')}</span>
                          )}
                        </th>
                        <td>
                          {date(claim.dueOn)}
                          {claim.bucket !== null && (
                            <>
                              {' '}
                              <Badge tone={claim.daysPastDue > 0 ? 'danger' : 'neutral'}>
                                {label('ageingBuckets', claim.bucket)}
                              </Badge>
                            </>
                          )}
                        </td>
                        <td>{money(claim.money.expectedPaise)}</td>
                        <td>{money(claim.money.receivedPaise)}</td>
                        <td>{money(claim.money.outstandingPaise)}</td>
                        <td>{label('schemeClaimStatus', claim.status)}</td>
                        <td>
                          {filed === null
                            ? t('common.none')
                            : `${filed.number} · ${label('brandClaimStatus', filed.status)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          )
        }
      </QueryState>
    </>
  );
}
