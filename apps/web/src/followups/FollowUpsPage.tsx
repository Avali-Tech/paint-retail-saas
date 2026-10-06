import {
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Pagination,
  Select,
  buttonStyle,
  type Tone,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { DOCUMENT_PERMISSIONS } from '../api/documents.js';
import type { FollowUpWindow } from '../api/follow-ups.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { useMembers } from '../team/team-data.js';
import { recordPath, timelinePath } from './activity-helpers.js';
import { DoneDialog, RescheduleDialog, type FollowUp } from './FollowUpDialogs.js';
import { TIMELINE_PERMISSIONS } from './nav.js';

export const FOLLOW_UP_PAGE_SIZE = 20;
const FILTERS = ['assignedTo', 'storeId'] as const;
const WINDOWS = ['overdue', 'today', 'upcoming'] as const satisfies readonly FollowUpWindow[];
const WINDOW_TONE: Record<(typeof WINDOWS)[number], Tone> = {
  overdue: 'danger',
  today: 'warning',
  upcoming: 'neutral',
};

type Action = { readonly kind: 'done' | 'reschedule'; readonly followUp: FollowUp } | null;

function FollowUpItem({
  followUp,
  showAssignee,
  onAction,
}: {
  readonly followUp: FollowUp;
  readonly showAssignee: boolean;
  readonly onAction: (action: Action) => void;
}) {
  const { t, label, dateTime } = useI18n();
  const can = usePermissions();
  const { record } = followUp;
  return (
    <li className="record-list__row">
      <span className="picker__who">
        <span className="record-list__title">
          {followUp.subject}{' '}
          {followUp.overdue && <Badge tone="danger">{t('followUps.overdueBadge')}</Badge>}
        </span>
        <span className="record-list__meta">
          {label('activityTypes', followUp.type)} ·{' '}
          {t('followUps.due', { when: dateTime(followUp.dueAt) })}
        </span>
        {showAssignee && (
          <span className="record-list__meta">
            {t('followUps.assignedTo', { name: followUp.assignedTo.name })}
          </span>
        )}
        <span className="record-list__meta">
          <Link to={recordPath(record)}>{record.label}</Link>
          {TIMELINE_PERMISSIONS.some(can) && (
            <>
              {' · '}
              <Link
                to={timelinePath(record)}
                aria-label={t('followUps.recordTimelineName', { label: record.label })}
              >
                {t('followUps.recordTimeline')}
              </Link>
            </>
          )}
        </span>
      </span>
      {/* Changing an activity needs the manage permission of its record. */}
      {can(DOCUMENT_PERMISSIONS[record.type].manage) && (
        <span className="row">
          <Button
            size="sm"
            aria-label={t('followUps.doneName', { subject: followUp.subject })}
            onClick={() => {
              onAction({ kind: 'done', followUp });
            }}
          >
            {t('followUps.done')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('followUps.rescheduleName', { subject: followUp.subject })}
            onClick={() => {
              onAction({ kind: 'reschedule', followUp });
            }}
          >
            {t('followUps.reschedule')}
          </Button>
        </span>
      )}
    </li>
  );
}

function FollowUpSection({
  when,
  assignedTo,
  storeId,
  onAction,
}: {
  readonly when: (typeof WINDOWS)[number];
  readonly assignedTo: string;
  readonly storeId: string;
  readonly onAction: (action: Action) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [offset, setOffset] = useState(0);
  const followUps = useQuery({
    queryKey: ['follow-ups', when, { assignedTo, storeId, offset }],
    queryFn: ({ signal }) =>
      api.followUps.followUps(
        {
          when,
          limit: FOLLOW_UP_PAGE_SIZE,
          offset,
          ...(assignedTo === '' ? {} : { assignedTo }),
          ...(storeId === '' ? {} : { storeId }),
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const title = t(`followUps.windows.${when}`);
  return (
    <Card
      title={title}
      actions={
        followUps.data === undefined ? undefined : (
          <Badge tone={followUps.data.total > 0 ? WINDOW_TONE[when] : 'neutral'}>
            {String(followUps.data.total)}
          </Badge>
        )
      }
    >
      <QueryState query={followUps} error="followUps.error">
        {(page) => {
          // Follow-ups always have a due time; the type allows none for logged activities.
          const due = page.items.filter((item): item is FollowUp => item.dueAt !== null);
          return due.length === 0 ? (
            <p className="muted">{t(`followUps.empty.${when}`)}</p>
          ) : (
            <>
              <ul className="record-list">
                {due.map((followUp) => (
                  <FollowUpItem
                    key={followUp.id}
                    followUp={followUp}
                    showAssignee={assignedTo !== ''}
                    onAction={onAction}
                  />
                ))}
              </ul>
              <Pagination
                offset={offset}
                limit={FOLLOW_UP_PAGE_SIZE}
                total={page.total}
                onChange={setOffset}
                label={t('followUps.pages', { window: title })}
                range={(from, to, total) => t('common.range', { from, to, total })}
                previousLabel={t('common.previous')}
                nextLabel={t('common.next')}
              />
            </>
          );
        }}
      </QueryState>
    </Card>
  );
}

/** Managers choose whose follow-ups to see and at which store. */
function TeamFilters({
  assignedTo,
  storeId,
  onChange,
}: {
  readonly assignedTo: string;
  readonly storeId: string;
  readonly onChange: (key: (typeof FILTERS)[number], value: string) => void;
}) {
  const { t } = useI18n();
  const profile = useCurrentProfile();
  const members = useMembers();
  return (
    <Card>
      <div className="filters">
        <Field label={t('followUps.assignee')}>
          <Select
            value={assignedTo}
            onChange={(event) => {
              onChange('assignedTo', event.target.value);
            }}
          >
            <option value="">{t('followUps.me')}</option>
            <option value="everyone">{t('followUps.everyone')}</option>
            {(members.data ?? [])
              .filter((member) => member.isActive && member.id !== profile.memberId)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.user.fullName}
                </option>
              ))}
          </Select>
        </Field>
        <StoreSelect
          label={t('followUps.store')}
          value={storeId}
          onChange={(value) => {
            onChange('storeId', value);
          }}
          emptyLabel={t('followUps.allStores')}
        />
      </div>
    </Card>
  );
}

/**
 * /follow-ups — the member's own follow-ups by when they are due; managers
 * also see a colleague's, or everyone's at their stores (?assignedTo=everyone),
 * each with who it is assigned to.
 */
export function FollowUpsPage() {
  const { t } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  // Choosing someone else needs the team list; choosing a store needs the store list.
  const manager = can('members:read') && can('stores:read');
  const assignedTo = manager ? filters.values.assignedTo : '';
  const storeId = manager ? filters.values.storeId : '';
  const [action, setAction] = useState<Action>(null);
  const close = () => {
    setAction(null);
  };
  return (
    <>
      <PageHeader
        title={t(assignedTo === 'everyone' ? 'followUps.teamTitle' : 'followUps.title')}
        description={t(
          assignedTo === 'everyone' ? 'followUps.teamDescription' : 'followUps.description',
        )}
        actions={
          TIMELINE_PERMISSIONS.some(can) ? (
            <Link to="/activities" {...buttonStyle('secondary')}>
              {t('followUps.timeline')}
            </Link>
          ) : undefined
        }
      />
      <div className="stack">
        {manager && (
          <TeamFilters assignedTo={assignedTo} storeId={storeId} onChange={filters.set} />
        )}
        <div className="detail-grid">
          {WINDOWS.map((when) => (
            <FollowUpSection
              // A new choice starts each list at its first page.
              key={`${when}-${assignedTo}-${storeId}`}
              when={when}
              assignedTo={assignedTo}
              storeId={storeId}
              onAction={setAction}
            />
          ))}
        </div>
      </div>
      {action?.kind === 'done' && <DoneDialog followUp={action.followUp} onClose={close} />}
      {action?.kind === 'reschedule' && (
        <RescheduleDialog followUp={action.followUp} onClose={close} />
      )}
    </>
  );
}
