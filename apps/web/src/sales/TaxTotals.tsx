import { useI18n } from '../i18n/i18n.js';

export interface TaxTotalsValue {
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly roundOffPaise: number;
  readonly totalPaise: number;
}

/** Taxable value, each tax head, the round-off and the total of a document or a preview. */
export function TaxTotals({ totals }: { readonly totals: TaxTotalsValue }) {
  const { t, money } = useI18n();
  const rows: [string, number][] = [
    [t('sales.totals.taxable'), totals.taxablePaise],
    [t('sales.totals.cgst'), totals.cgstPaise],
    [t('sales.totals.sgst'), totals.sgstPaise],
    [t('sales.totals.igst'), totals.igstPaise],
    [t('sales.totals.roundOff'), totals.roundOffPaise],
    [t('sales.totals.total'), totals.totalPaise],
  ];
  return (
    <dl className="facts">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{money(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
