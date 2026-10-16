import {
  LINK_AMOUNT_BASES,
  MAX_LINK_CAP_PAISE,
  MAX_LINK_VALIDITY_MINUTES,
  MIN_LINK_CAP_PAISE,
  MIN_LINK_VALIDITY_MINUTES,
  RAZORPAY_KEY_ID_PATTERN,
  type GatewayAccountView,
  type LinkAmountBasis,
  type PaymentLinkSettings,
} from '@paint/shared';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { CopyLinkButton, PAYMENT_LINK_SETTINGS_KEY } from './PaymentLinks.js';

// Settings, Payment links (P2-M32, [PO-40] – [PO-43]): owners and admins connect the
// business's own Razorpay account (keys never shown again, only their last four
// characters) and set how long links stay payable, their cap and what they ask for.

const GATEWAY_ACCOUNT_KEY = ['payment-link-gateway-account'] as const;

/** What a rules form says is wrong, by field. */
export type RulesProblems = Partial<Record<'validityMinutes' | 'cap', 'range'>>;

/** The rules form checked as the API checks it. */
export function parseRules(form: {
  readonly validityMinutes: string;
  readonly cap: string;
  readonly amountBasis: LinkAmountBasis;
}):
  | { ok: true; input: { validityMinutes: number; capPaise: number; amountBasis: LinkAmountBasis } }
  | { ok: false; problems: RulesProblems } {
  const problems: RulesProblems = {};
  const minutes = /^\d+$/.test(form.validityMinutes.trim()) ? Number(form.validityMinutes) : NaN;
  if (!(minutes >= MIN_LINK_VALIDITY_MINUTES && minutes <= MAX_LINK_VALIDITY_MINUTES)) {
    problems.validityMinutes = 'range';
  }
  const cap = parseRupees(form.cap);
  if (cap === null || cap < MIN_LINK_CAP_PAISE || cap > MAX_LINK_CAP_PAISE) problems.cap = 'range';
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return {
    ok: true,
    input: { validityMinutes: minutes, capPaise: Number(cap), amountBasis: form.amountBasis },
  };
}

