import { Field, Input, Textarea } from '@paint/ui';
import { useI18n } from '../i18n/i18n.js';

export interface RequestValues {
  /** The limit in rupees, as typed. */
  readonly limit: string;
  readonly days: string;
  readonly note: string;
}

/** The fields of a credit request: limit in rupees, days to pay and why (checked by readRequest). */
export function RequestFields({
  values,
  onChange,
}: {
  readonly values: RequestValues;
  readonly onChange: (values: RequestValues) => void;
}) {
  const { t } = useI18n();
  const set = (field: keyof RequestValues, value: string) => {
    onChange({ ...values, [field]: value });
  };
  return (
    <>
      <Field label={t('credit.limitLabel')}>
        <Input
          inputMode="decimal"
          value={values.limit}
          onChange={(event) => {
            set('limit', event.target.value);
          }}
        />
      </Field>
      <Field label={t('credit.daysLabel')}>
        <Input
          inputMode="numeric"
          value={values.days}
          onChange={(event) => {
            set('days', event.target.value);
          }}
        />
      </Field>
      <Field label={t('credit.note')}>
        <Textarea
          value={values.note}
          onChange={(event) => {
            set('note', event.target.value);
          }}
        />
      </Field>
    </>
  );
}
