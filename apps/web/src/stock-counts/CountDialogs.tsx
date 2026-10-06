import { Checkbox, Field, Select } from '@paint/ui';
import { useState } from 'react';
import { VARIANCE_REASONS, type StockCount, type VarianceReason } from '../api/stock-counts.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';

export function SubmitDialog({
  count,
  onSubmit,
  onClose,
}: {
  readonly count: StockCount;
  readonly onSubmit: (uncountedAsZero: boolean) => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const { t, plural } = useI18n();
  const [asZero, setAsZero] = useState(false);
  const { uncountedLines } = count.summary;
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('stockCounts.detail.submitTitle', { number: count.number })}
      description={t('stockCounts.detail.submitDescription')}
      submitLabel={t('stockCounts.detail.submit')}
      onSubmit={async () => {
        await onSubmit(asZero);
        return undefined;
      }}
    >
      {uncountedLines > 0 && (
        <p className="notice">{plural('stockCounts.detail.uncounted', uncountedLines)}</p>
      )}
      <Checkbox
        label={t('stockCounts.detail.uncountedAsZero')}
        checked={asZero}
        onChange={(event) => {
          setAsZero(event.target.checked);
        }}
      />
    </FormDialog>
  );
}

/** Approves a submitted count, with a reason for each difference. */
export function ApproveDialog({
  count,
  onSubmit,
  onClose,
}: {
  readonly count: StockCount;
  readonly onSubmit: (reasons: { variantId: string; reason: VarianceReason }[]) => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const { t, label, number } = useI18n();
  const differing = count.lines.filter((line) => line.variance !== null && line.variance !== 0);
  const [reasons, setReasons] = useState<Record<string, string>>(() =>
    Object.fromEntries(differing.map((line) => [line.variantId, line.reason ?? ''])),
  );
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('stockCounts.detail.approveTitle', { number: count.number })}
      description={t('stockCounts.detail.approveDescription')}
      submitLabel={t('stockCounts.detail.approve')}
      onSubmit={async () => {
        await onSubmit(
          differing.flatMap((line) => {
            const reason = VARIANCE_REASONS.find((value) => value === reasons[line.variantId]);
            return reason === undefined ? [] : [{ variantId: line.variantId, reason }];
          }),
        );
        return undefined;
      }}
    >
      {differing.length === 0 ? (
        <p>{t('stockCounts.detail.noDifferences')}</p>
      ) : (
        differing.map((line) => (
          <Field
            key={line.variantId}
            label={t('stockCounts.detail.reasonOf', { sku: line.sku })}
            hint={`${line.brandName} ${line.productName} · ${t('stockCounts.detail.variance')} ${number(Number(line.variance))}`}
          >
            <Select
              value={reasons[line.variantId]}
              onChange={(event) => {
                const value = event.target.value;
                setReasons((current) => ({ ...current, [line.variantId]: value }));
              }}
            >
              <option value="">{t('stockCounts.detail.noReason')}</option>
              {VARIANCE_REASONS.map((value) => (
                <option key={value} value={value}>
                  {label('varianceReason', value)}
                </option>
              ))}
            </Select>
          </Field>
        ))
      )}
    </FormDialog>
  );
}
