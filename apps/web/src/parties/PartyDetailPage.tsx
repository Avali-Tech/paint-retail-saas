import { Alert, Badge, Button, Card, PageHeader, buttonStyle } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { Party, PartyOverview } from '../api/parties.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { stageLabel, useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { CreditPanel } from '../credit/CreditPanel.js';
import { DocumentsPanel } from '../documents/DocumentsPanel.js';
import { timelinePath } from '../followups/activity-helpers.js';
import { LOYALTY_PANEL_ID, LoyaltyPanel } from '../loyalty/LoyaltyPanel.js';
import { MergeDialog } from './MergeDialog.js';
import { stateLabel } from '../lib/gst-states.js';

interface RecordItem {
  readonly id: string;
  readonly to?: string;
  readonly title: ReactNode;
  readonly meta: ReactNode;
}

/** One section of the 360: its title, a count, and the latest records. */
function Section({
  title,
  summary,
  total,
  items,
  all,
}: {
  readonly title: string;
  readonly summary?: string;
  readonly total: number;
  readonly items: readonly RecordItem[];
  /** Where all of them are listed, for when the 360 shows only the latest. */
  readonly all: string;
}) {
  const { t } = useI18n();
  return (
    <Card title={title} actions={<Badge>{String(total)}</Badge>}>
      <div className="stack">
        {summary !== undefined && <p className="muted">{summary}</p>}
        {items.length === 0 ? (
          <p className="muted">{t('parties.detail.nothing')}</p>
        ) : (
          <ul className="record-list">
            {items.map((item) => (
              <li key={item.id}>
                {item.to === undefined ? (
                  <span className="record-list__title">{item.title}</span>
                ) : (
                  <Link className="record-list__title" to={item.to}>
                    {item.title}
                  </Link>
                )}
                <span className="record-list__meta">{item.meta}</span>
              </li>
            ))}
          </ul>
        )}
        {total > items.length && (
          <p className="muted">
            <span>{t('parties.detail.latest', { shown: items.length, total })}</span>
            {' · '}
            <Link to={all}>{t('parties.detail.seeAll', { title })}</Link>
          </p>
        )}
      </div>
    </Card>
  );
}

