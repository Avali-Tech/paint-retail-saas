import { Badge, Card, Checkbox, EmptyState, Icon, PageHeader, Table, buttonStyle } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { PURCHASING_SECTIONS } from '../purchasing/sections.js';

/** The query key every brand statement screen shares. */
export const statementsKey = ['brand-statements'] as const;

/**
 * /brand-statements — the statements imported, newest period first, with how many of
 * their lines do not agree with our books.
 */
export function StatementsPage() {
  const api = useApi();
  const { t, date, number } = useI18n();
  const can = usePermissions();
  const [discarded, setDiscarded] = useState(false);
  const status = discarded ? 'discarded' : 'active';
  const statements = useQuery({
    queryKey: [...statementsKey, { status }],
    queryFn: ({ signal }) => api.statements.list(status, signal),
  });
  return (
    <>
      <PageHeader
        title={t('statements.title')}
        description={t('statements.description')}
        actions={
          <>
            <Link to="/brand-statements/templates" {...buttonStyle('secondary')}>
              {t('statements.templates')}
            </Link>
            {can('schemes:manage') && (
              <Link to="/brand-statements/upload" {...buttonStyle('primary')}>
                {t('statements.upload')}
              </Link>
            )}
          </>
        }
      />
      <SectionNav label="purchasing.sections" links={PURCHASING_SECTIONS} />
      <Card>
        <Checkbox
          label={t('statements.showDiscarded')}
          checked={discarded}
          onChange={(event) => {
            setDiscarded(event.target.checked);
          }}
        />
      </Card>
      <QueryState query={statements} error="statements.error">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState icon={<Icon name="purchasing" size={32} />} title={t('statements.none')} />
          ) : (
            <Card>
              <Table label={t('statements.title')}>
                <thead>
                  <tr>
                    <th scope="col">{t('statements.table.number')}</th>
                    <th scope="col">{t('statements.table.supplier')}</th>
                    <th scope="col">{t('statements.table.period')}</th>
                    <th scope="col">{t('statements.table.lines')}</th>
                    <th scope="col">{t('statements.table.mismatches')}</th>
                    <th scope="col">{t('statements.table.uploadedBy')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <Link to={`/brand-statements/${row.id}`}>{row.number}</Link>
                      </th>
                      <td>
                        {row.supplier.name}
                        {row.brand !== null && <span className="muted"> · {row.brand.name}</span>}
                      </td>
                      <td>
                        {t('statements.period', {
                          from: date(row.periodFrom),
                          to: date(row.periodTo),
                        })}
                      </td>
                      <td>{number(row.lines)}</td>
                      <td>
                        <Badge tone={row.mismatches === 0 ? 'success' : 'warning'}>
                          {number(row.mismatches)}
                        </Badge>
                      </td>
                      <td>{row.uploadedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )
        }
      </QueryState>
    </>
  );
}
