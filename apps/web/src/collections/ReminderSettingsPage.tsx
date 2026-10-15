import {
  Alert,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  PageHeader,
  Table,
  buttonStyle,
  useToast,
} from '@paint/ui';
import {
  DEFAULT_REMINDER_OFFSETS,
  MESSAGE_CHANNELS,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  type MessageChannel,
  type ReminderScheduleInput,
  type ReminderScheduleView,
} from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';

interface Row {
  /** Stable while editing (the offset can change). */
  readonly key: number;
  readonly offset: string;
  readonly channels: readonly MessageChannel[];
  readonly isActive: boolean;
}

export type RowProblem = 'offset' | 'twice' | 'channels';

/**
 * The rows as the API takes them, or the first problem of each row that has one:
 * a whole number of days in range, each day once, at least one channel.
 */
export function readSchedule(
  rows: readonly Row[],
): { schedules: ReminderScheduleInput[] } | { problems: Map<number, RowProblem> } {
  const problems = new Map<number, RowProblem>();
  const seen = new Set<number>();
  const schedules = rows.map((row) => {
    const offsetDays = Number(row.offset.trim().replace('−', '-'));
    if (
      !/^[−-]?\d{1,2}$/.test(row.offset.trim()) ||
      offsetDays < REMINDER_OFFSET_MIN ||
      offsetDays > REMINDER_OFFSET_MAX
    ) {
      problems.set(row.key, 'offset');
    } else if (seen.has(offsetDays)) {
      problems.set(row.key, 'twice');
    } else if (row.channels.length === 0) {
      problems.set(row.key, 'channels');
    }
    seen.add(offsetDays);
    return { offsetDays, channels: row.channels, isActive: row.isActive };
  });
  return problems.size === 0 ? { schedules } : { problems };
}

/** "3 days before", "On the due date", "7 days after". */
export function offsetLabel(offset: number, plural: I18n['plural'], t: I18n['t']): string {
  if (offset < 0) return plural('collections.schedule.before', -offset);
  if (offset === 0) return t('collections.schedule.onDay');
  return plural('collections.schedule.after', offset);
}

const toRows = (
  schedules: readonly Pick<ReminderScheduleView, 'offsetDays' | 'channels' | 'isActive'>[],
) =>
  schedules.map((schedule, key) => ({
    key,
    offset: String(schedule.offsetDays),
    channels: schedule.channels,
    isActive: schedule.isActive,
  }));

function ScheduleForm({ saved }: { readonly saved: readonly ReminderScheduleView[] }) {
  const api = useApi();
  const { t, plural, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editable = usePermissions()('credit:approve');
  const [rows, setRows] = useState<readonly Row[]>(toRows(saved));
  const [problems, setProblems] = useState<Map<number, RowProblem>>(new Map());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = (key: number, update: Partial<Row>) => {
    setRows(rows.map((row) => (row.key === key ? { ...row, ...update } : row)));
  };
  const nextKey = () => Math.max(-1, ...rows.map((row) => row.key)) + 1;

  const save = async () => {
    const read = readSchedule(rows);
    if ('problems' in read) {
      setProblems(read.problems);
      return;
    }
    setProblems(new Map());
    setMessage(null);
    setBusy(true);
    try {
      const next = await api.collections.saveReminderSchedules(read.schedules);
      queryClient.setQueryData(['collections', 'reminder-schedules'], next);
      setRows(toRows(next));
      toast({ title: t('collections.schedule.saved'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const problemText: Record<RowProblem, string> = {
    offset: t('collections.schedule.offsetInvalid'),
    twice: t('collections.schedule.offsetTwice'),
    channels: t('collections.schedule.channelsInvalid'),
  };

  return (
    <div className="stack">
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {!editable && <Alert tone="info">{t('collections.schedule.readOnly')}</Alert>}
      <Card>
        <fieldset className="plain-fieldset stack" disabled={!editable}>
          {rows.length === 0 ? (
            <EmptyState title={t('collections.schedule.empty')} />
          ) : (
            <Table label={t('collections.schedule.table')}>
              <thead>
                <tr>
                  <th scope="col">{t('collections.schedule.offset')}</th>
                  <th scope="col">{t('collections.schedule.channels')}</th>
                  <th scope="col">{t('collections.schedule.active')}</th>
                  <th scope="col">
                    <span className="ui-visually-hidden">{t('collections.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const problem = problems.get(row.key);
                  const days = Number(row.offset);
                  const description =
                    row.offset.trim() !== '' && Number.isInteger(days)
                      ? offsetLabel(days, plural, t)
                      : t('collections.schedule.offsetHint');
                  return (
                    <tr key={row.key}>
                      <td>
                        <Input
                          aria-label={t('collections.schedule.offset')}
                          aria-invalid={problem === 'offset' || problem === 'twice'}
                          inputMode="numeric"
                          value={row.offset}
                          onChange={(event) => {
                            change(row.key, { offset: event.target.value });
                          }}
                        />
                        <div className="muted">{description}</div>
                        {problem !== undefined && (
                          <div className="ui-field__error" role="alert">
                            {problemText[problem]}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="row">
                          {MESSAGE_CHANNELS.map((channel) => (
                            <Checkbox
                              key={channel}
                              label={label('messageChannels', channel)}
                              checked={row.channels.includes(channel)}
                              onChange={(event) => {
                                change(row.key, {
                                  channels: event.target.checked
                                    ? [...row.channels, channel]
                                    : row.channels.filter((c) => c !== channel),
                                });
                              }}
                            />
                          ))}
                        </span>
                      </td>
                      <td>
                        <Checkbox
                          label={t('collections.schedule.active')}
                          checked={row.isActive}
                          onChange={(event) => {
                            change(row.key, { isActive: event.target.checked });
                          }}
                        />
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('collections.schedule.remove', { days: description })}
                          onClick={() => {
                            setRows(rows.filter((other) => other.key !== row.key));
                          }}
                        >
                          ×
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => {
                setRows([
                  ...rows,
                  { key: nextKey(), offset: '', channels: ['whatsapp'], isActive: true },
                ]);
              }}
            >
              {t('collections.schedule.add')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRows(
                  toRows(
                    DEFAULT_REMINDER_OFFSETS.map((offsetDays) => ({
                      offsetDays,
                      channels: ['whatsapp', 'sms'],
                      isActive: true,
                    })),
                  ),
                );
              }}
            >
              {t('collections.schedule.suggested')}
            </Button>
          </div>
        </fieldset>
      </Card>
      {editable && (
        <div className="row row--end">
          <Button
            loading={busy}
            onClick={() => {
              void save();
            }}
          >
            {t('collections.schedule.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** /collections/reminders — when payment reminders go out (P2-M11). */
export function ReminderSettingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const schedules = useQuery({
    queryKey: ['collections', 'reminder-schedules'],
    queryFn: ({ signal }) => api.collections.reminderSchedules(signal),
  });
  return (
    <>
      <PageHeader
        title={t('collections.schedule.title')}
        description={t('collections.schedule.description')}
        actions={
          <Link to="/collections" {...buttonStyle('secondary')}>
            {t('collections.schedule.back')}
          </Link>
        }
      />
      <QueryState query={schedules} error="collections.schedule.error">
        {(saved) => <ScheduleForm saved={saved} />}
      </QueryState>
    </>
  );
}
