import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Card, Field, Input, PageHeader, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import type { LoyaltySettings } from '../api/loyalty.js';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { parseRupees, rupeesInput } from '../lib/inputs.js';
import { wholeNumber } from '../lib/numbers.js';
import { QueryState } from '../lib/QueryState.js';

export const settingsKey = ['loyalty-settings'] as const;
export const MAX_TIERS = 10;

/** A field-array index as React Hook Form paths spell it ("tiers.0.name"). */
const slot = (index: number) => String(index) as `${number}`;

const unique = (values: readonly (string | number)[]) => new Set(values).size === values.length;

function settingsSchema(t: I18n['t']) {
  return z.object({
    earnPoints: wholeNumber(1, 1000, t('loyaltySettings.earnPointsInvalid')),
    // Typed in rupees, sent in paise: ₹1 to ₹1 lakh.
    earnPerPaise: z.string().transform((value, context) => {
      const paise = parseRupees(value);
      if (paise === null || paise < 100 || paise > 10_000_000) {
        context.addIssue({ code: 'custom', message: t('loyaltySettings.earnPerInvalid') });
        return z.NEVER;
      }
      return paise;
    }),
    expiryDays: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === '' || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 3650),
        t('loyaltySettings.expiryInvalid'),
      )
      .transform((value) => (value === '' ? null : Number(value))),
    minRedemptionPoints: wholeNumber(0, 10_000_000, t('loyaltySettings.minimumInvalid')),
    tiers: z
      .array(
        z.object({
          name: z
            .string()
            .trim()
            .min(1, t('loyaltySettings.tierNameInvalid'))
            .max(40, t('loyaltySettings.tierNameInvalid')),
          minPoints: wholeNumber(0, 100_000_000, t('loyaltySettings.tierPointsInvalid')),
        }),
      )
      .max(MAX_TIERS)
      .refine(
        (tiers) => unique(tiers.map((tier) => tier.name.toLowerCase())),
        t('loyaltySettings.tierNamesUnique'),
      )
      .refine(
        (tiers) => unique(tiers.map((tier) => tier.minPoints)),
        t('loyaltySettings.tierPointsUnique'),
      ),
  });
}

type Schema = ReturnType<typeof settingsSchema>;
const FIELDS = ['earnPoints', 'earnPerPaise', 'expiryDays', 'minRedemptionPoints'] as const;

const asText = (settings: LoyaltySettings): z.input<Schema> => ({
  earnPoints: String(settings.earnPoints),
  earnPerPaise: rupeesInput(settings.earnPerPaise),
  expiryDays: settings.expiryDays === null ? '' : String(settings.expiryDays),
  minRedemptionPoints: String(settings.minRedemptionPoints),
  tiers: settings.tiers.map((tier) => ({ name: tier.name, minPoints: String(tier.minPoints) })),
});

function SettingsForm({ settings }: { readonly settings: LoyaltySettings }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const manage = usePermissions()('loyalty:manage');
  const { allStores } = useCurrentProfile();
  const editable = manage && allStores;
  const schema = useMemo(() => settingsSchema(t), [t]);
  const form = useForm<z.input<Schema>, unknown, z.output<Schema>>({
    resolver: zodResolver(schema),
    defaultValues: asText(settings),
  });
  const tiers = useFieldArray({ control: form.control, name: 'tiers' });
  const [message, setMessage] = useState<string | null>(null);
  const { errors, isSubmitting } = form.formState;

  const save = async (values: LoyaltySettings) => {
    setMessage(null);
    try {
      const saved = await api.loyalty.setSettings(values);
      queryClient.setQueryData(settingsKey, saved);
      form.reset(asText(saved));
      toast({ title: t('loyaltySettings.saved'), tone: 'success' });
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
      {!editable && (
        <Alert tone="info">
          {t(manage ? 'loyaltySettings.allStoresOnly' : 'loyaltySettings.readOnly')}
        </Alert>
      )}
      <fieldset className="plain-fieldset stack" disabled={!editable}>
        <Card title={t('loyaltySettings.earning')}>
          <div className="form-grid">
            <Field label={t('loyaltySettings.earnPoints')} error={errors.earnPoints?.message}>
              <Input inputMode="numeric" {...form.register('earnPoints')} />
            </Field>
            <Field
              label={t('loyaltySettings.earnPer')}
              hint={t('loyaltySettings.earnPerHint')}
              error={errors.earnPerPaise?.message}
            >
              <Input inputMode="decimal" {...form.register('earnPerPaise')} />
            </Field>
            <Field
              label={t('loyaltySettings.expiry')}
              hint={t('loyaltySettings.expiryHint')}
              error={errors.expiryDays?.message}
            >
              <Input inputMode="numeric" {...form.register('expiryDays')} />
            </Field>
            <Field label={t('loyaltySettings.minimum')} error={errors.minRedemptionPoints?.message}>
              <Input inputMode="numeric" {...form.register('minRedemptionPoints')} />
            </Field>
          </div>
        </Card>
        <Card title={t('loyaltySettings.tiers')}>
          <div className="stack">
            <p className="muted">{t('loyaltySettings.tiersHint')}</p>
            {tiers.fields.map((tier, index) => (
              <div key={tier.id} className="tier-row">
                <Field
                  label={t('loyaltySettings.tierName', { number: index + 1 })}
                  error={errors.tiers?.[index]?.name?.message}
                >
                  <Input {...form.register(`tiers.${slot(index)}.name`)} />
                </Field>
                <Field
                  label={t('loyaltySettings.tierPoints', { number: index + 1 })}
                  error={errors.tiers?.[index]?.minPoints?.message}
                >
                  <Input inputMode="numeric" {...form.register(`tiers.${slot(index)}.minPoints`)} />
                </Field>
                <Button
                  variant="ghost"
                  onClick={() => {
                    tiers.remove(index);
                  }}
                >
                  {t('loyaltySettings.removeTier', { number: index + 1 })}
                </Button>
              </div>
            ))}
            {errors.tiers?.root?.message !== undefined && (
              <p className="ui-field__error" role="alert">
                {errors.tiers.root.message}
              </p>
            )}
            {tiers.fields.length < MAX_TIERS && (
              <div className="row">
                <Button
                  variant="secondary"
                  onClick={() => {
                    tiers.append({ name: '', minPoints: '' });
                  }}
                >
                  {t('loyaltySettings.addTier')}
                </Button>
              </div>
            )}
          </div>
        </Card>
      </fieldset>
      {editable && (
        <div className="row row--end">
          <Button type="submit" loading={isSubmitting}>
            {t('loyaltySettings.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

/** /settings/loyalty — how points are earned, tiers, expiry and the minimum to redeem. */
export function LoyaltySettingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => api.loyalty.settings(signal),
  });
  return (
    <>
      <PageHeader
        title={t('loyaltySettings.title')}
        description={t('loyaltySettings.description')}
      />
      <QueryState query={settings} error="loyaltySettings.error">
        {(data) => <SettingsForm settings={data} />}
      </QueryState>
    </>
  );
}
