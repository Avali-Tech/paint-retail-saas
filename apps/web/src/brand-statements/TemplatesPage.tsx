import { Badge, Card, EmptyState, Icon, PageHeader, Table, buttonStyle } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { statementsKey } from './StatementsPage.js';

export const templatesKey = [...statementsKey, 'templates'] as const;

/** /brand-statements/templates — how each distributor's statement is laid out. */
export function TemplatesPage() {
  const api = useApi();
  const { t, money, number } = useI18n();
  const can = usePermissions();
  const templates = useQuery({
    queryKey: templatesKey,
    queryFn: ({ signal }) => api.statements.templates(signal),
  });
  return (
    <>
      <PageHeader
        title={t('statements.templateList.title')}
        description={t('statements.templateList.description')}
        actions={
          can('schemes:manage') && (
            <Link to="/brand-statements/templates/new" {...buttonStyle('primary')}>
              {t('statements.templateList.new')}
            </Link>
          )
        }
      />
      <QueryState query={templates} error="statements.templateList.error">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState
              icon={<Icon name="purchasing" size={32} />}
              title={t('statements.templateList.none')}
            />
          ) : (
            <Card>
              <Table label={t('statements.templateList.title')}>
                <thead>
                  <tr>
                    <th scope="col">{t('statements.editor.name')}</th>
                    <th scope="col">{t('statements.templateList.supplier')}</th>
                    <th scope="col">{t('statements.templateList.brand')}</th>
                    <th scope="col">{t('statements.templateList.matching')}</th>
                    <th scope="col">{t('statements.templateList.statements')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        {can('schemes:manage') ? (
                          <Link
                            to={`/brand-statements/templates/${row.id}/edit`}
                            aria-label={t('statements.templateList.edit', { name: row.name })}
                          >
                            {row.name}
                          </Link>
                        ) : (
                          row.name
                        )}
                        {!row.isActive && (
                          <>
                            {' '}
                            <Badge>{t('statements.templateList.off')}</Badge>
                          </>
                        )}
                      </th>
                      <td>{row.supplier.name}</td>
                      <td>{row.brand?.name ?? t('statements.editor.noBrand')}</td>
                      <td>
                        {t('statements.templateList.within', {
                          days: number(row.dateWindowDays),
                          amount: money(row.amountTolerancePaise),
                        })}
                      </td>
                      <td>{number(row.statements)}</td>
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
