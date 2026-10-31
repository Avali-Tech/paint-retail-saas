import { Checkbox, Field, Input, Textarea, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Activity } from '../api/follow-ups.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { fromIndiaInput, isIndiaInput, toIndiaInput } from '../lib/india-time.js';
import { refreshActivities } from './activity-helpers.js';

/** A follow-up: an open activity with a due time. */
export type FollowUp = Activity & { readonly dueAt: string };

/** Marks a follow-up done with what came of it, optionally scheduling the next step. */
export function DoneDialog({
  followUp,
  onClose,
}: {
  readonly followUp: Pick<FollowUp, 'id' | 'subject'>;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [scheduleNext, setScheduleNext] = useState(false);
  const [nextAt, setNextAt] = useState('');
  const [nextSubject, setNextSubject] = useState('');
  const [timeError, setTimeError] = useState<string | undefined>(undefined);

  const submit = async () => {
    setTimeError(undefined);
    if (scheduleNext && !isIndiaInput(nextAt)) {
      setTimeError(t('followUps.timeInvalid'));
      return false;
    }
    const { next } = await api.followUps.complete(followUp.id, {
      ...(outcome.trim() === '' ? {} : { outcome: outcome.trim() }),
      ...(scheduleNext
        ? {
            next: {
              dueAt: fromIndiaInput(nextAt),
              ...(nextSubject.trim() === '' ? {} : { subject: nextSubject.trim() }),
            },
          }
        : {}),
    });
    await refreshActivities(queryClient);
    toast({
      title:
        next === null
          ? t('followUps.completed')
          : t('followUps.completedNext', { when: dateTime(String(next.dueAt)) }),
      tone: 'success',
    });
    return undefined;
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('followUps.doneTitle', { subject: followUp.subject })}
      submitLabel={t('followUps.done')}
      onSubmit={submit}
    >
      <Field label={t('followUps.outcome')} hint={t('followUps.outcomeHint')}>
        <Textarea
          maxLength={4000}
          value={outcome}
          onChange={(event) => {
            setOutcome(event.target.value);
          }}
        />
      </Field>
      <Checkbox
        label={t('followUps.scheduleNext')}
        checked={scheduleNext}
        onChange={(event) => {
          setScheduleNext(event.target.checked);
        }}
      />
      {scheduleNext && (
        <>
          <Field label={t('followUps.nextAt')} required error={timeError}>
            <Input
              type="datetime-local"
              value={nextAt}
              onChange={(event) => {
                setNextAt(event.target.value);
              }}
            />
          </Field>
          <Field
            label={t('followUps.nextSubject')}
            hint={t('followUps.nextSubjectHint', { subject: followUp.subject })}
          >
            <Input
              maxLength={200}
              value={nextSubject}
              onChange={(event) => {
                setNextSubject(event.target.value);
              }}
            />
          </Field>
        </>
      )}
    </FormDialog>
  );
}

/** Moves a follow-up to another day and time (India time). */
export function RescheduleDialog({
  followUp,
  onClose,
}: {
  readonly followUp: FollowUp;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dueAt, setDueAt] = useState(toIndiaInput(followUp.dueAt));
  const [timeError, setTimeError] = useState<string | undefined>(undefined);

  const submit = async () => {
    setTimeError(undefined);
    if (!isIndiaInput(dueAt)) {
      setTimeError(t('followUps.timeInvalid'));
      return false;
    }
    const moved = await api.followUps.update(followUp.id, { dueAt: fromIndiaInput(dueAt) });
    await refreshActivities(queryClient);
    toast({
      title: t('followUps.rescheduled', { when: dateTime(String(moved.dueAt)) }),
      tone: 'success',
    });
    return undefined;
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('followUps.rescheduleTitle', { subject: followUp.subject })}
      submitLabel={t('followUps.reschedule')}
      onSubmit={submit}
    >
      <Field label={t('followUps.newTime')} required error={timeError}>
        <Input
          type="datetime-local"
          value={dueAt}
          onChange={(event) => {
            setDueAt(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}
