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
import { PROJECT_STAGES, type ProjectStage } from '../api/projects.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { PROJECT_TONE } from '../leads/crm.js';
import { AssigneeFilter } from '../leads/members.js';
import { PAGE_SIZE, SEARCH_DELAY_MS, SearchFilter } from '../leads/SearchFilter.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';

const FILTERS = ['q', 'stage', 'store', 'assignee'] as const;

/** /projects — painting jobs at sites, by stage, store, assignee or a search. */
export function ProjectsPage() {
  const api = useApi();
  const { t, money, date } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { stage, store, assignee } = filters.values;
  const q = useDebouncedValue(filters.values.q.trim(), SEARCH_DELAY_MS);
  const filtered = q !== '' || stage !== '' || store !== '' || assignee !== '';
  const projects = useQuery({
    queryKey: ['projects', { q, stage, store, assignee, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.projects.list(
        {
          q: q || undefined,
          stage: (stage || undefined) as ProjectStage | undefined,
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
      <PageHeader
        title={t('projects.title')}
        description={t('projects.description')}
        actions={
          can('projects:manage') ? (
            <Link to="/projects/new" {...buttonStyle()}>
              {t('projects.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <SearchFilter
            label={t('projects.search')}
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
              {PROJECT_STAGES.map((value) => (
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
        <QueryState query={projects} error="projects.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="projects" size={32} />}
                title={filtered ? t('projects.noMatches') : t('projects.emptyTitle')}
                {...(filtered ? {} : { description: t('projects.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('projects.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('projects.project')}</th>
                      <th scope="col">{t('projects.customer')}</th>
                      <th scope="col">{t('projects.city')}</th>
                      <th scope="col">{t('leads.stage')}</th>
                      <th scope="col" className="ui-num">
                        {t('projects.value')}
                      </th>
                      <th scope="col">{t('crm.assignedTo')}</th>
                      <th scope="col">{t('crm.updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((project) => (
                      <tr key={project.id}>
                        <th scope="row">
                          <Link to={`/projects/${project.id}`}>{project.number}</Link>
                          <span className="cell-meta">{project.name}</span>
                        </th>
                        <td>
                          {project.customer.name}
                          <span className="cell-meta">{project.store.code}</span>
                        </td>
                        <td>{project.city ?? t('common.none')}</td>
                        <td>
                          <Badge tone={PROJECT_TONE[project.stage]}>
                            {stageLabel(t, project.stage)}
                          </Badge>
                        </td>
                        <td className="ui-num">
                          {project.expectedOrderValuePaise === null
                            ? t('common.none')
                            : money(project.expectedOrderValuePaise)}
                        </td>
                        <td>{project.assignedTo.name}</td>
                        <td>{date(project.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('projects.pages')}
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
