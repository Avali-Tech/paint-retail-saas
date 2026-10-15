import { Alert, Badge, Button, Card, Field, Select, useToast, type Tone } from '@paint/ui';
import {
  CONSENT_NOTICE_VERSION,
  CONSENT_STATES,
  MESSAGE_CHANNELS,
  MESSAGE_LANGUAGES,
  STAFF_CONSENT_METHODS,
  consentNotice,
  type ConsentState,
  type MessageChannel,
  type MessageLanguage,
  type MessageStatus,
  type PartyConsentsView,
} from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';

const STATE_TONE: Record<ConsentState, Tone> = { granted: 'success', withdrawn: 'danger' };
const MESSAGE_TONE: Record<MessageStatus, Tone> = {
  queued: 'neutral',
  sent: 'success',
  delivered: 'success',
  read: 'success',
  failed: 'danger',
  skipped: 'warning',
};

type StaffMethod = (typeof STAFF_CONSENT_METHODS)[number];

/** Records a party's choice about messages on one channel, after reading the notice. */
function ConsentDialog({
  partyId,
  consents,
  onClose,
}: {
  readonly partyId: string;
  readonly consents: PartyConsentsView;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label, locale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const business = useCurrentProfile().organization.name;
  const [channel, setChannel] = useState<MessageChannel>('whatsapp');
  const [state, setState] = useState<ConsentState>('granted');
  const [method, setMethod] = useState<StaffMethod>('counter_with_notice');
  const [language, setLanguage] = useState<MessageLanguage>(locale);
  const address = channel === 'email' ? consents.email : consents.phone;
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('messaging.dialog.title')}
      description={t('messaging.dialog.description')}
      submitLabel={t('messaging.dialog.save')}
      onSubmit={async () => {
        const saved = await api.messaging.recordConsent(partyId, {
          channel,
          state,
          method,
          language,
          noticeVersion: CONSENT_NOTICE_VERSION,
        });
        queryClient.setQueryData(['consents', partyId], saved);
        toast({ title: t('messaging.dialog.saved'), tone: 'success' });
        return undefined;
      }}
    >
      <Field label={t('messaging.channel')}>
        <Select
          value={channel}
          onChange={(event) => {
            setChannel(event.target.value as MessageChannel);
          }}
        >
          {MESSAGE_CHANNELS.map((option) => (
            <option key={option} value={option}>
              {label('messageChannels', option)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('messaging.dialog.state')}>
        <Select
          value={state}
          onChange={(event) => {
            setState(event.target.value as ConsentState);
          }}
        >
          {CONSENT_STATES.map((option) => (
            <option key={option} value={option}>
              {label('consentStates', option)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('messaging.dialog.method')}>
        <Select
          value={method}
          onChange={(event) => {
            setMethod(event.target.value as StaffMethod);
          }}
        >
          {STAFF_CONSENT_METHODS.map((option) => (
            <option key={option} value={option}>
              {label('consentMethods', option)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('messaging.dialog.language')}>
        <Select
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value as MessageLanguage);
          }}
        >
          {MESSAGE_LANGUAGES.map((option) => (
            <option key={option} value={option}>
              {label('statementLanguages', option)}
            </option>
          ))}
        </Select>
      </Field>
      {address === null ? (
        <Alert tone="warning">{t('messaging.noAddress')}</Alert>
      ) : (
        <Alert tone="info" title={t('messaging.dialog.notice')}>
          <span lang={language}>{consentNotice(language, { business, channel, address })}</span>
        </Alert>
      )}
    </FormDialog>
  );
}

/**
 * A party's messages on its 360 page (P2-M32): its consent per channel (nothing is
 * sent without it, [CA-3]), recording consent after the notice, and the latest
 * messages with how they went.
 */
export function MessagingPanel({ partyId }: { readonly partyId: string }) {
  const api = useApi();
  const { t, label, dateTime } = useI18n();
  const manage = usePermissions()('parties:manage');
  const [recording, setRecording] = useState(false);
  const consents = useQuery({
    queryKey: ['consents', partyId],
    queryFn: ({ signal }) => api.messaging.consents(partyId, signal),
  });
  const messages = useQuery({
    queryKey: ['messages', partyId],
    queryFn: ({ signal }) => api.messaging.messages(partyId, signal),
  });
  return (
    <Card title={t('messaging.title')}>
      <QueryState query={consents} error="messaging.error">
        {(view) => (
          <div className="stack">
            <dl className="facts">
              {MESSAGE_CHANNELS.map((channel) => {
                const current = view.current.find((consent) => consent.channel === channel);
                return (
                  <div key={channel}>
                    <dt>{label('messageChannels', channel)}</dt>
                    <dd>
                      {current === undefined ? (
                        <Badge>{t('messaging.notAsked')}</Badge>
                      ) : (
                        <>
                          <Badge tone={STATE_TONE[current.state]}>
                            {label('consentStates', current.state)}
                          </Badge>{' '}
                          <span className="muted">
                            {t('messaging.address', { address: current.address })}
                          </span>
                        </>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {manage && (
              <div className="row">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRecording(true);
                  }}
                >
                  {t('messaging.record')}
                </Button>
              </div>
            )}
            {recording && (
              <ConsentDialog
                partyId={partyId}
                consents={view}
                onClose={() => {
                  setRecording(false);
                }}
              />
            )}
            <h3 className="subheading">{t('messaging.recent')}</h3>
            <QueryState query={messages} error="messaging.error">
              {(list) =>
                list.length === 0 ? (
                  <p className="muted">{t('messaging.noMessages')}</p>
                ) : (
                  <ul className="record-list">
                    {list.slice(0, 5).map((message) => (
                      <li key={message.id}>
                        <span className="record-list__title">
                          {label('messageTemplates', message.templateKey)}{' '}
                          <Badge tone={MESSAGE_TONE[message.status]}>
                            {label('messageStatus', message.status)}
                          </Badge>
                        </span>
                        <span className="record-list__meta">
                          {t('messaging.messageMeta', {
                            channel: label('messageChannels', message.channel),
                            to: message.toAddress,
                            when: dateTime(message.createdAt),
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              }
            </QueryState>
          </div>
        )}
      </QueryState>
    </Card>
  );
}
