import { Button, Field, Input, useToast } from '@paint/ui';
import type { ProfitabilitySettings } from '@paint/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { costOfMoneyBps, hundredths, pointValuePaise } from './profitability-input.js';

/**
 * The business's cost of money and point value, which every profitability figure
 * uses unless a view picks another (owners and admins).
 */
export function SettingsDialog({ settings }: { readonly settings: ProfitabilitySettings }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [money, setMoney] = useState('');
  const [point, setPoint] = useState('');
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setMoney(hundredths(settings.costOfMoneyBps));
          setPoint(hundredths(settings.pointValuePaise));
          setOpen(true);
        }}
      >
        {t('brandProfitability.settings.open')}
      </Button>
      <FormDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t('brandProfitability.settings.title')}
        description={t('brandProfitability.settings.description')}
        submitLabel={t('brandProfitability.settings.save')}
        onSubmit={async () => {
          const bps = costOfMoneyBps(money);
          const paise = pointValuePaise(point);
          if (bps === undefined || paise === undefined) {
            return t('brandProfitability.settings.invalid');
          }
          await api.brandProfitability.saveSettings({
            costOfMoneyBps: bps,
            pointValuePaise: paise,
          });
          await queries.invalidateQueries({ queryKey: ['brand-profitability'] });
          toast({ title: t('brandProfitability.settings.saved'), tone: 'success' });
          return undefined;
        }}
      >
        <Field label={t('brandProfitability.costOfMoney')}>
          <Input
            inputMode="decimal"
            value={money}
            onChange={(event) => {
              setMoney(event.target.value);
            }}
          />
        </Field>
        <Field
          label={t('brandProfitability.settings.pointValue')}
          hint={t('brandProfitability.settings.pointValueHint')}
        >
          <Input
            inputMode="decimal"
            value={point}
            onChange={(event) => {
              setPoint(event.target.value);
            }}
          />
        </Field>
      </FormDialog>
    </>
  );
}
