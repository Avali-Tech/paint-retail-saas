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
import { Link, useNavigate } from 'react-router';
import {
  ACTIVITY_RECORD_TYPES,
  ACTIVITY_TYPES,
  type Activity,
  type ActivityRecordType,
} from '../api/follow-ups.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { dateRangeProblems } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import { PartyPicker } from '../parties/PartyPicker.js';
import {
  activityMoment,
  filterActivities,
  peopleIn,
  recordPath,
  timelinePath,
} from './activity-helpers.js';

/** The most the API gives in one page; filters apply within it. */
export const TIMELINE_PAGE_SIZE = 200;
const FILTERS = ['recordType', 'recordId', 'type', 'person', 'from', 'to'] as const;

const STATUS_TONE: Record<Activity['status'], Tone> = {
  scheduled: 'info',
  done: 'success',
  cancelled: 'neutral',
};

function ActivityItem({ activity }: { readonly activity: Activity }) {
  const { t, label, dateTime } = useI18n();
  return (
    <li>
      <span className="record-list__title">
        {activity.subject}{' '}
        <Badge tone={STATUS_TONE[activity.status]}>
          {label('activityStatus', activity.status)}
        </Badge>
      </span>
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

function Timeline({
  record,
}: {
  readonly record: { readonly type: ActivityRecordType; readonly id: string };
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const filters = useUrlFilters(FILTERS);
  const { type, person, from, to } = filters.values;
  const problems = dateRangeProblems(from, to);
  const fromError = problems.from === undefined ? undefined : t(`activities.${problems.from}`);
  const toError = problems.to === undefined ? undefined : t(`activities.${problems.to}`);
  const timeline = useQuery({
    queryKey: ['activities', record.type, record.id, filters.offset],
    queryFn: ({ signal }) =>
      api.followUps.timeline(
        {
          recordType: record.type,
          recordId: record.id,
          limit: TIMELINE_PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const people = peopleIn(timeline.data?.items ?? []);
  // The record's name, e.g. "LD-000004 · Kondapur tower", once anything is logged on it.
  const recordLabel = timeline.data?.items[0]?.record.label;
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
        <Field label={t('activities.type')}>
          <Select
            value={type}
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
        <Field label={t('activities.person')}>
          <Select
            value={person}
            onChange={(event) => {
              filters.set('person', event.target.value);
            }}
          >
            <option value="">{t('activities.everyone')}</option>
            {people.map((someone) => (
              <option key={someone.id} value={someone.id}>
                {someone.name}
              </option>
            ))}
          </Select>
        </Field>
        {date('from', from, fromError)}
        {date('to', to, toError)}
      </div>
      <QueryState query={timeline} error="activities.error">
        {(page) => {
          // Dates that are not valid yet (half typed) do not filter.
          const shown = filterActivities(page.items, {
            type,
            person,
            from: fromError === undefined ? from : '',
            to: toError === undefined ? to : '',
          });
          if (page.total === 0) {
            return (
              <EmptyState icon={<Icon name="calendar" size={32} />} title={t('activities.empty')} />
            );
          }
          return (
            <div className="stack">
              {shown.length === 0 ? (
                <p className="muted">{t('activities.noMatches')}</p>
              ) : (
                <ul className="record-list">
                  {shown.map((activity) => (
                    <ActivityItem key={activity.id} activity={activity} />
                  ))}
                </ul>
              )}
              <p className="muted">
                {t('activities.shown', { shown: shown.length, total: page.total })}
              </p>
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
          );
        }}
      </QueryState>
    </Card>
  );
}

/**
 * /activities?recordType=…&recordId=… — a record's timeline, filtered by type,
 * person and India-time dates. Without a record, choose a customer or party
 * (leads, opportunities and projects link here from their pages).
 */
export function ActivitiesPage() {
  const { t, label } = useI18n();
  const can = usePermissions();
  const navigate = useNavigate();
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
                {t('activities.chooseAnother')}
              </Link>
            </span>
          )
        }
      />
      {record !== null ? (
        <Timeline key={`${record.type}-${record.id}`} record={record} />
      ) : can('parties:read') ? (
        <div className="stack">
          <PartyPicker
            title={t('activities.chooseRecord')}
            onPick={(party) => {
              void navigate(timelinePath({ type: 'party', id: party.id }));
            }}
          />
          <p className="muted">{t('activities.otherRecords')}</p>
        </div>
      ) : (
        <Card>
          <p className="muted">{t('activities.noRecord')}</p>
        </Card>
      )}
    </>
  );
}
