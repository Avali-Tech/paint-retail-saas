import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Select,
  buttonStyle,
  type Tone,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { DOCUMENT_PERMISSIONS } from '../api/documents.js';
import {
  ACTIVITY_RECORD_TYPES,
  ACTIVITY_TYPES,
  type Activity,
  type ActivityRecordType,
  type TimelineQuery,
} from '../api/follow-ups.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { dateRangeProblems } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import { useMembers } from '../team/team-data.js';
import { activityMoment, recordPath, timelinePath } from './activity-helpers.js';

/** Activities per page; the API filters and pages. */
export const TIMELINE_PAGE_SIZE = 50;
const FILTERS = ['recordType', 'recordId', 'type', 'person', 'from', 'to'] as const;

const STATUS_TONE: Record<Activity['status'], Tone> = {
  scheduled: 'info',
  done: 'success',
  cancelled: 'neutral',
};

interface RecordRef {
  readonly type: ActivityRecordType;
  readonly id: string;
}

function ActivityItem({
  activity,
  showRecord,
}: {
  readonly activity: Activity;
  readonly showRecord: boolean;
}) {
  const { t, label, dateTime } = useI18n();
  const { record } = activity;
  return (
    <li>
      <span className="record-list__title">
        {activity.subject}{' '}
        <Badge tone={STATUS_TONE[activity.status]}>
          {label('activityStatus', activity.status)}
        </Badge>
      </span>
      {showRecord && (
        <span className="record-list__meta">
          {label('followUpRecordTypes', record.type)} ·{' '}
          <Link to={recordPath(record)}>{record.label}</Link> ·{' '}
          <Link
            to={timelinePath(record)}
            aria-label={t('followUps.recordTimelineName', { label: record.label })}
          >
            {t('followUps.recordTimeline')}
          </Link>
        </span>
      )}
      <span className="record-list__meta">
        {t('activities.meta', {
          type: label('activityTypes', activity.type),
          status: label('activityStatus', activity.status),
          when: dateTime(activityMoment(activity)),
        })}
      </span>
      <span className="record-list__meta">
        {t('activities.by', { name: activity.createdBy.name })}
        {activity.assignedTo.memberId !== activity.createdBy.memberId &&
          ` · ${t('activities.assigned', { name: activity.assignedTo.name })}`}
      </span>
      {activity.notes !== null && <span>{activity.notes}</span>}
      {activity.outcome !== null && (
        <span>{t('activities.outcome', { outcome: activity.outcome })}</span>
      )}
    </li>
  );
}

/** Everyone, me, or (for those who can see the team) one colleague. */
function PersonFilter({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const canSeeTeam = usePermissions()('members:read');
  const members = useMembers({ enabled: canSeeTeam });
  return (
    <Field label={t('activities.person')}>
      <Select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('activities.everyone')}</option>
        <option value="me">{t('activities.me')}</option>
        {(members.data ?? [])
          .filter((member) => member.isActive)
          .map((member) => (
            <option key={member.id} value={member.id}>
              {member.user.fullName}
            </option>
          ))}
      </Select>
    </Field>
  );
}

/**
 * Activities with filters the API applies: one record's timeline, or every
 * record the member can see (optionally of one kind).
 */
