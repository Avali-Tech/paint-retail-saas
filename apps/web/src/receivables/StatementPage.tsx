import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  buttonStyle,
  useToast,
} from '@paint/ui';
import {
  buildStatementView,
  statementFileName,
  statementShareText,
  type PrintLanguage,
  type StatementData,
  type StatementShareResult,
} from '@paint/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { useUrlFilters } from '../lib/hooks.js';
import { todayInIndia } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import { whatsappLink } from '../orders/status.js';
import { StatementA4 } from '../print/StatementA4.js';
import '../print/print.css';
import { statementChoice, type StatementChoice } from './statement-logic.js';

const FILTERS = ['from', 'to', 'lang'] as const;
const LANGUAGES: readonly PrintLanguage[] = ['en', 'hi', 'te'];

/**
 * The statement's shared links (MVP 3 round 2a): when each was shared, whether it is
 * still open and how often it was opened, and revoking one that should stop working.
 */
function SharedLinks({ partyId }: { readonly partyId: string }) {
  const api = useApi();
  const { t, label, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const links = useQuery({
    queryKey: ['statement-links', partyId],
    queryFn: ({ signal }) => api.messaging.statementLinks(partyId, signal),
  });
  const list = links.data ?? [];
  return (
    <div className="stack">
      <h3 className="subheading">{t('statementShare.links')}</h3>
      {list.length === 0 ? (
        <p className="muted">{t('statementShare.noLinks')}</p>
      ) : (
        <ul className="record-list">
          {list.slice(0, 5).map((link) => (
            <li key={link.id}>
              <span className="record-list__title">
                {t('statementShare.linkMeta', {
                  from: date(link.from),
                  to: date(link.to),
                  status: label('linkStatus', link.status),
                  count: link.openedCount,
                })}
              </span>
              {link.status === 'active' && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('statementShare.revokeName', {
                    from: date(link.from),
                    to: date(link.to),
                  })}
                  onClick={() => {
                    void api.messaging
                      .revokeStatementLink(link.id)
                      .then(async () => {
                        await queryClient.invalidateQueries({ queryKey: ['statement-links'] });
                        toast({ title: t('statementShare.revoked'), tone: 'success' });
                      })
                      .catch((error: unknown) => {
                        toast({ title: errorMessage(error), tone: 'danger' });
                      });
                  }}
                >
                  {t('statementShare.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * With a WhatsApp provider (MVP 3 round 2a): one click stores a link to the statement
 * and queues the `statement_ready` message; without the customer's consent it offers
 * WhatsApp with the link instead.
 */
function SendOnWhatsApp({
  data,
  choice,
}: {
  readonly data: StatementData;
  readonly choice: StatementChoice;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<StatementShareResult | null>(null);
  const send = async () => {
    setBusy(true);
    try {
      const result = await api.messaging.shareStatement(data.party.id, {
        from: choice.from,
        to: choice.to,
        lang: choice.lang,
        send: 'whatsapp',
      });
      await queryClient.invalidateQueries({ queryKey: ['statement-links'] });
      if (result.message?.queued === true) {
        setShared(null);
        toast({ title: t('statementShare.sent'), tone: 'success' });
      } else {
        setShared(result);
      }
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        loading={busy}
        onClick={() => {
          void send();
        }}
      >
        {t('statementShare.send')}
      </Button>
      {shared !== null && (
        <Alert
          tone="warning"
          action={
            <a
              {...buttonStyle('secondary', 'sm')}
              href={
                shared.waMeUrl ??
                whatsappLink(
                  null,
                  statementShareText(
                    data,
                    choice.lang,
                    shared.url,
                    shared.paymentLink?.url ?? null,
                    shared.paymentLink?.amountPaise ?? null,
                  ),
                )
              }
              target="_blank"
              rel="noreferrer"
            >
              {t('statementShare.open')}
            </a>
          }
        >
          {t('statementShare.notSent')}
          <div>
            {t('statementShare.link')}: <code>{shared.url}</code>
          </div>
          {shared.paymentLink !== null && (
            <div>
              <code>{t('paymentLinks.statementLink', { url: shared.paymentLink.url })}</code>
            </div>
          )}
        </Alert>
      )}
    </>
  );
}

/** Download, print and the WhatsApp share: two clicks from the party, the second here. */
function ShareCard({
  data,
  choice,
}: {
  readonly data: StatementData;
  readonly choice: StatementChoice;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const period = { from: choice.from, to: choice.to };
  // A server without a WhatsApp provider (or an older one) keeps the wa.me share.
  const messaging = useQuery({
    queryKey: ['messaging-status'],
    queryFn: ({ signal }) => api.messaging.status(signal),
  });
  const provider = messaging.data?.whatsapp ?? null;

  /** The server's A4 PDF, saved through the browser; members only, no public link. */
  const download = async (after?: string) => {
    setBusy(true);
    try {
      const file = await api.receivables.statementPdf(data.party.id, period, choice.lang);
      saveFile(file.blob, file.fileName ?? statementFileName(data));
      if (after !== undefined) toast({ title: after, tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('statement.actions')} className="no-print">
      <div className="stack">
        <p className="muted">{t('statement.shareHint')}</p>
        {data.party.phone === null && <Alert tone="info">{t('statement.noPhone')}</Alert>}
        <div className="row">
          {provider === null ? (
            <a
              {...buttonStyle('primary')}
              href={whatsappLink(data.party.phone, statementShareText(data, choice.lang))}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                // WhatsApp opens through the link itself (no pop-up to block); the PDF to
                // attach is saved at the same time.
                void download(t('statement.saved'));
              }}
            >
              {t('statement.whatsapp')}
            </a>
          ) : (
            <SendOnWhatsApp data={data} choice={choice} />
          )}
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => {
              void download();
            }}
          >
            {t('statement.download')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              window.print();
            }}
          >
            {t('statement.print')}
          </Button>
        </div>
        {provider !== null && <SharedLinks partyId={data.party.id} />}
      </div>
    </Card>
  );
}

/** /parties/:id/statement — a party's statement for a period, to print, download or send. */
export function StatementPage() {
  const api = useApi();
  const { t, label, locale } = useI18n();
  // The route always has an :id.
  const id = String(useParams().id);
  const filters = useUrlFilters(FILTERS);
  const choice = statementChoice(filters.values, todayInIndia(), locale);
  const period = { from: choice.from, to: choice.to };
  const statement = useQuery({
    queryKey: ['statement', id, period],
    queryFn: ({ signal }) => api.receivables.statement(id, period, signal),
    enabled: !choice.backwards,
    placeholderData: keepPreviousData,
  });
  const name = statement.data?.party.name;
  return (
    <div className="invoice-preview">
      <div className="no-print">
        <PageHeader
          title={name === undefined ? t('statement.loadingTitle') : t('statement.title', { name })}
          description={t('statement.description')}
          actions={
            <span className="row">
              <Link to={`/parties/${id}/ledger`} {...buttonStyle('secondary')}>
                {t('statement.ledger')}
              </Link>
              {name !== undefined && (
                <Link to={`/parties/${id}`} {...buttonStyle('secondary')}>
                  {t('statement.back', { name })}
                </Link>
              )}
            </span>
          }
        />
        <Card>
          <div className="filters">
            <Field label={t('statement.from')}>
              <Input
                type="date"
                value={choice.from}
                onChange={(event) => {
                  filters.set('from', event.target.value);
                }}
              />
            </Field>
            <Field
              label={t('statement.to')}
              error={choice.backwards ? t('statement.rangeInvalid') : undefined}
            >
              <Input
                type="date"
                value={choice.to}
                onChange={(event) => {
                  filters.set('to', event.target.value);
                }}
              />
            </Field>
            <Field label={t('statement.language')}>
              <Select
                value={choice.lang}
                onChange={(event) => {
                  filters.set('lang', event.target.value);
                }}
              >
                {LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {label('statementLanguages', language)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      </div>
      {!choice.backwards && (
        <QueryState query={statement} error="statement.error">
          {(data) => (
            <>
              <ShareCard data={data} choice={choice} />
              {/* Focusable: on a phone the A4 sheet scrolls sideways inside it. */}
              <section
                className="invoice-preview__paper"
                aria-label={t('statement.preview')}
                tabIndex={0}
              >
                <StatementA4
                  view={buildStatementView(data, choice.lang === 'en' ? null : choice.lang)}
                />
              </section>
            </>
          )}
        </QueryState>
      )}
    </div>
  );
}
