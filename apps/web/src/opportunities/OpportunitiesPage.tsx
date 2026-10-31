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
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { OPPORTUNITY_STAGES, type OpportunityStage } from '../api/leads.js';
import { useApi } from '../app/services.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { OPPORTUNITY_TONE } from '../leads/crm.js';
import { PAGE_SIZE, SEARCH_DELAY_MS, SearchFilter } from '../leads/SearchFilter.js';
import { AssigneeFilter } from '../leads/members.js';
import { PartyFilterNote } from '../leads/PartyFilterNote.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';

const FILTERS = ['q', 'stage', 'store', 'assignee', 'party'] as const;

/** Each stage's count, value and weighted value, for the filters chosen. */
function StageStrip({
  storeId,
  assignedTo,
}: {
  readonly storeId: string | undefined;
  readonly assignedTo: string | undefined;
}) {
  const api = useApi();
  const { t, number, compactMoney } = useI18n();
  const pipeline = useQuery({
    queryKey: ['opportunity-pipeline', { storeId, assignedTo }],
    queryFn: ({ signal }) => api.opportunities.pipeline({ storeId, assignedTo }, signal),
  });
  if (pipeline.data === undefined) return null;
  return (
    <ul className="stage-strip" aria-label={t('opportunities.pipeline')}>
      {pipeline.data.map((stage) => (
        <li key={stage.stage}>
          <span className="muted">
            {stageLabel(t, stage.stage)} · {number(stage.count)}
          </span>
          <span className="stage-strip__value">{compactMoney(stage.valuePaise)}</span>
          <span className="muted">
            {t('opportunities.weighted', { value: compactMoney(stage.weightedValuePaise) })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** /opportunities — qualified business with its value, chance and expected order date. */
export function OpportunitiesPage() {
  const api = useApi();
  const { t, money, date } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const { stage, store, assignee, party } = filters.values;
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const filtered = [q, stage, store, assignee, party].some((value) => value !== '');
  const opportunities = useQuery({
    queryKey: ['opportunities', { q, stage, store, assignee, party, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.opportunities.list(
        {
          q: q || undefined,
          stage: (stage || undefined) as OpportunityStage | undefined,
          storeId: store || undefined,
          assignedTo: assignee || undefined,
          partyId: party || undefined,
          limit: PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title={t('opportunities.title')} description={t('opportunities.description')} />
      <StageStrip storeId={store || undefined} assignedTo={assignee || undefined} />
      {party !== '' && (
        <PartyFilterNote
          partyId={party}
          onClear={() => {
            filters.set('party', '');
          }}
        />
      )}
      <Card>
        <div className="filters">
          <SearchFilter
            label={t('opportunities.search')}
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
              {OPPORTUNITY_STAGES.map((value) => (
                <option key={value} value={value}>
                  {stageLabel(t, value)}
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
        <QueryState query={opportunities} error="opportunities.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="leads" size={32} />}
                title={filtered ? t('opportunities.noMatches') : t('opportunities.emptyTitle')}
                {...(filtered ? {} : { description: t('opportunities.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('opportunities.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('opportunities.opportunity')}</th>
                      <th scope="col">{t('leads.customer')}</th>
                      <th scope="col">{t('leads.stage')}</th>
                      <th scope="col" className="ui-num">
                        {t('leads.value')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('opportunities.probability')}
                      </th>
                      <th scope="col">{t('opportunities.expectedOrder')}</th>
                      <th scope="col">{t('opportunities.salesperson')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((opportunity) => (
                      <tr key={opportunity.id}>
                        <th scope="row">
                          <Link to={`/opportunities/${opportunity.id}`}>{opportunity.number}</Link>
                          <span className="cell-meta">{opportunity.title}</span>
                        </th>
                        <td>
                          {opportunity.party.name}
                          <span className="cell-meta">{opportunity.store.code}</span>
                        </td>
                        <td>
                          <Badge tone={OPPORTUNITY_TONE[opportunity.stage]}>
                            {stageLabel(t, opportunity.stage)}
                          </Badge>
                        </td>
                        <td className="ui-num">{money(opportunity.expectedValuePaise)}</td>
                        <td className="ui-num">{`${String(opportunity.probability)}%`}</td>
                        <td>
                          {opportunity.expectedOrderDate === null
                            ? t('common.none')
                            : date(opportunity.expectedOrderDate)}
                        </td>
                        <td>{opportunity.salesperson.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('opportunities.pages')}
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
