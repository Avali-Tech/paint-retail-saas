import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@paint/ui';
import {
  MESSAGE_CHANNELS,
  MESSAGE_LANGUAGES,
  TEMPLATE_KEYS,
  TEMPLATE_MAX_LENGTH,
  type MessageChannel,
  type MessageLanguage,
  type TemplateKey,
  type TemplateView,
} from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorWithIssues } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile } from '../auth/session.js';
import { LOCALES, useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import {
  previewOf,
  sampleVariables,
  templateIssues,
  type TemplateIssue,
} from './template-preview.js';

const TEMPLATES_KEY = ['message-templates'] as const;
const PROVIDER_NAME = /^[a-z0-9_]{1,200}$/;

/** One template's wording: edit it, see it filled in, save it or go back to the product's. */
function TemplateEditor({ template }: { readonly template: TemplateView }) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();
  const [body, setBody] = useState(template.body);
  const [providerName, setProviderName] = useState(template.providerTemplateName ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<'save' | 'reset' | null>(null);
  // Where the cursor was last in the wording: a detail is added there.
  const [caret, setCaret] = useState(template.body.length);
  const whatsapp = template.channel === 'whatsapp';
  const issues = templateIssues(template.key, body);
  const badName =
    whatsapp && providerName.trim() !== '' && !PROVIDER_NAME.test(providerName.trim());
  const changed =
    body !== template.body || providerName.trim() !== (template.providerTemplateName ?? '');
  const preview = previewOf(
    body,
    template.channel,
    sampleVariables(template.language, {
      name: t('templates.sampleName'),
      business: profile.organization.name,
      link: 'https://example.com/s/AB12CD',
    }),
  );

  const describe = (issue: TemplateIssue) =>
    issue.kind === 'empty'
      ? t('templates.empty')
      : issue.kind === 'tooLong'
        ? t('templates.tooLong', { max: String(issue.max) })
        : t('templates.unknown', { name: `{{${issue.name}}}` });

  /** Puts `{{name}}` where the cursor was, and the cursor after it. */
  const insert = (name: string) => {
    const at = Math.min(caret, body.length);
    const variable = `{{${name}}}`;
    setBody(`${body.slice(0, at)}${variable}${body.slice(at)}`);
    setCaret(at + variable.length);
  };

  const run = async (kind: 'save' | 'reset', call: () => Promise<TemplateView[]>) => {
    setPending(kind);
    setMessage(null);
    try {
      queryClient.setQueryData(TEMPLATES_KEY, await call());
      toast({
        title: t(kind === 'save' ? 'templates.saved' : 'templates.resetDone'),
        tone: 'success',
      });
    } catch (error) {
      setMessage(errorWithIssues(error));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card
      title={t('templates.wording')}
      actions={
        <Badge tone={template.custom ? 'primary' : 'neutral'}>
          {t(template.custom ? 'templates.custom' : 'templates.standard')}
        </Badge>
      }
    >
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run('save', () =>
            api.messaging.saveTemplate({
              key: template.key,
              channel: template.channel,
              language: template.language,
              body: body.trim(),
              providerTemplateName:
                whatsapp && providerName.trim() !== '' ? providerName.trim() : null,
            }),
          );
        }}
      >
        {whatsapp && <Alert tone="warning">{t('templates.whatsappRule')}</Alert>}
        <Field
          label={t('templates.body')}
          hint={t('templates.length', {
            count: String(body.length),
            max: String(TEMPLATE_MAX_LENGTH),
          })}
        >
          <Textarea
            rows={5}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart);
            }}
          />
        </Field>
        <div className="stack">
          <p className="cell-meta">{t('templates.variablesHint')}</p>
          <div className="row" role="group" aria-label={t('templates.variables')}>
            {template.variables.map((name) => (
              <Button
                key={name}
                size="sm"
                variant="secondary"
                aria-label={t('templates.insert', { name: `{{${name}}}` })}
                onClick={() => {
                  insert(name);
                }}
              >
                {`{{${name}}}`}
              </Button>
            ))}
          </div>
        </div>
        {issues.length > 0 && (
          <Alert tone="danger">
            <ul>
              {issues.map((issue) => (
                <li key={describe(issue)}>{describe(issue)}</li>
              ))}
            </ul>
          </Alert>
        )}
        {whatsapp && (
          <Field
            label={t('templates.providerName')}
            hint={t('templates.providerNameHint')}
            error={badName ? t('templates.providerNameInvalid') : undefined}
          >
            <Input
              value={providerName}
              onChange={(event) => {
                setProviderName(event.target.value);
              }}
            />
          </Field>
        )}
        <section className="stack" aria-label={t('templates.preview')}>
          <h3>{t('templates.preview')}</h3>
          {preview.subject !== null && (
            <p>
              <strong>{t('templates.subject')}</strong> {preview.subject}
            </p>
          )}
          <p className="template-preview" lang={LOCALES[template.language].lang}>
            {preview.text}
          </p>
          <p className="cell-meta">
            {t('templates.sampleNote', { channel: label('messageChannels', template.channel) })}
          </p>
        </section>
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <div className="row row--end">
          {template.custom && (
            <Button
              variant="secondary"
              loading={pending === 'reset'}
              onClick={() => {
                void run('reset', () =>
                  api.messaging.resetTemplate(template.key, template.channel, template.language),
                );
              }}
            >
              {t('templates.reset')}
            </Button>
          )}
          <Button
            type="submit"
            loading={pending === 'save'}
            disabled={!changed || issues.length > 0 || badName}
          >
            {t('templates.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * /settings/messages — the messages the business sends customers, per purpose, channel
 * and language (en / hi / te): reworded with only the template's own variables (MSG-4,
 * MSG-5), previewed with sample data, or reset to the product's wording.
 */
export function MessageTemplatesPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const [key, setKey] = useState<TemplateKey>('invoice_issued');
  const [channel, setChannel] = useState<MessageChannel>('whatsapp');
  const [language, setLanguage] = useState<MessageLanguage>('en');
  const templates = useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: ({ signal }) => api.messaging.templates(signal),
  });
  return (
    <>
      <PageHeader title={t('templates.title')} description={t('templates.description')} />
      <Card>
        <div className="stack">
          <div className="filters" role="group" aria-label={t('templates.choose')}>
            <Field label={t('templates.message')}>
              <Select
                value={key}
                onChange={(event) => {
                  setKey(event.target.value as TemplateKey);
                }}
              >
                {TEMPLATE_KEYS.map((value) => (
                  <option key={value} value={value}>
                    {label('messageTemplates', value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('templates.channel')}>
              <Select
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as MessageChannel);
                }}
              >
                {MESSAGE_CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {label('messageChannels', value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('templates.language')}>
              <Select
                value={language}
                onChange={(event) => {
                  setLanguage(event.target.value as MessageLanguage);
                }}
              >
                {MESSAGE_LANGUAGES.map((value) => (
                  <option key={value} value={value}>
                    {LOCALES[value].label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="cell-meta">{t('templates.dataRule')}</p>
        </div>
      </Card>
      <QueryState query={templates} error="templates.error">
        {(list) => {
          const template = list.find(
            (row) => row.key === key && row.channel === channel && row.language === language,
          );
          return template === undefined ? (
            <Alert tone="info">{t('templates.missing')}</Alert>
          ) : (
            <TemplateEditor
              // A new template, or new wording from the server, starts the editor again.
              key={`${key}:${channel}:${language}:${template.body}:${String(template.custom)}`}
              template={template}
            />
          );
        }}
      </QueryState>
    </>
  );
}
