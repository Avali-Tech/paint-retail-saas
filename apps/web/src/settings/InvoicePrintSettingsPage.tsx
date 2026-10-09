import {
  INVOICE_TERMS_MAX,
  INVOICE_TERM_MAX_LENGTH,
  isValidBankAccount,
  isValidIfsc,
  isValidUpiId,
  type PrintBankDetails,
  type SalesSettingsView,
} from '@paint/shared';
import { Alert, Button, Card, Field, Input, PageHeader, Textarea, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import type { InvoicePrintSettingsInput } from '../api/sales.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';

// Settings, Invoice print (spec §5.4): the bank details and terms the A4 invoice
// prints, kept in the sales settings. The logo comes from Appearance.

export const SALES_SETTINGS_KEY = ['sales-settings'] as const;

export interface InvoicePrintForm {
  readonly bankName: string;
  readonly accountName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
  readonly upiId: string;
  /** One term per line. */
  readonly terms: string;
}

export type InvoicePrintProblem =
  | 'incomplete'
  | 'accountNumber'
  | 'ifsc'
  | 'upiId'
  | 'upiWithoutBank'
  | 'tooManyTerms'
  | 'termTooLong';
export type InvoicePrintProblems = Partial<
  Record<'bank' | 'accountNumber' | 'ifsc' | 'upiId' | 'terms', InvoicePrintProblem>
>;

/** The form filled from the saved settings. */
export function printFormOf(settings: SalesSettingsView): InvoicePrintForm {
  const bank = settings.invoiceBank;
  return {
    bankName: bank?.bankName ?? '',
    accountName: bank?.accountName ?? '',
    accountNumber: bank?.accountNumber ?? '',
    ifsc: bank?.ifsc ?? '',
    upiId: bank?.upiId ?? '',
    terms: settings.invoiceTerms.join('\n'),
  };
}

/**
 * The form checked as the API checks it: the four bank fields together or none, a
 * UPI ID only with them, at most INVOICE_TERMS_MAX terms (blank lines dropped).
 */
export function parsePrintForm(
  form: InvoicePrintForm,
): { ok: true; input: InvoicePrintSettingsInput } | { ok: false; problems: InvoicePrintProblems } {
  const problems: InvoicePrintProblems = {};
  const [bankName, accountName, accountNumber, upiId] = [
    form.bankName,
    form.accountName,
    form.accountNumber,
    form.upiId,
  ].map((value) => value.trim()) as [string, string, string, string];
  const ifsc = form.ifsc.trim().toUpperCase();
  const filled = [bankName, accountName, accountNumber, ifsc].filter((value) => value !== '');
  if (filled.length > 0 && filled.length < 4) problems.bank = 'incomplete';
  if (accountNumber !== '' && !isValidBankAccount(accountNumber)) {
    problems.accountNumber = 'accountNumber';
  }
  if (ifsc !== '' && !isValidIfsc(ifsc)) problems.ifsc = 'ifsc';
  if (upiId !== '' && !isValidUpiId(upiId)) problems.upiId = 'upiId';
  else if (upiId !== '' && filled.length === 0) problems.upiId = 'upiWithoutBank';
  const terms = form.terms
    .split('\n')
    .map((term) => term.trim())
    .filter((term) => term !== '');
  if (terms.length > INVOICE_TERMS_MAX) problems.terms = 'tooManyTerms';
  else if (terms.some((term) => term.length > INVOICE_TERM_MAX_LENGTH)) {
    problems.terms = 'termTooLong';
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const invoiceBank: PrintBankDetails | null =
    filled.length === 0
      ? null
      : { bankName, accountName, accountNumber, ifsc, upiId: upiId === '' ? null : upiId };
  return { ok: true, input: { invoiceBank, invoiceTerms: terms } };
}

function PrintSettingsForm({ settings }: { readonly settings: SalesSettingsView }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => printFormOf(settings));
  const [problems, setProblems] = useState<InvoicePrintProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const limits = { max: INVOICE_TERMS_MAX, length: INVOICE_TERM_MAX_LENGTH };
  const problem = (field: keyof InvoicePrintProblems) => {
    const code = problems[field];
    return code === undefined ? undefined : t(`print.settings.problems.${code}`, limits);
  };
  const set = (field: keyof InvoicePrintForm) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };
  const save = async () => {
    const parsed = parsePrintForm(form);
    if (!parsed.ok) {
      setProblems(parsed.problems);
      return;
    }
    setProblems({});
    setMessage(null);
    setPending(true);
    try {
      const saved = await api.sales.saveSettings(parsed.input);
      queryClient.setQueryData(SALES_SETTINGS_KEY, saved);
      setForm(printFormOf(saved));
      toast({ title: t('print.settings.saved'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const text = (
    field: 'bankName' | 'accountName' | 'accountNumber' | 'ifsc' | 'upiId',
    error: string | undefined,
    hint?: string,
  ) => (
    <Field label={t(`print.settings.bank.${field}`)} error={error} hint={hint}>
      <Input
        value={form[field]}
        maxLength={120}
        onChange={(event) => {
          set(field)(event.target.value);
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
        void save();
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Card title={t('print.settings.bank.title')}>
        <div className="stack">
          <p className="muted">{t('print.settings.bank.description')}</p>
          {problems.bank !== undefined && <Alert tone="danger">{problem('bank')}</Alert>}
          <div className="form-grid">
            {text('bankName', undefined)}
            {text('accountName', undefined)}
            {text('accountNumber', problem('accountNumber'))}
            {text('ifsc', problem('ifsc'))}
            {text('upiId', problem('upiId'), t('print.settings.bank.upiHint'))}
          </div>
        </div>
      </Card>
      <Card title={t('print.settings.terms.title')}>
        <Field
          label={t('print.settings.terms.label')}
          hint={t('print.settings.terms.hint', limits)}
          error={problem('terms')}
        >
          <Textarea
            value={form.terms}
            rows={5}
            onChange={(event) => {
              set('terms')(event.target.value);
            }}
          />
        </Field>
      </Card>
      <div className="row row--end">
        <Button type="submit" loading={pending}>
          {t('print.settings.save')}
        </Button>
      </div>
    </form>
  );
}

/** /settings/invoice-print: the bank details and terms printed on invoices (owners). */
export function InvoicePrintSettingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: SALES_SETTINGS_KEY,
    queryFn: ({ signal }) => api.sales.settings(signal),
  });
  return (
    <>
      <PageHeader title={t('print.settings.title')} description={t('print.settings.description')} />
      <QueryState query={settings} error="print.settings.error">
        {(data) => <PrintSettingsForm settings={data} />}
      </QueryState>
    </>
  );
}
