import { Badge, Button, Card, Field, Input, Select, Textarea, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  ACTIVITY_TYPES,
  type Activity,
  type ActivityType,
  type CrmRecordType,
} from '../api/record-activities.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { timelinePath } from '../followups/activity-helpers.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import { given, indiaMoment, refreshCrm } from './crm.js';

/** Things already done; a follow-up is scheduled instead. */
const LOGGED_TYPES = ACTIVITY_TYPES.filter((type) => type !== 'follow_up');

type Mode = 'log' | 'schedule';

function ActivityDialog({
  mode,
  recordType,
  recordId,
  onClose,
}: {
  readonly mode: Mode;
  readonly recordType: CrmRecordType;
  readonly recordId: string;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const scheduling = mode === 'schedule';
  const [type, setType] = useState<ActivityType>(scheduling ? 'follow_up' : 'call');
  const [subject, setSubject] = useState('');
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t(scheduling ? 'crm.activities.scheduleTitle' : 'crm.activities.logTitle')}
      submitLabel={t(scheduling ? 'crm.activities.schedule' : 'crm.activities.log')}
      onSubmit={async () => {
        if (subject.trim().length < 2) return t('crm.activities.subjectInvalid');
        if (scheduling && (date === '' || time === '')) return t('crm.activities.dueInvalid');
        await api.recordActivities.add({
          recordType,
          recordId,
          type,
          subject: subject.trim(),
          ...(given(notes) === undefined ? {} : { notes: notes.trim() }),
          ...(scheduling
            ? { dueAt: indiaMoment(date, time) }
            : given(outcome) === undefined
              ? {}
              : { outcome: outcome.trim() }),
        });
        await refreshCrm(queryClient);
        toast({
          title: t(scheduling ? 'crm.activities.scheduled' : 'crm.activities.logged'),
          tone: 'success',
        });
        return undefined;
      }}
    >
      <Field label={t('crm.activities.type')}>
        <Select
          value={type}
          onChange={(event) => {
            setType(event.target.value as ActivityType);
          }}
        >
          {(scheduling ? ACTIVITY_TYPES : LOGGED_TYPES).map((value) => (
            <option key={value} value={value}>
              {label('activityTypes', value)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('crm.activities.subject')} required>
        <Input
          maxLength={200}
          value={subject}
          onChange={(event) => {
            setSubject(event.target.value);
          }}
        />
      </Field>
      {scheduling && (
        <div className="form-grid">
          <Field label={t('crm.activities.dueDate')} required>
            <Input
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
            />
          </Field>
          <Field label={t('crm.activities.dueTime')} required>
            <Input
              type="time"
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
              }}
            />
          </Field>
        </div>
      )}
      <Field label={t('crm.activities.notes')}>
        <Textarea
          maxLength={4000}
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
        />
      </Field>
      {!scheduling && (
        <Field label={t('crm.activities.outcome')}>
          <Input
            maxLength={4000}
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value);
            }}
          />
        </Field>
      )}
    </FormDialog>
  );
}

function ActivityItem({ activity }: { readonly activity: Activity }) {
  const { t, label, dateTime } = useI18n();
  const when =
    activity.status === 'scheduled' && activity.dueAt !== null
      ? t('crm.activities.due', { time: dateTime(activity.dueAt) })
      : dateTime(activity.completedAt ?? activity.createdAt);
  return (
    <li>
      <span className="record-list__title">
        {activity.subject}{' '}
        <span className="badges">
          <Badge>{label('activityTypes', activity.type)}</Badge>
          {activity.overdue ? (
            <Badge tone="danger">{t('crm.activities.overdue')}</Badge>
          ) : (
            activity.status !== 'done' && (
              <Badge tone={activity.status === 'scheduled' ? 'info' : 'neutral'}>
                {label('activityStatus', activity.status)}
              </Badge>
            )
          )}
        </span>
      </span>
      <span className="record-list__meta">{[when, activity.assignedTo.name].join(' · ')}</span>
      {activity.notes !== null && <span>{activity.notes}</span>}
      {activity.outcome !== null && (
        <span className="muted">
          {t('crm.activities.outcomeValue', { outcome: activity.outcome })}
        </span>
      )}
    </li>
  );
}

/**
 * A lead's, opportunity's or project's activities, latest first, with buttons to
 * log a call, visit or note and to schedule a follow-up (for those who may change it).
 */
export function RecordActivities({
  recordType,
  recordId,
  canAdd,
}: {
  readonly recordType: CrmRecordType;
  readonly recordId: string;
  readonly canAdd: boolean;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode | null>(null);
  const activities = useQuery({
    queryKey: ['activities', recordType, recordId],
    queryFn: ({ signal }) => api.recordActivities.timeline(recordType, recordId, signal),
  });
  return (
    <Card
      title={t('crm.activities.title')}
      actions={
        canAdd ? (
          <span className="row">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setMode('log');
              }}
            >
              {t('crm.activities.log')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setMode('schedule');
              }}
            >
              {t('crm.activities.schedule')}
            </Button>
          </span>
        ) : undefined
      }
    >
      <QueryState query={activities} error="crm.activities.error">
        {(page) =>
          page.items.length === 0 ? (
            <p className="muted">{t('crm.activities.none')}</p>
          ) : (
            <div className="stack">
              <ul className="record-list" aria-label={t('crm.activities.title')}>
                {page.items.map((activity) => (
                  <ActivityItem key={activity.id} activity={activity} />
                ))}
              </ul>
              <Link to={timelinePath({ type: recordType, id: recordId })}>
                {t('crm.activities.seeAll')}
              </Link>
            </div>
          )
        }
      </QueryState>
      {mode !== null && (
        <ActivityDialog
          mode={mode}
          recordType={recordType}
          recordId={recordId}
          onClose={() => {
            setMode(null);
          }}
        />
      )}
    </Card>
  );
}
