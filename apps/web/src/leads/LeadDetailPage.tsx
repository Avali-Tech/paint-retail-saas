import { Alert, Badge, Button, Card, PageHeader, buttonStyle, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Lead } from '../api/leads.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ActionMenu } from './ActionMenu.js';
import { LEAD_TONE, refreshCrm } from './crm.js';
import { Facts } from './Facts.js';
import { useLeadActions } from './lead-actions.js';
import { AssignDialog } from './members.js';
import { RecordActivities } from './RecordActivities.js';

function LeadView({ lead }: { readonly lead: Lead }) {
  const api = useApi();
  const { t, label, money, date, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const { actions, dialogs } = useLeadActions(lead);
  const [assigning, setAssigning] = useState(false);
  const manage = can('leads:manage');
  const open = lead.stage === 'new' || lead.stage === 'contacted' || lead.stage === 'qualified';
  return (
    <>
      <PageHeader
        title={`${lead.number} · ${lead.title}`}
        description={
          <span className="badges">
            <Badge tone={LEAD_TONE[lead.stage]}>{stageLabel(t, lead.stage)}</Badge>
            <span className="muted">
              {t('leads.detail.forParty', { party: lead.party.name, store: lead.store.name })}
            </span>
          </span>
        }
        actions={
          <span className="row">
            {manage && open && (
              <Link to={`/leads/${lead.id}/edit`} {...buttonStyle('secondary')}>
                {t('common.edit')}
              </Link>
            )}
            {manage && (open || lead.stage === 'opportunity') && (
              <Button
                variant="secondary"
                onClick={() => {
                  setAssigning(true);
                }}
              >
                {t('crm.reassign')}
              </Button>
            )}
            <ActionMenu
              label={t('leads.actions.move')}
              accessibleLabel={t('leads.actions.moveLead', { number: lead.number })}
              actions={actions}
            />
          </span>
        }
      />
      {lead.opportunityId !== null && (
        <div className="page-notice">
          <Alert
            tone="success"
            action={
              <Link to={`/opportunities/${lead.opportunityId}`}>
                {t('leads.detail.openOpportunity')}
              </Link>
            }
          >
            {t('leads.detail.converted')}
          </Alert>
        </div>
      )}
      <div className="detail-grid">
        <Card title={t('leads.detail.details')}>
          <div className="stack">
            <Facts
              facts={[
                [
                  t('leads.customer'),
                  <Link key="party" to={`/parties/${lead.party.id}`}>
                    {lead.party.name}
                  </Link>,
                ],
                [t('leads.detail.phone'), lead.party.phone],
                [t('crm.store'), `${lead.store.code} · ${lead.store.name}`],
                [t('leads.source'), label('leadSources', lead.source)],
                [t('leads.detail.referredBy'), lead.referredBy?.name ?? null],
                [
                  t('leads.form.value'),
                  lead.estimatedValuePaise === null ? null : money(lead.estimatedValuePaise),
                ],
                [
                  t('leads.form.expectedOrderDate'),
                  lead.expectedOrderDate === null ? null : date(lead.expectedOrderDate),
                ],
                [t('crm.assignedTo'), lead.assignedTo.name],
                [t('crm.created'), dateTime(lead.createdAt)],
                [t('crm.closed'), lead.closedAt === null ? null : dateTime(lead.closedAt)],
                [t('leads.detail.lostReason'), lead.lostReason],
              ]}
            />
            {lead.requirement !== null && (
              <div>
                <h3 className="subheading">{t('leads.form.requirement')}</h3>
                <p>{lead.requirement}</p>
              </div>
            )}
          </div>
        </Card>
        <RecordActivities
          recordType="lead"
          recordId={lead.id}
          storeId={lead.store.id}
          canAdd={manage}
        />
      </div>
      {dialogs}
      {assigning && (
        <AssignDialog
          title={t('crm.reassignTitle', { number: lead.number })}
          current={lead.assignedTo.memberId}
          assignment={{ for: 'lead', storeId: lead.store.id }}
          onClose={() => {
            setAssigning(false);
          }}
          onSubmit={async (memberId) => {
            await api.leads.assign(lead.id, memberId);
            await refreshCrm(queryClient);
            toast({ title: t('crm.reassigned'), tone: 'success' });
          }}
        />
      )}
    </>
  );
}

/** /leads/:id — a lead with its details, next steps and activities. */
export function LeadDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const lead = useQuery({
    queryKey: ['lead', id],
    queryFn: ({ signal }) => api.leads.get(id, signal),
  });
  return (
    <QueryState query={lead} error="leads.detail.error">
      {(data) => <LeadView lead={data} />}
    </QueryState>
  );
}
