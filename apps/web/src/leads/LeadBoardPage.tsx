import { Badge, Card, PageHeader, buttonStyle } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link } from 'react-router';
import { LEAD_STAGES, type Lead, type LeadStage, type StageTotal } from '../api/leads.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { ActionMenu } from './ActionMenu.js';
import { LEAD_TONE } from './crm.js';
import { useLeadActions } from './lead-actions.js';
import { AssigneeFilter } from './members.js';
import { LEAD_SECTIONS } from './nav.js';

/** Cards shown per column; the list has the rest. */
export const COLUMN_SIZE = 50;
const FILTERS = ['store', 'assignee'] as const;

function LeadCard({ lead }: { readonly lead: Lead }) {
  const { t, compactMoney } = useI18n();
  const { actions, dialogs } = useLeadActions(lead);
  return (
    <li className="board__card">
      <Link className="record-list__title" to={`/leads/${lead.id}`}>
        {lead.number} · {lead.title}
      </Link>
      <span className="record-list__meta">
        {[
          lead.party.name,
          lead.estimatedValuePaise === null ? null : compactMoney(lead.estimatedValuePaise),
          lead.assignedTo.name,
        ]
          .filter((part) => part !== null)
          .join(' · ')}
      </span>
      <ActionMenu
        size="sm"
        label={t('leads.actions.move')}
        accessibleLabel={t('leads.actions.moveLead', { number: lead.number })}
        actions={actions}
      />
      {dialogs}
    </li>
  );
}

function Column({
  stage,
  total,
  storeId,
  assignedTo,
}: {
  readonly stage: LeadStage;
  readonly total: StageTotal | undefined;
  readonly storeId: string | undefined;
  readonly assignedTo: string | undefined;
}) {
  const api = useApi();
  const { t, number, compactMoney } = useI18n();
  const headingId = useId();
  const leads = useQuery({
    queryKey: ['leads', { board: true, stage, storeId, assignedTo }],
    queryFn: ({ signal }) =>
      api.leads.list({ stage, storeId, assignedTo, limit: COLUMN_SIZE }, signal),
  });
  return (
    <section className="board__column" aria-labelledby={headingId}>
      <header className="board__header">
        <h2 id={headingId} className="board__title">
          <Badge tone={LEAD_TONE[stage]}>{stageLabel(t, stage)}</Badge>
        </h2>
        <span className="board__totals">
          {t('leads.board.totals', {
            count: number(total?.count ?? 0),
            value: compactMoney(total?.valuePaise ?? 0),
          })}
        </span>
      </header>
      <QueryState query={leads} error="leads.error">
        {(page) =>
          page.items.length === 0 ? (
            <p className="muted">{t('leads.board.empty')}</p>
          ) : (
            <>
              <ul className="board__cards">
                {page.items.map((lead) => (
                  <LeadCard key={lead.id} lead={lead} />
                ))}
              </ul>
              {page.total > page.items.length && (
                <Link to={`/leads?stage=${stage}`}>
                  {t('leads.board.more', { count: page.total - page.items.length })}
                </Link>
              )}
            </>
          )
        }
      </QueryState>
    </section>
  );
}

/** /leads/board — leads by stage, with each stage's count and value; move them from each card's menu. */
export function LeadBoardPage() {
  const api = useApi();
  const { t } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const storeId = filters.values.store || undefined;
  const assignedTo = filters.values.assignee || undefined;
  const pipeline = useQuery({
    queryKey: ['lead-pipeline', { storeId, assignedTo }],
    queryFn: ({ signal }) => api.leads.pipeline({ storeId, assignedTo }, signal),
  });
  return (
    <>
      <SectionNav label="leads.sections.label" links={LEAD_SECTIONS} />
      <PageHeader
        title={t('leads.board.title')}
        description={t('leads.board.description')}
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
          <StoreSelect
            label={t('crm.store')}
            value={filters.values.store}
            emptyLabel={t('crm.allStores')}
            onChange={(value) => {
              filters.set('store', value);
            }}
          />
          <AssigneeFilter
            value={filters.values.assignee}
            onChange={(value) => {
              filters.set('assignee', value);
            }}
          />
        </div>
        <QueryState query={pipeline} error="leads.board.error">
          {(totals) => (
            <div className="board">
              {LEAD_STAGES.map((stage) => (
                <Column
                  key={stage}
                  stage={stage}
                  total={totals.find((total) => total.stage === stage)}
                  storeId={storeId}
                  assignedTo={assignedTo}
                />
              ))}
            </div>
          )}
        </QueryState>
      </Card>
    </>
  );
}
