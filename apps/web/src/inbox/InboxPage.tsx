import {
  INBOX_KINDS,
  type InboxGroup,
  type InboxItem,
  type InboxKind,
  type InboxStep,
} from '@paint/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Select,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { AcknowledgeDialog } from '../collections/AcknowledgeDialog.js';
import { ApprovalDecision } from '../credit/approval-parts.js';
import { RequestDecision } from '../credit/RequestDecision.js';
import type { ActivityRecordType } from '../api/follow-ups.js';
import { refreshActivities } from '../followups/activity-helpers.js';
import { DoneDialog } from '../followups/FollowUpDialogs.js';
import { AssignDialog } from '../leads/members.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { errorMessage } from '../api/errors.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { refreshInventory } from '../lib/refresh.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { inboxKey } from './inbox-count.js';

const FILTERS = ['kind', 'store'] as const;

/** Each kind's own screen, for "See all". */
export const KIND_PATHS: Readonly<Record<InboxKind, string>> = {
  credit_approval: '/credit/approvals',
  credit_request: '/credit-requests',
  transfer: '/transfers',
  stock_count: '/stock-counts',
  escalation: '/collections',
  follow_up: '/follow-ups',
  team_follow_up: '/follow-ups?assignedTo=everyone',
  low_stock: '/stock/low',
};

/** What opening an item without an inline action leads to. */
const OPEN_LABEL: Partial<Record<InboxStep, MessageKey>> = {
  dispatch_transfer: 'inbox.open.dispatch',
  receive_transfer: 'inbox.open.receive',
  approve_count: 'inbox.open.review',
  out_of_stock: 'inbox.open.reorder',
  below_minimum: 'inbox.open.reorder',
  reorder: 'inbox.open.reorder',
};