function RulesForm({ settings }: { readonly settings: PaymentLinkSettings }) {
  const api = useApi();
  const { t, money } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    validityMinutes: String(settings.validityMinutes),
    cap: rupeesInput(settings.capPaise),
    amountBasis: settings.amountBasis,
  });
  const [problems, setProblems] = useState<RulesProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = async () => {
    const parsed = parseRules(form);
    if (!parsed.ok) {
      setProblems(parsed.problems);
      return;
    }
    setProblems({});
    setMessage(null);
    setPending(true);
    try {
      const saved = await api.paymentLinks.saveSettings(parsed.input);
      queryClient.setQueryData(PAYMENT_LINK_SETTINGS_KEY, saved);
      toast({ title: t('paymentLinkSettings.saved'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Card title={t('paymentLinkSettings.rules.title')}>
        <div className="stack">
          {message !== null && <Alert tone="danger">{message}</Alert>}
          <div className="form-grid">
            <Field
              label={t('paymentLinkSettings.rules.validity')}
              hint={t('paymentLinkSettings.rules.validityHint')}
              error={
                problems.validityMinutes === undefined
                  ? undefined
                  : t('paymentLinkSettings.rules.validityRange', {
                      min: String(MIN_LINK_VALIDITY_MINUTES),
                      max: String(MAX_LINK_VALIDITY_MINUTES),
                    })
              }
            >
              <Input
                inputMode="numeric"
                value={form.validityMinutes}
                onChange={(event) => {
                  setForm({ ...form, validityMinutes: event.target.value });
                }}
              />
            </Field>
            <Field
              label={t('paymentLinkSettings.rules.cap')}
              hint={t('paymentLinkSettings.rules.capHint', { max: money(MAX_LINK_CAP_PAISE) })}
              error={
                problems.cap === undefined
                  ? undefined
                  : t('paymentLinkSettings.rules.capRange', {
                      min: money(MIN_LINK_CAP_PAISE),
                      max: money(MAX_LINK_CAP_PAISE),
                    })
              }
            >
              <Input
                inputMode="decimal"
                value={form.cap}
                onChange={(event) => {
                  setForm({ ...form, cap: event.target.value });
                }}
              />
            </Field>
            <Field
              label={t('paymentLinkSettings.rules.basis')}
              hint={t(`paymentLinkSettings.rules.basisHint.${form.amountBasis}`)}
            >
              <Select
                value={form.amountBasis}
                onChange={(event) => {
                  setForm({ ...form, amountBasis: event.target.value as LinkAmountBasis });
                }}
              >
                {LINK_AMOUNT_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {t(`paymentLinkSettings.rules.basisOption.${basis}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="row row--end">
            <Button type="submit" loading={pending}>
              {t('paymentLinkSettings.rules.save')}
            </Button>
          </div>
        </div>
      </Card>
    </form>
  );
}

/** The connect (or replace) form: the three keys from Razorpay's dashboard. */
function ConnectForm({ connected }: { readonly connected: boolean }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const empty = { keyId: '', keySecret: '', webhookSecret: '' };
  const [form, setForm] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async () => {
    const keyId = form.keyId.trim();
    if (
      !RAZORPAY_KEY_ID_PATTERN.test(keyId) ||
      form.keySecret.trim() === '' ||
      form.webhookSecret.length < 8
    ) {
      setProblem(t('paymentLinkSettings.connect.incomplete'));
      return;
    }
    setProblem(null);
    setPending(true);
    try {
      const account = await api.paymentLinks.connectGateway({
        keyId,
        keySecret: form.keySecret.trim(),
        webhookSecret: form.webhookSecret,
      });
      // The keys leave the page as soon as they are kept.
      setForm(empty);
      queryClient.setQueryData(GATEWAY_ACCOUNT_KEY, account);
      await queryClient.invalidateQueries({ queryKey: PAYMENT_LINK_SETTINGS_KEY });
      toast({ title: t('paymentLinkSettings.connect.done'), tone: 'success' });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const field = (name: keyof typeof empty, secret: boolean) => (
    <Field label={t(`paymentLinkSettings.connect.${name}`)}>
      <Input
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={form[name]}
        onChange={(event) => {
          setForm({ ...form, [name]: event.target.value });
        }}
      />
    </Field>
  );
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {problem !== null && <Alert tone="danger">{problem}</Alert>}
      <div className="form-grid">
        {field('keyId', false)}
        {field('keySecret', true)}
        {field('webhookSecret', true)}
      </div>
      <div className="row row--end">
        <Button type="submit" loading={pending}>
          {t(
            connected
              ? 'paymentLinkSettings.connect.replace'
              : 'paymentLinkSettings.connect.submit',
          )}
        </Button>
      </div>
    </form>
  );
}

/** A connected account has every hint. */
const masked = (hint: string | null) => `••••${String(hint)}`;

function AccountCard({ account }: { readonly account: GatewayAccountView }) {
  const api = useApi();
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>, done: MessageKey) => {
    setMessage(null);
    void work()
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: GATEWAY_ACCOUNT_KEY });
        await queryClient.invalidateQueries({ queryKey: PAYMENT_LINK_SETTINGS_KEY });
        toast({ title: t(done), tone: 'success' });
      })
      .catch((error: unknown) => {
        setMessage(errorMessage(error));
      });
  };
  return (
    <Card
      title={t('paymentLinkSettings.account.title')}
      actions={
        account.connected ? (
          <Badge tone="success">
            {t(
              account.live === true
                ? 'paymentLinkSettings.account.connectedLive'
                : 'paymentLinkSettings.account.connectedTest',
            )}
          </Badge>
        ) : (
          <Badge tone="neutral">{t('paymentLinkSettings.account.notConnected')}</Badge>
        )
      }
    >
      <div className="stack">
        <p className="muted">{t('paymentLinkSettings.account.description')}</p>
        {message !== null && <Alert tone="danger">{message}</Alert>}
        {account.connected && (
          <>
            {account.live !== true && (
              <Alert tone="warning">{t('paymentLinkSettings.account.testWarning')}</Alert>
            )}
            <dl className="facts">
              <dt>{t('paymentLinkSettings.connect.keyId')}</dt>
              <dd>
                <code>{masked(account.keyIdHint)}</code>
              </dd>
              <dt>{t('paymentLinkSettings.connect.keySecret')}</dt>
              <dd>
                <code>{masked(account.keySecretHint)}</code>
              </dd>
              <dt>{t('paymentLinkSettings.connect.webhookSecret')}</dt>
              <dd>
                <code>{masked(account.webhookSecretHint)}</code>
              </dd>
              <dt>{t('paymentLinkSettings.account.connectedBy')}</dt>
              <dd>
                {account.connectedBy ?? '—'} · {dateTime(String(account.connectedAt))}
              </dd>
              <dt>{t('paymentLinkSettings.account.verifiedAt')}</dt>
              <dd>{account.verifiedAt === null ? '—' : dateTime(account.verifiedAt)}</dd>
            </dl>
            <div className="row row--end">
              <Button
                variant="secondary"
                onClick={() => {
                  run(() => api.paymentLinks.testGateway(), 'paymentLinkSettings.account.tested');
                }}
              >
                {t('paymentLinkSettings.account.test')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  run(
                    () => api.paymentLinks.disconnectGateway(),
                    'paymentLinkSettings.account.disconnected',
                  );
                }}
              >
                {t('paymentLinkSettings.account.disconnect')}
              </Button>
            </div>
          </>
        )}
        <div className="stack">
          <h3 className="subheading">{t('paymentLinkSettings.webhook.title')}</h3>
          <p className="muted">{t('paymentLinkSettings.webhook.description')}</p>
          <div className="row">
            <code className="break-all">{account.webhookUrl}</code>
            <CopyLinkButton
              link={{ number: t('paymentLinkSettings.webhook.name'), url: account.webhookUrl }}
            />
          </div>
          <p className="muted">{t('paymentLinkSettings.webhook.events')}</p>
        </div>
        <ConnectForm connected={account.connected} />
      </div>
    </Card>
  );
}

function GatewaySection({ settings }: { readonly settings: PaymentLinkSettings }) {
  const api = useApi();
  const { t } = useI18n();
  const account = useQuery({
    queryKey: GATEWAY_ACCOUNT_KEY,
    queryFn: ({ signal }) => api.paymentLinks.gatewayAccount(signal),
    enabled: settings.provider === 'razorpay',
  });
  if (settings.provider === null) {
    return <Alert tone="info">{t('paymentLinkSettings.off')}</Alert>;
  }
  if (settings.provider === 'log') {
    return <Alert tone="info">{t('paymentLinkSettings.logGateway')}</Alert>;
  }
  return (
    <QueryState query={account} error="paymentLinkSettings.error">
      {(data) => <AccountCard account={data} />}
    </QueryState>
  );
}

/** /settings/payment-links: the business's Razorpay account and link rules (owners and admins). */
export function PaymentLinkSettingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: PAYMENT_LINK_SETTINGS_KEY,
    queryFn: ({ signal }) => api.paymentLinks.settings(signal),
  });
  return (
    <>
      <PageHeader
        title={t('paymentLinkSettings.title')}
        description={t('paymentLinkSettings.description')}
      />
      <QueryState query={settings} error="paymentLinkSettings.error">
        {(data) => (
          <div className="stack">
            <GatewaySection settings={data} />
            <RulesForm settings={data} />
          </div>
        )}
      </QueryState>
    </>
  );
}
