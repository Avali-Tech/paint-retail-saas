import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { LEAD_SOURCES, LEAD_STAGES, type LeadSource, type LeadStage } from '../api/leads.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { LEAD_TONE } from './crm.js';
import { AssigneeFilter } from './members.js';
import { LEAD_SECTIONS } from './nav.js';
import { PAGE_SIZE, SEARCH_DELAY_MS, SearchFilter } from './SearchFilter.js';

const FILTERS = ['q', 'stage', 'source', 'store', 'assignee'] as const;

/** /leads — enquiries, filtered by stage, source, store, assignee or a search. */
export function LeadsPage() {
  const api = useApi();
  const { t, label, money, date } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { stage, source, store, assignee } = filters.values;
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const filtered = q !== '' || stage !== '' || source !== '' || store !== '' || assignee !== '';
  const leads = useQuery({
    queryKey: ['leads', { q, stage, source, store, assignee, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.leads.list(
        {
          q: q || undefined,
          stage: (stage || undefined) as LeadStage | undefined,
          source: (source || undefined) as LeadSource | undefined,
          storeId: store || undefined,
          assignedTo: assignee || undefined,
          limit: PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <SectionNav label="leads.sections.label" links={LEAD_SECTIONS} />
      <PageHeader
        title={t('leads.title')}
        description={t('leads.description')}
        actions={
          can('leads:manage') ? (
            <Link to="/leads/new" {...buttonStyle()}>
              {t('leads.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <SearchFilter
            label={t('leads.search')}
            value={filters.values.q}
            onChange={(value) => {
              filters.set('q', value);
            }}
          />
          <Field label={t('leads.stage')}>
            <Select
              value={stage}
              onChange={(event) => {
                filters.set('stage', event.target.value);
              }}
            >
              <option value="">{t('leads.allStages')}</option>
              {LEAD_STAGES.map((value) => (
                <option key={value} value={value}>
                  {stageLabel(t, value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('leads.source')}>
            <Select
              value={source}
              onChange={(event) => {
                filters.set('source', event.target.value);
              }}
            >
              <option value="">{t('leads.allSources')}</option>
              {LEAD_SOURCES.map((value) => (
                <option key={value} value={value}>
                  {label('leadSources', value)}
                </option>
              ))}
            </Select>
          </Field>
          <StoreSelect
            label={t('crm.store')}
            value={store}
            emptyLabel={t('crm.allStores')}
            onChange={(value) => {
              filters.set('store', value);
            }}
          />
          <AssigneeFilter
            value={assignee}
            onChange={(value) => {
              filters.set('assignee', value);
            }}
          />
        </div>
        <QueryState query={leads} error="leads.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="leads" size={32} />}
                title={filtered ? t('leads.noMatches') : t('leads.emptyTitle')}
                {...(filtered ? {} : { description: t('leads.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('leads.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('leads.lead')}</th>
                      <th scope="col">{t('leads.customer')}</th>
                      <th scope="col">{t('leads.stage')}</th>
                      <th scope="col">{t('leads.source')}</th>
                      <th scope="col" className="ui-num">
                        {t('leads.value')}
                      </th>
                      <th scope="col">{t('crm.assignedTo')}</th>
                      <th scope="col">{t('crm.updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((lead) => (
                      <tr key={lead.id}>
                        <th scope="row">
                          <Link to={`/leads/${lead.id}`}>{lead.number}</Link>
                          <span className="cell-meta">{lead.title}</span>
                        </th>
                        <td>
                          {lead.party.name}
                          <span className="cell-meta">
                            {[lead.party.phone, lead.store.code]
                              .filter((part) => part !== null)
                              .join(' · ')}
                          </span>
                        </td>
                        <td>
                          <Badge tone={LEAD_TONE[lead.stage]}>{stageLabel(t, lead.stage)}</Badge>
                        </td>
                        <td>{label('leadSources', lead.source)}</td>
                        <td className="ui-num">
                          {lead.estimatedValuePaise === null
                            ? t('common.none')
                            : money(lead.estimatedValuePaise)}
                        </td>
                        <td>{lead.assignedTo.name}</td>
                        <td>{date(lead.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('leads.pages')}
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
