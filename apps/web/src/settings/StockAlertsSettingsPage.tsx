import { SLOW_MOVER_WINDOWS, type SalesSettingsView, type SlowMoverWindow } from '@paint/shared';
import { Button, Card, Field, Input, PageHeader, Select, useToast } from '@paint/ui';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { rupeesInput, parseRupees } from '../lib/inputs.js';
import { QueryState } from '../lib/QueryState.js';
import { SALES_SETTINGS_KEY } from './InvoicePrintSettingsPage.js';

// Settings, Stock alerts: after how many days without a sale or transfer out the
// store's stock staff are told about slow stock (once a day, once per product).

function StockAlertsForm({ settings }: { readonly settings: SalesSettingsView }) {
  const api = useApi();
  const { t, plural } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(
    settings.slowMoverAlertDays === null ? '' : String(settings.slowMoverAlertDays),
  );
  const [delivery, setDelivery] = useState(rupeesInput(settings.storeDeliveryCostPaise));
  const [deliveryInvalid, setDeliveryInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <Card>
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // The select offers only SLOW_MOVER_WINDOWS, or off.
          const slowMoverAlertDays = days === '' ? null : (Number(days) as SlowMoverWindow);
          // Blank: not set. Otherwise rupees, up to ₹1,00,000.
          const storeDeliveryCostPaise = delivery.trim() === '' ? null : parseRupees(delivery);
          const invalid =
            delivery.trim() !== '' &&
            (storeDeliveryCostPaise === null || storeDeliveryCostPaise > 10_000_000);
          setDeliveryInvalid(invalid);
          if (invalid) return;
          setSaving(true);
          void api.sales
            .saveSettings({ slowMoverAlertDays, storeDeliveryCostPaise })
            .then(async (saved) => {
              queryClient.setQueryData(SALES_SETTINGS_KEY, saved);
              await queryClient.invalidateQueries({ queryKey: SALES_SETTINGS_KEY });
              toast({ title: t('stockAlerts.saved'), tone: 'success' });
            })
            .catch((error: unknown) => {
              toast({ title: errorMessage(error), tone: 'danger' });
            })
            .finally(() => {
              setSaving(false);
            });
        }}
      >
        <Field label={t('stockAlerts.slowMovers')} hint={t('stockAlerts.slowMoversHint')}>
          <Select
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
            }}
          >
            <option value="">{t('stockAlerts.off')}</option>
            {SLOW_MOVER_WINDOWS.map((window) => (
              <option key={window} value={String(window)}>
                {plural('stockAlerts.after', window)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('stockAlerts.delivery')}
          hint={t('stockAlerts.deliveryHint')}
          error={deliveryInvalid ? t('stockAlerts.deliveryInvalid') : undefined}
        >
          <Input
            inputMode="decimal"
            value={delivery}
            onChange={(event) => {
              setDelivery(event.target.value);
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

/** /settings/stock-alerts — when slow stock is announced, and what bringing stock over costs. */
export function StockAlertsSettingsPage() {
  const api = useApi();
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: SALES_SETTINGS_KEY,
    queryFn: ({ signal }) => api.sales.settings(signal),
  });
  return (
    <>
      <PageHeader title={t('stockAlerts.title')} description={t('stockAlerts.description')} />
      <QueryState query={settings} error="stockAlerts.error">
        {(data) => <StockAlertsForm settings={data} />}
      </QueryState>
    </>
  );
}