/** Approve (in full) or reject a transfer the member's store is asked to send. */
function TransferDecision({ item }: { readonly item: InboxItem }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const number = String(item.reference);
  return (
    <>
      <Button
        size="sm"
        loading={busy}
        aria-label={t('inbox.approveTransfer', { number })}
        onClick={() => {
          setBusy(true);
          api.transfers
            .approve(item.id)
            .then(async () => {
              await refreshInventory(queryClient);
              toast({ title: t('transfers.detail.approveDone'), tone: 'success' });
            })
            .catch((error: unknown) => {
              toast({ title: errorMessage(error), tone: 'danger' });
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {t('inbox.approve')}
      </Button>
      <Button
        size="sm"
        variant="danger"
        aria-label={t('inbox.rejectTransfer', { number })}
        onClick={() => {
          setRejecting(true);
        }}
      >
        {t('inbox.reject')}
      </Button>
      {rejecting && (
        <ReasonDialog
          title={t('transfers.detail.rejectTitle', { number })}
          submitLabel={t('transfers.detail.reject')}
          onClose={() => {
            setRejecting(false);
          }}
          onSubmit={async (reason) => {
            await api.transfers.reject(item.id, reason);
            await refreshInventory(queryClient);
            toast({ title: t('transfers.detail.rejected'), tone: 'success' });
          }}
        />
      )}
    </>
  );
}

/** A team member's late follow-up: hand it to someone else, or open its record. */
function TeamFollowUpActions({ item }: { readonly item: InboxItem }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reassigning, setReassigning] = useState(false);
  const { assignee, record } = item;
  return (
    <>
      {item.actions.some((action) => action.key === 'reassign') &&
        assignee !== null &&
        record !== null && (
          <>
            <Button
              size="sm"
              variant="secondary"
              aria-label={t('inbox.reassignName', { name: item.title })}
              onClick={() => {
                setReassigning(true);
              }}
            >
              {t('inbox.reassign')}
            </Button>
            {reassigning && (
              <AssignDialog
                title={t('inbox.reassignTitle', { name: item.title })}
                current={assignee.memberId}
                assignment={{ for: 'activity', recordType: record.type as ActivityRecordType }}
                onClose={() => {
                  setReassigning(false);
                }}
                onSubmit={async (memberId) => {
                  await api.followUps.update(item.id, { assignedMemberId: memberId });
                  await refreshActivities(queryClient);
                  toast({ title: t('inbox.reassigned'), tone: 'success' });
                }}
              />
            )}
          </>
        )}
      <Link
        to={item.link}
        {...buttonStyle('secondary', 'sm')}
        aria-label={`${t('inbox.open.open')}: ${item.title}`}
      >
        {t('inbox.open.open')}
      </Link>
    </>
  );
}

/** The buttons of an item: its inline actions, else a link to where it is done. */
function ItemActions({ item }: { readonly item: InboxItem }) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState(false);
  const close = () => {
    setDialog(false);
  };
  const keys = new Set(item.actions.map((action) => action.key));
  if (item.kind === 'team_follow_up') return <TeamFollowUpActions item={item} />;
  if (item.kind === 'credit_approval' && keys.has('approve')) {
    return (
      <ApprovalDecision
        approval={{
          id: item.id,
          number: String(item.reference),
          kind: item.step === 'approve_release' ? 'release' : 'sale',
        }}
      />
    );
  }
  if (item.kind === 'credit_request' && keys.has('approve')) {
    return <RequestDecision request={{ id: item.id, number: String(item.reference) }} />;
  }
  if (item.kind === 'transfer' && keys.has('approve')) {
    return <TransferDecision item={item} />;
  }
  if (keys.has('acknowledge') || keys.has('complete')) {
    const acknowledging = keys.has('acknowledge');
    return (
      <>
        <Button
          size="sm"
          aria-label={t(acknowledging ? 'inbox.acknowledgeName' : 'inbox.doneName', {
            name: item.title,
          })}
          onClick={() => {
            setDialog(true);
          }}
        >
          {t(acknowledging ? 'inbox.acknowledge' : 'inbox.done')}
        </Button>
        {dialog &&
          (acknowledging ? (
            <AcknowledgeDialog escalationId={item.id} onClose={close} />
          ) : (
            <DoneDialog followUp={{ id: item.id, subject: item.title }} onClose={close} />
          ))}
      </>
    );
  }
  const open = OPEN_LABEL[item.step];
  return open === undefined ? null : (
    <Link
      to={item.link}
      {...buttonStyle('secondary', 'sm')}
      aria-label={`${t(open)}: ${item.reference ?? item.title}`}
    >
      {t(open)}
    </Link>
  );
}

function ItemRow({ item }: { readonly item: InboxItem }) {
  const { t, label, money, number, date, dateTime, relativeTime } = useI18n();
  const facts = [
    label('inboxSteps', item.step),
    item.reference,
    item.store?.name ?? null,
    item.amountPaise === null ? null : money(item.amountPaise),
    item.quantity === null
      ? null
      : t('inbox.quantity', {
          available: number(item.quantity.available),
          level: number(item.quantity.reorderLevel),
          unit: label('units', item.quantity.unit),
        }),
  ].filter((fact): fact is string => fact !== null);
  const when = [
    item.requestedBy === null ? null : t('inbox.by', { name: item.requestedBy }),
    item.assignee === null ? null : t('inbox.assignedTo', { name: item.assignee.name }),
    item.since === null ? null : t('inbox.since', { when: relativeTime(item.since) }),
    item.due === null
      ? null
      : t('inbox.due', { when: item.due.length === 10 ? date(item.due) : dateTime(item.due) }),
  ].filter((fact): fact is string => fact !== null);
  return (
    <li className="record-list__row inbox-item">
      <span className="inbox-item__text">
        <span className="record-list__title">
          <Link to={item.link}>{item.title}</Link>{' '}
          {item.priority === 'high' && <Badge tone="danger">{t('inbox.urgent')}</Badge>}
        </span>
        <span className="record-list__meta">{facts.join(' · ')}</span>
        {when.length > 0 && <span className="record-list__meta">{when.join(' · ')}</span>}
      </span>
      <span className="row">
        <ItemActions item={item} />
      </span>
    </li>
  );
}

function GroupCard({ group }: { readonly group: InboxGroup }) {
  const { t, label } = useI18n();
  const more = group.total > group.items.length;
  return (
    <Card
      title={`${label('inboxKinds', group.kind)} (${String(group.total)})`}
      actions={
        more ? (
          <Link to={KIND_PATHS[group.kind]}>{t('inbox.seeAll', { count: group.total })}</Link>
        ) : undefined
      }
    >
      <ul className="record-list">
        {group.items.map((item) => (
          <ItemRow key={`${item.kind}:${item.id}`} item={item} />
        ))}
      </ul>
    </Card>
  );
}

/**
 * /inbox — "Needs action": everything waiting on the member (approvals,
 * transfers, counts, broken promises, follow-ups, low stock) grouped by kind,
 * with the actions they may take without opening the record.
 */
export function InboxPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const kind = INBOX_KINDS.find((value) => value === filters.values.kind);
  const storeId = filters.values.store === '' ? undefined : filters.values.store;
  const inbox = useQuery({
    queryKey: [...inboxKey, 'list', { kind, storeId }],
    queryFn: ({ signal }) =>
      api.inbox.list(
        { ...(kind === undefined ? {} : { kind }), ...(storeId === undefined ? {} : { storeId }) },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const kinds = inbox.data?.kinds ?? [];

  return (
    <>
      <PageHeader title={t('inbox.title')} description={t('inbox.description')} />
      <div className="filters">
        <Field label={t('inbox.kind')}>
          <Select
            value={kind ?? ''}
            onChange={(event) => {
              filters.set('kind', event.target.value);
            }}
          >
            <option value="">{t('inbox.allKinds')}</option>
            {kinds.map((value) => (
              <option key={value} value={value}>
                {label('inboxKinds', value)}
              </option>
            ))}
          </Select>
        </Field>
        <StoreSelect
          label={t('inbox.store')}
          value={filters.values.store}
          emptyLabel={t('inbox.allStores')}
          onChange={(value) => {
            filters.set('store', value);
          }}
        />
      </div>
      <QueryState query={inbox} error="inbox.error">
        {(view) =>
          view.groups.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Icon name="check" size={32} />}
                title={t('inbox.empty')}
                description={t('inbox.emptyDescription')}
              />
            </Card>
          ) : (
            <div className="inbox">
              {view.groups.map((group) => (
                <GroupCard key={group.kind} group={group} />
              ))}
            </div>
          )
        }
      </QueryState>
    </>
  );
}
