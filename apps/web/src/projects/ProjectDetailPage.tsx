import { Badge, Button, Card, PageHeader, buttonStyle, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { DocumentsPanel } from '../documents/DocumentsPanel.js';
import { WORK_STAGES, type Project } from '../api/projects.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { ActionMenu, type MenuAction } from '../leads/ActionMenu.js';
import { PROJECT_TONE, refreshCrm } from '../leads/crm.js';
import { Facts } from '../leads/Facts.js';
import { AssignDialog } from '../leads/members.js';
import { RecordActivities } from '../leads/RecordActivities.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { ProjectPeople } from './ProjectPeople.js';

/** "Plot 12, Jubilee Hills, Hyderabad, Telangana 500033"; null without an address. */
export function siteAddress(site: Project['site']): string | null {
  const place = [site.state, site.pincode].filter((part) => part !== null).join(' ');
  const parts = [site.addressLine, site.city, place === '' ? null : place].filter(
    (part) => part !== null,
  );
  return parts.length === 0 ? null : parts.join(', ');
}

function ProjectView({ project }: { readonly project: Project }) {
  const api = useApi();
  const { t, number, money, date, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const [dialog, setDialog] = useState<'cancel' | 'assign' | null>(null);
  const manage = can('projects:manage');
  const open = project.stage !== 'completed' && project.stage !== 'cancelled';
  const changeable = manage && open;
  const { site } = project;
  const close = () => {
    setDialog(null);
  };

  const moveTo = (stage: (typeof WORK_STAGES)[number]) => {
    void (async () => {
      try {
        await api.projects.moveTo(project.id, stage);
        toast({
          title: t('projects.actions.moved', {
            number: project.number,
            stage: stageLabel(t, stage),
          }),
          tone: 'success',
        });
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

  const actions: MenuAction[] = changeable
    ? [
        ...WORK_STAGES.filter((stage) => stage !== project.stage).map((stage) => ({
          key: `move-${stage}`,
          label: t('leads.actions.moveTo', { stage: stageLabel(t, stage) }),
          onSelect: () => {
            moveTo(stage);
          },
        })),
        {
          key: 'cancel',
          label: t('projects.actions.cancel'),
          onSelect: () => {
            setDialog('cancel');
          },
        },
      ]
    : [];

  const mapLink =
    site.latitude === null || site.longitude === null
      ? null
      : `https://www.google.com/maps?q=${String(site.latitude)},${String(site.longitude)}`;

  return (
    <>
      <PageHeader
        title={`${project.number} · ${project.name}`}
        description={
          <span className="badges">
            <Badge tone={PROJECT_TONE[project.stage]}>{stageLabel(t, project.stage)}</Badge>
            <span className="muted">
              {t('leads.detail.forParty', {
                party: project.customer.name,
                store: project.store.name,
              })}
            </span>
          </span>
        }
        actions={
          <span className="row">
            {changeable && (
              <Link to={`/projects/${project.id}/edit`} {...buttonStyle('secondary')}>
                {t('common.edit')}
              </Link>
            )}
            {changeable && (
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog('assign');
                }}
              >
                {t('crm.reassign')}
              </Button>
            )}
            <ActionMenu
              label={t('projects.actions.stage')}
              accessibleLabel={t('projects.actions.stageOf', { number: project.number })}
              actions={actions}
            />
          </span>
        }
      />
      <div className="detail-grid">
        <Card title={t('projects.detail.site')}>
          <div className="stack">
            <Facts
              facts={[
                [t('projects.detail.address'), siteAddress(site)],
                [
                  t('projects.detail.map'),
                  mapLink === null ? null : (
                    <a key="map" href={mapLink} target="_blank" rel="noreferrer">
                      {t('projects.detail.openMap')}
                    </a>
                  ),
                ],
                [t('crm.store'), `${project.store.code} · ${project.store.name}`],
                [t('crm.assignedTo'), project.assignedTo.name],
              ]}
            />
            {siteAddress(site) === null && <p className="muted">{t('projects.detail.noSite')}</p>}
          </div>
        </Card>
        <Card title={t('projects.detail.job')}>
          <Facts
            facts={[
              [
                t('projects.form.startDate'),
                project.startDate === null ? null : date(project.startDate),
              ],
              [
                t('projects.form.expectedCompletionDate'),
                project.expectedCompletionDate === null
                  ? null
                  : date(project.expectedCompletionDate),
              ],
              [
                t('projects.form.area'),
                project.estimatedAreaSqFt === null ? null : number(project.estimatedAreaSqFt),
              ],
              [
                t('projects.form.litres'),
                project.estimatedPaintLitres === null ? null : number(project.estimatedPaintLitres),
              ],
              [
                t('projects.form.value'),
                project.expectedOrderValuePaise === null
                  ? null
                  : money(project.expectedOrderValuePaise),
              ],
              [
                t('projects.detail.opportunity'),
                project.opportunity === null ? null : (
                  <Link key="opportunity" to={`/opportunities/${project.opportunity.id}`}>
                    {project.opportunity.number}
                  </Link>
                ),
              ],
              [t('crm.created'), dateTime(project.createdAt)],
              [t('crm.closed'), project.closedAt === null ? null : dateTime(project.closedAt)],
              [t('projects.detail.cancelReason'), project.cancelReason],
              [t('projects.form.notes'), project.notes],
            ]}
          />
        </Card>
        <ProjectPeople project={project} canChange={changeable} />
        <RecordActivities
          recordType="project"
          recordId={project.id}
          storeId={project.store.id}
          canAdd={manage}
        />
        {/* Site photos before and after the job, quotations and the like. */}
        <DocumentsPanel recordType="project" recordId={project.id} defaultCategory="before_photo" />
      </div>
      {dialog === 'cancel' && (
        <ReasonDialog
          title={t('projects.actions.cancelTitle', { number: project.number })}
          submitLabel={t('projects.actions.cancel')}
          onClose={close}
          onSubmit={async (reason) => {
            await api.projects.cancel(project.id, reason);
            await refreshCrm(queryClient);
            toast({
              title: t('projects.actions.cancelled', { number: project.number }),
              tone: 'success',
            });
          }}
        />
      )}
      {dialog === 'assign' && (
        <AssignDialog
          title={t('crm.reassignTitle', { number: project.number })}
          current={project.assignedTo.memberId}
          assignment={{ for: 'project', storeId: project.store.id }}
          onClose={close}
          onSubmit={async (memberId) => {
            await api.projects.assign(project.id, memberId);
            await refreshCrm(queryClient);
            toast({ title: t('crm.reassigned'), tone: 'success' });
          }}
        />
      )}
    </>
  );
}

/** /projects/:id — a site with its stage, people, linked opportunity and activities. */
export function ProjectDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: ({ signal }) => api.projects.get(id, signal),
  });
  return (
    <QueryState query={project} error="projects.detail.error">
      {(data) => <ProjectView project={data} />}
    </QueryState>
  );
}