function ActivityList({ record }: { readonly record: RecordRef | null }) {
  const api = useApi();
  const { t, label } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { type, person, from, to } = filters.values;
  const problems = dateRangeProblems(from, to);
  const fromError = problems.from === undefined ? undefined : t(`activities.${problems.from}`);
  const toError = problems.to === undefined ? undefined : t(`activities.${problems.to}`);
  const recordType = ACTIVITY_RECORD_TYPES.find((value) => value === filters.values.recordType);
  const activityType = ACTIVITY_TYPES.find((value) => value === type);
  // Only filters with a value, and dates only once they are valid.
  const query: TimelineQuery = {
    ...(record === null ? { recordType } : { recordType: record.type, recordId: record.id }),
    type: activityType,
    person: person === '' ? undefined : person,
    from: from === '' || fromError !== undefined ? undefined : from,
    to: to === '' || toError !== undefined ? undefined : to,
    limit: TIMELINE_PAGE_SIZE,
    offset: filters.offset,
  };
  const activities = useQuery({
    queryKey: ['activities', query],
    queryFn: ({ signal }) => api.followUps.timeline(query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = [type, person, from, to, record === null ? (recordType ?? '') : ''].some(
    (value) => value !== '',
  );
  // The record's name, e.g. "LD-000004 · Kondapur tower", once anything is logged on it.
  const recordLabel = record === null ? undefined : activities.data?.items[0]?.record.label;
  const date = (key: 'from' | 'to', value: string, error: string | undefined) => (
    <Field label={t(`activities.${key}`)} hint={t('activities.dateHint')} error={error}>
      <Input
        type="date"
        value={value}
        onChange={(event) => {
          filters.set(key, event.target.value);
        }}
      />
    </Field>
  );
  return (
    <Card {...(recordLabel === undefined ? {} : { title: recordLabel })}>
      <div className="filters">
        {record === null && (
          <Field label={t('activities.recordType')}>
            <Select
              value={recordType ?? ''}
              onChange={(event) => {
                filters.set('recordType', event.target.value);
              }}
            >
              <option value="">{t('activities.allRecords')}</option>
              {ACTIVITY_RECORD_TYPES.filter((value) => can(DOCUMENT_PERMISSIONS[value].read)).map(
                (value) => (
                  <option key={value} value={value}>
                    {label('followUpRecordTypes', value)}
                  </option>
                ),
              )}
            </Select>
          </Field>
        )}
        <Field label={t('activities.type')}>
          <Select
            value={activityType ?? ''}
            onChange={(event) => {
              filters.set('type', event.target.value);
            }}
          >
            <option value="">{t('activities.allTypes')}</option>
            {ACTIVITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {label('activityTypes', value)}
              </option>
            ))}
          </Select>
        </Field>
        <PersonFilter
          value={person}
          onChange={(value) => {
            filters.set('person', value);
          }}
        />
        {date('from', from, fromError)}
        {date('to', to, toError)}
      </div>
      <QueryState query={activities} error="activities.error">
        {(page) =>
          page.total === 0 ? (
            filtered ? (
              <p className="muted">{t('activities.noMatches')}</p>
            ) : (
              <EmptyState
                icon={<Icon name="calendar" size={32} />}
                title={t(record === null ? 'activities.emptyAll' : 'activities.empty')}
              />
            )
          ) : (
            <div className="stack">
              <ul className="record-list">
                {page.items.map((activity) => (
                  <ActivityItem
                    key={activity.id}
                    activity={activity}
                    showRecord={record === null}
                  />
                ))}
              </ul>
              <Pagination
                offset={filters.offset}
                limit={TIMELINE_PAGE_SIZE}
                total={page.total}
                onChange={filters.setOffset}
                label={t('activities.pages')}
                range={(first, last, total) => t('common.range', { from: first, to: last, total })}
                previousLabel={t('common.previous')}
                nextLabel={t('common.next')}
              />
            </div>
          )
        }
      </QueryState>
    </Card>
  );
}

/**
 * /activities — every call, visit, message and note on the records the member
 * can see, filtered by record type, type, person and India-time dates; with
 * ?recordType=…&recordId=…, one record's timeline with the same filters.
 */
export function ActivitiesPage() {
  const { t, label } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const recordType = ACTIVITY_RECORD_TYPES.find((value) => value === filters.values.recordType);
  const recordId = filters.values.recordId;
  const record =
    recordType === undefined || recordId === '' ? null : { type: recordType, id: recordId };
  return (
    <>
      <PageHeader
        title={t('activities.title')}
        description={
          record === null ? t('activities.description') : label('followUpRecordTypes', record.type)
        }
        actions={
          record === null ? undefined : (
            <span className="row">
              <Link to={recordPath(record)} {...buttonStyle('secondary')}>
                {t('activities.openRecord')}
              </Link>
              <Link to="/activities" {...buttonStyle('ghost')}>
                {t('activities.allActivities')}
              </Link>
            </span>
          )
        }
      />
      <ActivityList key={record === null ? 'all' : `${record.type}-${record.id}`} record={record} />
    </>
  );
}
