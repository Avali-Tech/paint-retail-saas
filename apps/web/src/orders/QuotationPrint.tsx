import { amountInWords, type QuotationView } from '@paint/shared';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/i18n.js';
import { stateLabel } from '../lib/gst-states.js';
import { TintSummary } from '../tint/TintSummary.js';
import '../print/print.css';

// A quotation on A4 paper, drawn with round 2b's invoice print styles. "Save as PDF"
// in the print dialog gives the PDF to share. It is an offer, never a tax invoice,
// so it carries no Rule 46 heading or copy mark.

/** One request to print: a new `id` prints again. */
export interface QuotationPrintJob {
  readonly id: number;
  readonly quotation: QuotationView;
  readonly businessName: string;
  readonly storeName: string | null;
}

function QuotationA4({ job }: { readonly job: QuotationPrintJob }) {
  const { t, money, number, date } = useI18n();
  const { quotation } = job;
  const taxes: [string, number][] = [
    [t('sales.totals.cgst'), quotation.cgstPaise],
    [t('sales.totals.sgst'), quotation.sgstPaise],
    [t('sales.totals.igst'), quotation.igstPaise],
  ];
  const shipTo = [
    quotation.shipTo.name,
    quotation.shipTo.address,
    quotation.shipTo.stateCode === null ? null : stateLabel(quotation.shipTo.stateCode),
  ].filter((part) => part !== null);
  return (
    <article className="invoice invoice--a4" aria-label={t('orders.print.label')}>
      <header className="invoice__header">
        <div className="invoice__brand">
          <p className="invoice__business">{job.businessName}</p>
          {job.storeName !== null && <p>{job.storeName}</p>}
        </div>
        <div className="invoice__heading">
          <h2 className="invoice__title">{t('orders.print.title')}</h2>
          <p className="invoice__strong">
            {t('orders.quotation.title', { number: quotation.number, version: quotation.version })}
          </p>
          <p>{t('orders.print.date', { date: date(quotation.pricedOn) })}</p>
          <p>{t('orders.print.validUntil', { date: date(quotation.validUntil) })}</p>
        </div>
      </header>
      <div className="invoice__parties">
        <div>
          <h3 className="invoice__party-title">{t('orders.print.to')}</h3>
          <p className="invoice__strong">{quotation.billTo.name}</p>
          {quotation.billTo.gstin !== null && (
            <p>{t('orders.print.gstin', { gstin: quotation.billTo.gstin })}</p>
          )}
          {quotation.billTo.phone !== null && <p>{quotation.billTo.phone}</p>}
        </div>
        {(quotation.project !== null || shipTo.length > 0) && (
          <div>
            <h3 className="invoice__party-title">{t('orders.print.site')}</h3>
            {quotation.project !== null && <p>{quotation.project.name}</p>}
            {shipTo.map((part) => (
              <p key={part}>{part}</p>
            ))}
          </div>
        )}
      </div>
      <table className="invoice__lines">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{t('sales.lines.item')}</th>
            <th scope="col">{t('sales.lines.hsn')}</th>
            <th scope="col" className="invoice__num">
              {t('sales.lines.quantity')}
            </th>
            <th scope="col" className="invoice__num">
              {t('orders.print.price')}
            </th>
            <th scope="col" className="invoice__num">
              {t('sales.lines.taxable')}
            </th>
            <th scope="col" className="invoice__num">
              {t('sales.lines.rate')}
            </th>
            <th scope="col" className="invoice__num">
              {t('sales.lines.total')}
            </th>
          </tr>
        </thead>
        <tbody>
          {quotation.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.lineNo}</td>
              <th scope="row">
                {line.description}
                {line.tint !== undefined && (
                  <TintSummary tint={line.tint} base={line.description} />
                )}
              </th>
              <td>{line.hsnCode ?? ''}</td>
              <td className="invoice__num">{number(line.quantity)}</td>
              <td className="invoice__num">{money(line.unitPricePaise)}</td>
              <td className="invoice__num">{money(line.taxablePaise)}</td>
              <td className="invoice__num">
                {line.rateBps === null
                  ? ''
                  : t('sales.lines.ratePercent', { rate: number(line.rateBps / 100) })}
              </td>
              <td className="invoice__num">{money(line.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="invoice__summary">
        <div>
          <dt>{t('sales.totals.taxable')}</dt>
          <dd className="invoice__num">{money(quotation.taxablePaise)}</dd>
        </div>
        {taxes
          .filter(([, paise]) => paise !== 0)
          .map(([name, paise]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd className="invoice__num">{money(paise)}</dd>
            </div>
          ))}
        <div>
          <dt>{t('sales.totals.roundOff')}</dt>
          <dd className="invoice__num">{money(quotation.roundOffPaise)}</dd>
        </div>
        <div>
          <dt className="invoice__strong">{t('sales.totals.total')}</dt>
          <dd className="invoice__num invoice__strong">{money(quotation.totalPaise)}</dd>
        </div>
      </dl>
      <p>{amountInWords(quotation.totalPaise)}</p>
      {quotation.note !== null && <p>{quotation.note}</p>}
      <p className="invoice__notice">{t('orders.print.notInvoice')}</p>
    </article>
  );
}

/** The print layer: renders the quotation, then opens the print dialog. */
export function QuotationPrintSlot({ job }: { readonly job: QuotationPrintJob | null }) {
  useEffect(() => {
    if (job !== null) window.print();
  }, [job]);
  if (job === null) return null;
  return createPortal(
    <div className="orders-print" data-testid="quotation-print">
      <QuotationA4 job={job} />
    </div>,
    document.body,
  );
}
