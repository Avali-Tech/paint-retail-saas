import { Button, Card } from '@paint/ui';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import type { Preview } from './preview.js';

/** Why the counter cannot show the tax: the message for each engine refusal. */
const REASONS: Partial<Record<string, MessageKey>> = {
  no_rate: 'pos.totals.noRate',
  composition_inter_state: 'pos.totals.interState',
};

/** The live total (spec §5.2): taxable value, tax by rate, round-off and what to pay. */
export function TotalsPanel({
  preview,
  lineCount,
  exclusive,
  onHold,
  onPay,
  holding,
  payReady,
}: {
  readonly preview: Preview;
  readonly lineCount: number;
  /** Prices are before GST (the business's setting); counter prices usually include it. */
  readonly exclusive: boolean;
  readonly onHold: () => void;
  readonly onPay: () => void;
  readonly holding: boolean;
  /**
   * The ways to pay are known. Paying waits for them, so the button stays disabled
   * until then rather than ignoring a click (as after a reload, while they load).
   */
  readonly payReady: boolean;
}) {
  const { t, money, number, plural } = useI18n();
  const rate = (basisPoints: number) => number(basisPoints / 100);
  const reason =
    preview.ok || preview.reason === 'empty' || preview.reason === 'unregistered'
      ? null
      : (REASONS[preview.reason] ?? 'pos.totals.noTax');

  const rows: [string, number][] = [];
  if (preview.ok) {
    const { invoice } = preview;
    rows.push([t('pos.totals.taxable'), invoice.totals.taxablePaise]);
    for (const row of invoice.taxSummary) {
      if (invoice.supplyType === 'inter_state') {
        rows.push([
          t('pos.totals.tax', { label: 'IGST', rate: rate(row.rateBasisPoints) }),
          row.igstPaise,
        ]);
      } else {
        const half = rate(row.rateBasisPoints / 2);
        rows.push([t('pos.totals.tax', { label: 'CGST', rate: half }), row.cgstPaise]);
        rows.push([
          t('pos.totals.tax', { label: invoice.stateTaxLabel, rate: half }),
          row.sgstPaise,
        ]);
      }
    }
    rows.push([t('pos.totals.roundOff'), invoice.totals.roundOffPaise]);
  }

  return (
    <Card title={t('pos.totals.title')} className="pos-totals">
      <div className="stack">
        <dl className="pos-totals__rows">
          {rows.map(([label, paise]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="numeric">{money(paise)}</dd>
            </div>
          ))}
          <div className="pos-totals__grand">
            <dt>
              {t('pos.totals.total')} · {plural('pos.lines.count', lineCount)}
            </dt>
            <dd className="numeric" data-testid="pos-total">
              {money(preview.payablePaise)}
            </dd>
          </div>
        </dl>
        <p className="muted">
          {preview.ok && preview.invoice.documentType === 'bill_of_supply'
            ? t('pos.totals.billOfSupply')
            : exclusive
              ? t('pos.totals.exclusive')
              : t('pos.totals.inclusive')}
        </p>
        {reason !== null && (
          <p className="pos-totals__note" role="status">
            {t(reason)}
          </p>
        )}
        <div className="pos-totals__actions">
          <Button variant="secondary" loading={holding} onClick={onHold}>
            {t('pos.totals.hold')}
          </Button>
          <Button disabled={lineCount === 0 || !payReady} onClick={onPay}>
            {t('pos.totals.pay', { amount: money(preview.payablePaise) })}
          </Button>
        </div>
      </div>
    </Card>
  );
}
