import type { InvoiceView, PrintLabel } from '@paint/shared';
import { InvoiceLabel, InvoiceLogo, tintText, translationLang } from './InvoiceLabel.js';

/**
 * The 80 mm counter receipt for browser printing: the same fields as the A4
 * invoice, one column wide (72 mm printable), with HSN and rate per line, the tax
 * summary by rate, round-off and the amount in words.
 */
export function InvoiceThermal({ view }: { readonly view: InvoiceView }) {
  const { labels, supplier, buyer } = view;
  const lang = translationLang(view);
  const label = (printLabel: PrintLabel) => <InvoiceLabel label={printLabel} lang={lang} />;
  const facts: [PrintLabel, string][] = [
    [view.kind === 'tax_invoice' ? labels.invoiceNumber : labels.billNumber, view.number],
    [labels.date, view.date],
    [labels.placeOfSupply, view.placeOfSupply],
  ];
  if (view.reverseCharge !== null) facts.push([labels.reverseCharge, view.reverseCharge]);

  return (
    <article className="invoice invoice--thermal" aria-label={`${view.title.text} ${view.number}`}>
      <header className="receipt__head">
        <InvoiceLogo src={view.business.logoUrl} />
        <p className="invoice__business">{view.business.name}</p>
        {view.business.name !== supplier.legalName && <p>{supplier.legalName}</p>}
        {supplier.addressLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p>{supplier.state}</p>
        <p>
          {labels.gstin.text}: {supplier.gstin}
        </p>
        {supplier.phone !== null && <p>{supplier.phone}</p>}
        <h2 className="invoice__title">{label(view.title)}</h2>
        {view.compositionNotice !== null && (
          <p className="invoice__notice">{view.compositionNotice}</p>
        )}
        {view.copyMark !== null && <p className="invoice__copy">{view.copyMark}</p>}
      </header>

      <dl className="receipt__rows">
        {facts.map(([factLabel, value]) => (
          <div key={factLabel.text}>
            <dt>{label(factLabel)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <section className="receipt__block" aria-label={labels.billTo.text}>
        <h3 className="invoice__party-title">{label(labels.billTo)}</h3>
        <p className="invoice__strong">{buyer.name}</p>
        {buyer.gstin !== null && (
          <p>
            {labels.gstin.text}: {buyer.gstin}
          </p>
        )}
        {buyer.addressLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {buyer.state !== null && <p>{buyer.state}</p>}
        {buyer.phone !== null && <p>{buyer.phone}</p>}
        {view.shipTo !== null && (
          <>
            <h3 className="invoice__party-title">{label(labels.shipTo)}</h3>
            <p>{[...view.shipTo.addressLines, view.shipTo.state].join(', ')}</p>
          </>
        )}
      </section>

      <ol className="receipt__items" aria-label={labels.description.text}>
        {view.lines.map((line) => (
          <li key={line.serial}>
            <p className="invoice__strong">
              {line.serial}. {line.description}
              {line.variant !== null && ` ${line.variant}`}
            </p>
            <p className="receipt__meta">
              {[
                line.hsn === '' ? null : `${labels.hsn.text} ${line.hsn}`,
                line.rate === null ? null : `GST ${line.rate}`,
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </p>
            {line.tint !== null && (
              <p className="receipt__meta receipt__tint">{tintText(line.tint, labels, true)}</p>
            )}
            <p className="receipt__pair">
              <span>
                {line.quantity} {line.uqc} × {line.price}
              </span>
              <span>{line.amount}</span>
            </p>
            {line.discount !== null && (
              <p className="receipt__pair receipt__meta">
                <span>{labels.discount.text}</span>
                <span>-{line.discount}</span>
              </p>
            )}
          </li>
        ))}
      </ol>

      <dl className="receipt__rows receipt__totals">
        {view.totals.map((row) => (
          <div key={row.key} className={row.key === 'grandTotal' ? 'invoice__grand' : ''}>
            <dt>{label(row.label)}</dt>
            <dd>{row.key === 'grandTotal' ? view.grandTotal : row.amount}</dd>
          </div>
        ))}
      </dl>

      {view.taxSummary.length > 0 && (
        <table className="receipt__tax" aria-label={labels.taxSummary.text}>
          <thead>
            <tr>
              <th scope="col">{labels.rate.text}</th>
              <th scope="col">{labels.taxableValue.text}</th>
              {view.taxColumns.map((column) => (
                <th key={column.key} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.taxSummary.map((row) => (
              <tr key={row.rate}>
                <th scope="row">{row.rate}</th>
                <td>{row.taxable}</td>
                {view.taxColumns.map((column) => (
                  <td key={column.key}>{row.taxes[column.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="receipt__block" aria-label={labels.amountInWords.text}>
        <p className="invoice__strong">{view.amountInWords}</p>
        {view.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        {view.terms.map((term) => (
          <p key={term}>{term}</p>
        ))}
      </section>

      <footer className="receipt__sign">
        <p>{view.signatory.forLine}</p>
        <p className="invoice__signature-space" />
        {view.signatory.name !== null && <p>{view.signatory.name}</p>}
        <p className="invoice__strong">{label(labels.authorisedSignatory)}</p>
      </footer>
    </article>
  );
}
