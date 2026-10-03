import {
  Badge,
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
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PARTY_ROLES } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';

export const PAGE_SIZE = 50;
export const SEARCH_DELAY_MS = 300;

const FILTERS = ['q', 'role', 'inactive'] as const;

/** Customers and every other party, searchable by name, mobile number or GSTIN. */
export function PartiesPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { role, inactive } = filters.values;
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const filtered = q !== '' || role !== '' || inactive !== '';

  const parties = useQuery({
    queryKey: ['parties', { q, role, inactive, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.parties.list(
        {
          q: q || undefined,
          // An unknown role in the address is ignored rather than sent.
          role: PARTY_ROLES.find((value) => value === role),
          includeInactive: inactive === '1',
          limit: PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('parties.title')}
        description={t('parties.description')}
        actions={
          can('parties:manage') ? (
            <Link to="/parties/new" {...buttonStyle()}>
              {t('parties.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('parties.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
          <Field label={t('parties.role')}>
            <Select
              value={role}
              onChange={(event) => {
                filters.set('role', event.target.value);
              }}
            >
              <option value="">{t('parties.allRoles')}</option>
              {PARTY_ROLES.map((value) => (
                <option key={value} value={value}>
                  {label('partyRoles', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox
            label={t('parties.includeInactive')}
            checked={inactive === '1'}
            onChange={(event) => {
              filters.set('inactive', event.target.checked ? '1' : '');
            }}
          />
        </div>
        <QueryState query={parties} error="parties.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="customers" size={32} />}
                title={filtered ? t('parties.noMatches') : t('parties.emptyTitle')}
                {...(filtered ? {} : { description: t('parties.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('parties.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('parties.name')}</th>
                      <th scope="col">{t('parties.roles')}</th>
                      <th scope="col">{t('parties.phone')}</th>
                      <th scope="col">{t('parties.city')}</th>
                      <th scope="col">{t('parties.gstin')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((party) => (
                      <tr key={party.id}>
                        <th scope="row">
                          <Link to={`/parties/${party.id}`}>{party.displayName}</Link>
                          {!party.isActive && (
                            <>
                              {' '}
                              <Badge>{t('parties.inactive')}</Badge>
                            </>
                          )}
                        </th>
                        <td>
                          <span className="badges">
                            {party.roles.map((value) => (
                              <Badge key={value} tone="primary">
                                {label('partyRoles', value)}
                              </Badge>
                            ))}
                          </span>
                        </td>
                        <td>{party.phone ?? t('common.none')}</td>
                        <td>{party.city ?? t('common.none')}</td>
                        <td>{party.gstin ?? t('common.none')}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('parties.pages')}
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