function Contact({ party }: { readonly party: Party }) {
  const api = useApi();
  const { t, label } = useI18n();
  // Shared with the form; a member who cannot list stores just does not see the home store.
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: ({ signal }) => api.parties.stores(signal),
  });
  const homeStore = stores.data?.find((store) => store.id === party.homeStoreId);
  const address = [party.addressLine, party.city, party.state, party.pincode]
    .filter((part) => part !== null)
    .join(', ');
  const facts: [string, string | null][] = [
    [t('parties.form.legalName'), party.legalName],
    [t('parties.form.phone'), party.phone],
    [t('parties.form.alternatePhone'), party.alternatePhone],
    [t('parties.form.email'), party.email],
    [t('parties.form.contactPerson'), party.contactPerson],
    [t('parties.form.gstin'), party.gstin],
    [t('parties.form.pan'), party.pan],
    [t('parties.form.addressLine'), address === '' ? null : address],
    [
      t('parties.form.placeOfSupply'),
      party.placeOfSupply === null ? null : stateLabel(party.placeOfSupply),
    ],
    [t('parties.form.homeStore'), homeStore ? `${homeStore.code} · ${homeStore.name}` : null],
    [
      t('parties.form.customerType'),
      party.customer ? label('customerTypes', party.customer.customerType) : null,
    ],
    [
      t('parties.form.preferredContact'),
      party.customer ? label('contactMethods', party.customer.preferredContact) : null,
    ],
    [t('parties.form.tags'), party.tags.length === 0 ? null : party.tags.join(', ')],
    [t('parties.form.notes'), party.notes],
  ];
  const shown = facts.filter((fact): fact is [string, string] => fact[1] !== null);
  return (
    <Card title={t('parties.detail.contact')}>
      {shown.length === 0 ? (
        <p className="muted">{t('parties.detail.noContact')}</p>
      ) : (
        <dl className="facts">
          {shown.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function Overview({
  overview,
  focusLoyalty,
}: {
  readonly overview: PartyOverview;
  readonly focusLoyalty: boolean;
}) {
  const { t, label, money, date, dateTime } = useI18n();
  const can = usePermissions();
  const { allStores } = useCurrentProfile();
  const [merging, setMerging] = useState(false);
  const { party, leads, opportunities, projects, contracts, credit, loyalty, activities } =
    overview;
  const next = activities.nextFollowUp;
  useEffect(() => {
    if (focusLoyalty) document.getElementById(LOYALTY_PANEL_ID)?.scrollIntoView();
  }, [focusLoyalty]);
  return (
    <>
      <PageHeader
        title={party.displayName}
        description={
          <span className="badges">
            {party.roles.map((role) => (
              <Badge key={role} tone="primary">
                {label('partyRoles', role)}
              </Badge>
            ))}
            {!party.isActive && <Badge>{t('parties.inactive')}</Badge>}
          </span>
        }
        actions={
          can('sales:read') || can('parties:manage') ? (
            <span className="row">
              {/* The account: behind the permission the ledger API asks for. */}
              {can('sales:read') && (
                <Link to={`/parties/${party.id}/ledger`} {...buttonStyle('secondary')}>
                  {t('parties.ledger.open')}
                </Link>
              )}
              {can('parties:manage') && (
                <Link to={`/parties/${party.id}/edit`} {...buttonStyle('secondary')}>
                  {t('common.edit')}
                </Link>
              )}
              {/* Records can be at any store, so only members who see every store merge. */}
              {can('parties:manage') && allStores && party.mergedIntoId === null && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setMerging(true);
                  }}
                >
                  {t('parties.merge.button')}
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
      {merging && (
        <MergeDialog
          party={party}
          onClose={() => {
            setMerging(false);
          }}
        />
      )}
      {party.mergedIntoId !== null && (
        <div className="page-notice">
          <Alert
            tone="warning"
            action={
              <Link to={`/parties/${party.mergedIntoId}`}>{t('parties.detail.openMerged')}</Link>
            }
          >
            {t('parties.detail.merged')}
          </Alert>
        </div>
      )}
      <div className="detail-grid">
        <Contact party={party} />
        {credit !== null && (
          <CreditPanel partyId={party.id} credit={credit} projects={projects?.items} />
        )}
        {loyalty !== null && <LoyaltyPanel partyId={party.id} loyalty={loyalty} />}
        <Section
          title={t('parties.detail.activities')}
          {...(next === null
            ? {}
            : {
                summary: t('parties.detail.nextFollowUp', {
                  subject: next.subject,
                  due: dateTime(next.dueAt),
                }),
              })}
          total={activities.total}
          all={timelinePath({ type: 'party', id: party.id })}
          items={activities.items.map((activity) => ({
            id: activity.id,
            title: activity.subject,
            meta: `${label('activityTypes', activity.type)} · ${label('activityStatus', activity.status)} · ${activity.record.label} · ${dateTime(activity.at)}`,
          }))}
        />
        {leads !== null && (
          <Section
            title={t('parties.detail.leads')}
            summary={t('parties.detail.openLeads', { count: leads.open })}
            total={leads.total}
            all={`/leads?party=${party.id}`}
            items={leads.items.map((lead) => ({
              id: lead.id,
              to: `/leads/${lead.id}`,
              title: `${lead.number} · ${lead.title}`,
              meta: `${stageLabel(t, lead.stage)} · ${lead.storeCode}${
                lead.estimatedValuePaise === null ? '' : ` · ${money(lead.estimatedValuePaise)}`
              }`,
            }))}
          />
        )}
        {opportunities !== null && (
          <Section
            title={t('parties.detail.opportunities')}
            summary={t('parties.detail.opportunityValues', {
              open: money(opportunities.openValuePaise),
              won: money(opportunities.wonValuePaise),
            })}
            total={opportunities.total}
            all={`/opportunities?party=${party.id}`}
            items={opportunities.items.map((opportunity) => ({
              id: opportunity.id,
              to: `/opportunities/${opportunity.id}`,
              title: `${opportunity.number} · ${opportunity.title}`,
              meta: `${stageLabel(t, opportunity.stage)} · ${money(opportunity.expectedValuePaise)} · ${String(opportunity.probability)}%`,
            }))}
          />
        )}
        {projects !== null && (
          <Section
            title={t('parties.detail.projects')}
            total={projects.total}
            all={`/projects?party=${party.id}`}
            items={projects.items.map((project) => ({
              id: project.id,
              to: `/projects/${project.id}`,
              title: `${project.number} · ${project.name}`,
              meta: [
                stageLabel(t, project.stage),
                project.storeCode,
                project.city,
                // The party's part in the project: customer, contractor, painter…
                project.roles.map((role) => label('partyRoles', role)).join(', '),
              ]
                .filter((part) => part !== null && part !== '')
                .join(' · '),
            }))}
          />
        )}
        {contracts !== null && (
          <Section
            title={t('parties.detail.contracts')}
            summary={t('parties.detail.contractsSummary', {
              active: contracts.active,
              renewal: contracts.renewalDue,
            })}
            total={contracts.total}
            all={`/contracts?partyId=${party.id}`}
            items={contracts.items.map((contract) => ({
              id: contract.id,
              to: `/contracts/${contract.id}`,
              title: (
                <>
                  {contract.number} · {contract.title}
                  {contract.renewalDue && (
                    <>
                      {' '}
                      <Badge tone="warning">{t('parties.detail.renewalDue')}</Badge>
                    </>
                  )}
                </>
              ),
              meta: [
                label('contractTypes', contract.type),
                label('contractStatus', contract.status),
                `${date(contract.startDate)} – ${date(contract.endDate)}`,
                contract.valuePaise === null ? null : money(contract.valuePaise),
              ]
                .filter((part) => part !== null)
                .join(' · '),
            }))}
          />
        )}
        {/* Downloads, uploads and deletes, by the role's rights on customers. */}
        <DocumentsPanel recordType="party" recordId={party.id} />
      </div>
    </>
  );
}

/** /parties/:id — the customer 360. */
export function PartyDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  // /parties/:id/loyalty (where a loyalty search result leads) opens at the points.
  const focusLoyalty = useLocation().pathname.endsWith('/loyalty');
  const overview = useQuery({
    queryKey: ['party', id],
    queryFn: ({ signal }) => api.parties.overview(id, signal),
  });
  return (
    <QueryState query={overview} error="parties.detail.error">
      {(data) => <Overview overview={data} focusLoyalty={focusLoyalty} />}
    </QueryState>
  );
}
