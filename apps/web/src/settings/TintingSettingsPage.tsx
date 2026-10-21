import type { SalesSettingsView } from '@paint/shared';
import { Button, Card, Field, Input, PageHeader, useToast } from '@paint/ui';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { SALES_SETTINGS_KEY } from './InvoicePrintSettingsPage.js';

// Settings, Tinting (round 8a): how many ml one "shot" and one "Y" of the tinting
// machine dose, so a formula in shots or Y can take its colorant out of stock.

/** ml in one machine unit: "" is not set; otherwise more than 0, at most 100, 4 decimals. */
export function parseUnitMl(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value > 0 && value <= 100 ? value : undefined;
}

function TintingForm({ settings }: { readonly settings: SalesSettingsView }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [shot, setShot] = useState(settings.tintShotMl === null ? '' : String(settings.tintShotMl));
  const [y, setY] = useState(settings.tintYMl === null ? '' : String(settings.tintYMl));
  const [problems, setProblems] = useState<{ shot?: boolean; y?: boolean }>({});
  const [saving, setSaving] = useState(false);
  return (
    <Card>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const tintShotMl = parseUnitMl(shot);
          const tintYMl = parseUnitMl(y);
          const found = { shot: tintShotMl === undefined, y: tintYMl === undefined };
          setProblems(found);
          if (tintShotMl === undefined || tintYMl === undefined) return;
          setSaving(true);
          void api.sales
            .saveSettings({ tintShotMl, tintYMl })
            .then(async (saved) => {
              queryClient.setQueryData(SALES_SETTINGS_KEY, saved);
              await queryClient.invalidateQueries({ queryKey: SALES_SETTINGS_KEY });
              toast({ title: t('tint.settings.saved'), tone: 'success' });
            })
            .catch((error: unknown) => {
              toast({ title: errorMessage(error), tone: 'danger' });
            })
            .finally(() => {
              setSaving(false);
            });
        }}
      >
        <Field
          label={t('tint.settings.shot')}
          hint={t('tint.settings.hint')}
          error={problems.shot === true ? t('tint.settings.invalid') : undefined}
        >
          <Input
            inputMode="decimal"
            value={shot}
            onChange={(event) => {
              setShot(event.target.value);
            }}
          />
        </Field>
        <Field
          label={t('tint.settings.y')}
          hint={t('tint.settings.hint')}
          error={problems.y === true ? t('tint.settings.invalid') : undefined}
        >
          <Input
            inputMode="decimal"
            value={y}
            onChange={(event) => {
              setY(event.target.value);
            }}
          />
        </Field>
        <div className="row">
          <Button type="submit" loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** /settings/tinting — the tinting machine's units. */
export function TintingSettingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: SALES_SETTINGS_KEY,
    queryFn: ({ signal }) => api.sales.settings(signal),
  });
  return (
    <>
      <PageHeader title={t('tint.settings.title')} description={t('tint.settings.description')} />
      <QueryState query={settings} error="tint.settings.error">
        {(data) => <TintingForm settings={data} />}
      </QueryState>
    </>
  );
}
