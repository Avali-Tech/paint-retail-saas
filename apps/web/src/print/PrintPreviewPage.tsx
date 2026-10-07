import { sampleInvoiceView, type SampleInvoiceOptions, type SecondLanguage } from '@paint/shared';
import { Alert, Button, Checkbox, Field, PageHeader, Select } from '@paint/ui';
import { useMemo, useState } from 'react';
import { LOCALES, useI18n } from '../i18n/i18n.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { useIdentity } from '../theme/IdentityProvider.js';
import { InvoiceA4 } from './InvoiceA4.js';
import { InvoiceThermal } from './InvoiceThermal.js';
import './print.css';

export const PRINT_FORMATS = ['a4', 'thermal'] as const;
export type PrintFormat = (typeof PRINT_FORMATS)[number];
const SAMPLES = ['b2b', 'b2bInter', 'b2c', 'billOfSupply'] as const;
type Sample = (typeof SAMPLES)[number];
const COPIES = ['none', 'original', 'duplicate', 'triplicate'] as const;
type Copy = (typeof COPIES)[number];

const SAMPLE_OPTIONS: Readonly<Record<Sample, SampleInvoiceOptions>> = {
  b2b: { buyer: 'b2b' },
  b2bInter: { buyer: 'b2b_inter' },
  b2c: { buyer: 'b2c' },
  billOfSupply: { buyer: 'b2c', kind: 'bill_of_supply' },
};

/**
 * A sample invoice in the business's own name and logo, as it prints on A4 and on
 * an 80 mm counter printer, with the browser's print button. Round 3 prints issued
 * invoices with the same templates.
 */
export function PrintPreviewPage() {
  const { t } = useI18n();
  const { branding } = useBranding();
  const { logoSrc } = useIdentity();
  const [format, setFormat] = useState<PrintFormat>('a4');
  const [sample, setSample] = useState<Sample>('b2b');
  const [second, setSecond] = useState<SecondLanguage | 'none'>('none');
  const [copy, setCopy] = useState<Copy>('original');
  const [long, setLong] = useState(false);

  const view = useMemo(
    () =>
      sampleInvoiceView({
        ...SAMPLE_OPTIONS[sample],
        secondLanguage: second === 'none' ? null : second,
        copy: copy === 'none' ? null : copy,
        lineCount: long ? 40 : undefined,
        businessName: branding.appName,
        logoUrl: logoSrc,
      }),
    [sample, second, copy, long, branding.appName, logoSrc],
  );

  return (
    <div className="stack invoice-preview">
      <div className="no-print">
        <PageHeader
          title={t('print.title')}
          description={t('print.description')}
          actions={
            <Button
              onClick={() => {
                window.print();
              }}
            >
              {t('print.print')}
            </Button>
          }
        />
      </div>
      <div className="no-print">
        <Alert tone="info">{t('print.sampleNotice')}</Alert>
      </div>
      <form className="invoice-preview__options no-print" aria-label={t('print.options')}>
        <Field label={t('print.format')}>
          <Select
            value={format}
            onChange={(event) => {
              setFormat(event.target.value as PrintFormat);
            }}
          >
            {PRINT_FORMATS.map((value) => (
              <option key={value} value={value}>
                {t(`print.formats.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('print.sample')}>
          <Select
            value={sample}
            onChange={(event) => {
              setSample(event.target.value as Sample);
            }}
          >
            {SAMPLES.map((value) => (
              <option key={value} value={value}>
                {t(`print.samples.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('print.secondLanguage')}>
          <Select
            value={second}
            onChange={(event) => {
              setSecond(event.target.value as SecondLanguage | 'none');
            }}
          >
            <option value="none">{t('print.noSecondLanguage')}</option>
            <option value="hi">{LOCALES.hi.label}</option>
            <option value="te">{LOCALES.te.label}</option>
          </Select>
        </Field>
        <Field label={t('print.copy')}>
          <Select
            value={copy}
            onChange={(event) => {
              setCopy(event.target.value as Copy);
            }}
          >
            {COPIES.map((value) => (
              <option key={value} value={value}>
                {t(`print.copies.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label={t('print.longInvoice')}
          checked={long}
          onChange={(event) => {
            setLong(event.target.checked);
          }}
        />
      </form>
      <div className={`invoice-preview__paper invoice-preview__paper--${format}`}>
        {format === 'a4' ? <InvoiceA4 view={view} /> : <InvoiceThermal view={view} />}
      </div>
    </div>
  );
}
