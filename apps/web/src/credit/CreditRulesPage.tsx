import { zodResolver } from '@hookform/resolvers/zod';
import type { CreditRules } from '@paint/shared';
import { Alert, Button, Card, Field, Input, PageHeader, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { wholeNumber } from '../lib/numbers.js';
import { QueryState } from '../lib/QueryState.js';

export const rulesKey = ['credit-rules'] as const;

function rulesSchema(t: I18n['t']) {
  return z
    .object({
      normalUpToPercent: wholeNumber(0, 1000, t('creditRules.percentInvalid')),
      managerUpToPercent: wholeNumber(0, 1000, t('creditRules.percentInvalid')),
      holdAfterOverdueDays: wholeNumber(1, 3650, t('creditRules.daysInvalid')),
    })
    .refine((rules) => rules.normalUpToPercent <= rules.managerUpToPercent, {
      path: ['managerUpToPercent'],
      message: t('creditRules.order'),
    });
}

type Schema = ReturnType<typeof rulesSchema>;
const FIELDS = ['normalUpToPercent', 'managerUpToPercent', 'holdAfterOverdueDays'] as const;

const asText = (rules: CreditRules) => ({
  normalUpToPercent: String(rules.normalUpToPercent),
  managerUpToPercent: String(rules.managerUpToPercent),
  holdAfterOverdueDays: String(rules.holdAfterOverdueDays),
});

function RulesForm({ rules }: { readonly rules: CreditRules }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editable = usePermissions()('credit:approve');
  const schema = useMemo(() => rulesSchema(t), [t]);
  const form = useForm<z.input<Schema>, unknown, z.output<Schema>>({
    resolver: zodResolver(schema),
    defaultValues: asText(rules),
  });
  const [message, setMessage] = useState<string | null>(null);
  const { errors, isSubmitting } = form.formState;

  const save = async (values: CreditRules) => {
    setMessage(null);
    try {
      const saved = await api.credit.setRules(values);
      queryClient.setQueryData(rulesKey, saved);
      form.reset(asText(saved));
      toast({ title: t('creditRules.saved'), tone: 'success' });
    } catch (error) {
      setMessage(showApiError(error, FIELDS, form.setError));
    }
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(save)(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {!editable && <Alert tone="info">{t('creditRules.readOnly')}</Alert>}
      <Card>
        <fieldset className="plain-fieldset form-grid" disabled={!editable}>
          <Field
            label={t('creditRules.normal')}
            hint={t('creditRules.normalHint')}
            error={errors.normalUpToPercent?.message}
          >
            <Input inputMode="numeric" {...form.register('normalUpToPercent')} />
          </Field>
          <Field
            label={t('creditRules.manager')}
            hint={t('creditRules.managerHint')}
            error={errors.managerUpToPercent?.message}
          >
            <Input inputMode="numeric" {...form.register('managerUpToPercent')} />
          </Field>
          <Field
            label={t('creditRules.overdue')}
            hint={t('creditRules.overdueHint')}
            error={errors.holdAfterOverdueDays?.message}
          >
            <Input inputMode="numeric" {...form.register('holdAfterOverdueDays')} />
          </Field>
        </fieldset>
      </Card>
      {editable && (
        <div className="row row--end">
          <Button type="submit" loading={isSubmitting}>
            {t('creditRules.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

/** /settings/credit — when a sale on credit goes ahead, needs approval or is blocked. */
export function CreditRulesPage() {
  const api = useApi();
  const { t } = useI18n();
  const rules = useQuery({
    queryKey: rulesKey,
    queryFn: ({ signal }) => api.credit.rules(signal),
  });
  return (
    <>
      <PageHeader title={t('creditRules.title')} description={t('creditRules.description')} />
      <QueryState query={rules} error="creditRules.error">
        {(data) => <RulesForm rules={data} />}
      </QueryState>
    </>
  );
}
