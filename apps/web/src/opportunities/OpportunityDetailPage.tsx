import { Alert, Badge, Button, Card, Field, Input, PageHeader, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { OPEN_OPPORTUNITY_STAGES, type Opportunity } from '../api/leads.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { stageLabel, useI18n, type MessageKey } from '../i18n/i18n.js';
import { ActionMenu, type MenuAction } from '../leads/ActionMenu.js';
import { OPPORTUNITY_TONE, refreshCrm } from '../leads/crm.js';
import { Facts } from '../leads/Facts.js';
import { AssignDialog } from '../leads/members.js';
import { RecordActivities } from '../leads/RecordActivities.js';
import { FormDialog } from '../lib/FormDialog.js';
import { optional, parseRupees, rupeesInput } from '../lib/inputs.js';
import { wholeNumber } from '../lib/numbers.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';

type Dialog = 'edit' | 'lose' | 'assign';

function EditDialog({
  opportunity,
  onClose,
}: {
  readonly opportunity: Opportunity;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(opportunity.title);
  const [value, setValue] = useState(rupeesInput(opportunity.expectedValuePaise));
  const [probability, setProbability] = useState(String(opportunity.probability));
  const [date, setDate] = useState(opportunity.expectedOrderDate ?? '');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('opportunities.edit.title', { number: opportunity.number })}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        if (title.trim().length < 3) return t('leads.form.titleInvalid');
        const paise = parseRupees(value);
        if (paise === null || paise < 0) return t('leads.convert.valueInvalid');
        const chance = wholeNumber(0, 100, '').safeParse(probability);
        if (!chance.success) return t('leads.convert.probabilityInvalid');
        await api.opportunities.update(opportunity.id, {
          title: title.trim(),
          expectedValuePaise: paise,
          probability: chance.data,
          expectedOrderDate: optional(date),
        });
        await refreshCrm(queryClient);
        toast({ title: t('common.saved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('leads.form.title')} required>
        <Input
          maxLength={160}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </Field>
      <div className="form-grid">
        <Field label={t('leads.convert.value')} required>
          <Input
            inputMode="decimal"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </Field>
        <Field label={t('leads.convert.probability')} required>
          <Input
            inputMode="numeric"
            value={probability}
            onChange={(event) => {
              setProbability(event.target.value);
            }}
          />
        </Field>
        <Field label={t('leads.form.expectedOrderDate')}>
          <Input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function OpportunityView({ opportunity }: { readonly opportunity: Opportunity }) {
  const api = useApi();
  const { t, money, date, dateTime } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [starting, setStarting] = useState(false);
  const { stage, number } = opportunity;
  const manage = can('leads:manage');
  const open = stage === 'discovery' || stage === 'proposal' || stage === 'negotiation';
  const close = () => {
    setDialog(null);
  };

  const run = (work: () => Promise<Opportunity>, done: MessageKey) => {
    void (async () => {
      try {
        await work();
        toast({ title: t(done, { number }), tone: 'success' });
      } catch (error) {
        toast({
          title: t('leads.actions.failed'),
          description: errorMessage(error),
          tone: 'danger',
        });
      } finally {
        await refreshCrm(queryClient);
      }
    })();
  };

  const startProject = async () => {
    setStarting(true);
    try {
      const project = await api.projects.fromOpportunity(opportunity.id);
      await refreshCrm(queryClient);
      toast({
        title: t('opportunities.projectStarted', { number: project.number }),
        tone: 'success',
      });
      void navigate(`/projects/${project.id}`);
    } catch (error) {
      toast({ title: t('leads.actions.failed'), description: errorMessage(error), tone: 'danger' });
      setStarting(false);
    }
  };

  const actions: MenuAction[] =
    manage && open
      ? [
          ...OPEN_OPPORTUNITY_STAGES.filter((next) => next !== stage).map((next) => {
            const name = stageLabel(t, next);
            return {
              key: `move-${next}`,
              label: t('leads.actions.moveTo', { stage: name }),
              onSelect: () => {
                run(
                  () => api.opportunities.moveTo(opportunity.id, next),
                  'opportunities.actions.moved',
                );
              },
            };
          }),
          {
            key: 'win',
            label: t('leads.actions.win'),
            onSelect: () => {
              run(() => api.opportunities.win(opportunity.id), 'opportunities.actions.won');
            },
          },
          {
            key: 'lose',
            label: t('leads.actions.lose'),
            onSelect: () => {
              setDialog('lose');
            },
          },
        ]
      : [];

  return (
    <>
      <PageHeader
        title={`${number} · ${opportunity.title}`}
        description={
          <span className="badges">
            <Badge tone={OPPORTUNITY_TONE[stage]}>{stageLabel(t, stage)}</Badge>
            <span className="muted">
              {t('leads.detail.forParty', {
                party: opportunity.party.name,
                store: opportunity.store.name,
              })}
            </span>
          </span>
        }
        actions={
          <span className="row">
            {manage && open && (
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog('edit');
                }}
              >
                {t('common.edit')}
              </Button>
            )}
            {manage && open && (
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog('assign');
                }}
              >
                {t('crm.reassign')}
              </Button>
            )}
            {can('projects:manage') && opportunity.project === null && stage !== 'lost' && (
              <Button
                variant="secondary"
                loading={starting}
                onClick={() => {
                  void startProject();
                }}
              >
                {t('opportunities.startProject')}
              </Button>
            )}
            <ActionMenu
              label={t('leads.actions.move')}
              accessibleLabel={t('leads.actions.moveLead', { number })}
              actions={actions}
            />
          </span>
        }
      />
      {opportunity.project !== null && (
        <div className="page-notice">
          <Alert
            tone="success"
            action={
              <Link to={`/projects/${opportunity.project.id}`}>
                {t('opportunities.openProject', { number: opportunity.project.number })}
              </Link>
            }
          >
            {t('opportunities.hasProject')}
          </Alert>
        </div>
      )}
      <div className="detail-grid">
        <Card title={t('leads.detail.details')}>
          <Facts
            facts={[
              [
                t('leads.customer'),
                <Link key="party" to={`/parties/${opportunity.party.id}`}>
                  {opportunity.party.name}
                </Link>,
              ],
              [t('leads.detail.phone'), opportunity.party.phone],
              [t('crm.store'), `${opportunity.store.code} · ${opportunity.store.name}`],
              [t('leads.convert.value'), money(opportunity.expectedValuePaise)],
              [t('opportunities.probability'), `${String(opportunity.probability)}%`],
              [t('opportunities.weightedValue'), money(opportunity.weightedValuePaise)],
              [
                t('leads.form.expectedOrderDate'),
                opportunity.expectedOrderDate === null ? null : date(opportunity.expectedOrderDate),
              ],
              [t('opportunities.category'), opportunity.category?.name ?? null],
              [t('opportunities.salesperson'), opportunity.salesperson.name],
              [
                t('opportunities.fromLead'),
                opportunity.lead === null ? null : (
                  <Link key="lead" to={`/leads/${opportunity.lead.id}`}>
                    {opportunity.lead.number}
                  </Link>
                ),
              ],
              [t('crm.created'), dateTime(opportunity.createdAt)],
              [
                t('crm.closed'),
                opportunity.closedAt === null ? null : dateTime(opportunity.closedAt),
              ],
              [t('leads.detail.lostReason'), opportunity.lostReason],
            ]}
          />
        </Card>
        <RecordActivities
          recordType="opportunity"
          recordId={opportunity.id}
          storeId={opportunity.store.id}
          canAdd={manage}
        />
      </div>
      {dialog === 'edit' && <EditDialog opportunity={opportunity} onClose={close} />}
      {dialog === 'lose' && (
        <ReasonDialog
          title={t('leads.actions.loseTitle', { number })}
          description={t('opportunities.actions.loseHint')}
          submitLabel={t('leads.actions.lose')}
          onClose={close}
          onSubmit={async (reason) => {
            await api.opportunities.lose(opportunity.id, reason);
            await refreshCrm(queryClient);
            toast({ title: t('opportunities.actions.lost', { number }), tone: 'success' });
          }}
        />
      )}
      {dialog === 'assign' && (
        <AssignDialog
          title={t('crm.reassignTitle', { number })}
          current={opportunity.salesperson.memberId}
          assignment={{ for: 'opportunity', storeId: opportunity.store.id }}
          onClose={close}
          onSubmit={async (memberId) => {
            await api.opportunities.assign(opportunity.id, memberId);
            await refreshCrm(queryClient);
            toast({ title: t('crm.reassigned'), tone: 'success' });
          }}
        />
      )}
    </>
  );
}

/** /opportunities/:id — an opportunity with its value, stage, project and activities. */
export function OpportunityDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const opportunity = useQuery({
    queryKey: ['opportunity', id],
    queryFn: ({ signal }) => api.opportunities.get(id, signal),
  });
  return (
    <QueryState query={opportunity} error="opportunities.detail.error">
      {(data) => <OpportunityView opportunity={data} />}
    </QueryState>
  );
}
