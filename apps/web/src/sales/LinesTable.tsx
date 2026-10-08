import { Table } from '@paint/ui';
import type { TaxDocumentLineView } from '@paint/shared';
import { useI18n } from '../i18n/i18n.js';

/** The lines of an invoice or a note: item, HSN, quantity, rate and amounts. */
export function LinesTable({ lines }: { readonly lines: readonly TaxDocumentLineView[] }) {
  const { t, money, number } = useI18n();
  return (
    <Table label={t('sales.lines.title')}>
      <thead>
        <tr>
          <th scope="col">{t('sales.lines.item')}</th>
          <th scope="col">{t('sales.lines.hsn')}</th>
          <th scope="col">{t('sales.lines.quantity')}</th>
          <th scope="col">{t('sales.lines.rate')}</th>
          <th scope="col">{t('sales.lines.taxable')}</th>
          <th scope="col">{t('sales.lines.tax')}</th>
          <th scope="col">{t('sales.lines.total')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <th scope="row">{line.description ?? t('common.none')}</th>
            <td>{line.hsnCode ?? t('common.none')}</td>
            <td>{number(line.quantity)}</td>
            <td>
              {line.rateBps === null
                ? t('common.none')
                : t('sales.lines.ratePercent', { rate: number(line.rateBps / 100) })}
            </td>
            <td>{money(line.taxablePaise)}</td>
            <td>{money(line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise)}</td>
            <td>{money(line.totalPaise)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
