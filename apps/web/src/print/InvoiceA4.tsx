import type { InvoiceView, LineView, PrintLabel } from '@paint/shared';
import { InvoiceLabel, InvoiceLogo, tintText, translationLang } from './InvoiceLabel.js';

interface Column {
  readonly key: string;
  readonly label: PrintLabel;
  readonly numeric: boolean;
  readonly value: (line: LineView) => string;
}

function columns(view: InvoiceView): Column[] {
  const { labels } = view;
  const taxed = view.taxColumns.length > 0;
  const discount = view.lines.some((line) => line.discount !== null);
  const all: (Column | null)[] = [
    { key: 'hsn', label: labels.hsn, numeric: false, value: (line) => line.hsn },
    {
      key: 'quantity',
      label: labels.quantity,
      numeric: true,
      value: (line) => `${line.quantity} ${line.uqc}`,
    },
    {
      key: 'price',
      label: view.pricesIncludeTax ? labels.priceInclusive : labels.price,
      numeric: true,
      value: (line) => line.price,
    },
    discount
      ? {
          key: 'discount',
          label: labels.discount,
          numeric: true,
          value: (line) => line.discount ?? '',
        }
      : null,
    {
      key: 'taxable',
      label: taxed ? labels.taxableValue : labels.value,
      numeric: true,
      value: (line) => line.taxable,
    },
    taxed
      ? { key: 'rate', label: labels.gstRate, numeric: true, value: (line) => String(line.rate) }
      : null,
    ...view.taxColumns.map((column): Column => ({
      key: column.key,
      label: { text: column.label, translation: null },
      numeric: true,
      value: (line) => String(line.taxes[column.key]),
    })),
    { key: 'amount', label: labels.amount, numeric: true, value: (line) => line.amount },
  ];
  return all.filter((column) => column !== null);
}

/**
 * The A4 invoice (Rule 46 header, line table, tax summary, totals, amount in words,
 * bank details, terms, signatory). Printed on A4 by the browser; long invoices break
 * across pages with the table's running header and column headings on every page.
 */
export function InvoiceA4({ view }: { readonly view: InvoiceView }) {
  const { labels, supplier, buyer } = view;
  const lang = translationLang(view);
  const label = (printLabel: PrintLabel) => <InvoiceLabel label={printLabel} lang={lang} />;
  const lineColumns = columns(view);
  const facts: [PrintLabel, string][] = [
    [view.kind === 'tax_invoice' ? labels.invoiceNumber : labels.billNumber, view.number],
    [labels.date, view.date],
    [labels.placeOfSupply, view.placeOfSupply],
  ];
  if (view.reverseCharge !== null) facts.push([labels.reverseCharge, view.reverseCharge]);

  return (
    <article className="invoice invoice--a4" aria-label={`${view.title.text} ${view.number}`}>
      <header className="invoice__header">
        <div className="invoice__brand">
          <InvoiceLogo src={view.business.logoUrl} />
          <div>
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
            {supplier.email !== null && <p>{supplier.email}</p>}
          </div>
        </div>
        <div className="invoice__heading">
          <h2 className="invoice__title">{label(view.title)}</h2>
          {view.copyMark !== null && <p className="invoice__copy">{view.copyMark}</p>}
        </div>
      </header>
      {view.compositionNotice !== null && (
        <p className="invoice__notice">{view.compositionNotice}</p>
      )}

      <section className="invoice__parties" aria-label={labels.billTo.text}>
        <dl className="invoice__facts">
          {facts.map(([factLabel, value]) => (
            <div key={factLabel.text}>
              <dt>{label(factLabel)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <h3 className="invoice__party-title">{label(labels.billTo)}</h3>
          <p className="invoice__strong">{buyer.name}</p>
          <p>
            {labels.gstin.text}: {buyer.gstin ?? labels.unregistered.text}
          </p>
          {buyer.addressLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {buyer.state !== null && (
            <p>
              {labels.state.text}: {buyer.state}
            </p>
          )}
          {buyer.phone !== null && (
            <p>
              {labels.phone.text}: {buyer.phone}
            </p>
          )}
          {view.shipTo !== null && (
            <>
              <h3 className="invoice__party-title">{label(labels.shipTo)}</h3>
              {view.shipTo.addressLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p>{view.shipTo.state}</p>
            </>
          )}
        </div>
      </section>

      <table className="invoice__lines" aria-label={labels.description.text}>
        <thead>
          {/* Printed at the top of every page of a long invoice. */}
          <tr className="invoice__running">
            <th scope="colgroup" colSpan={lineColumns.length + 2}>
              {view.business.name} · {view.title.text} {view.number}
            </th>
          </tr>
          <tr>
            <th scope="col" className="invoice__num">
              {label(labels.serialNumber)}
            </th>
            <th scope="col">{label(labels.description)}</th>
            {lineColumns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric ? 'invoice__num' : ''}>
                {label(column.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.lines.map((line) => (
            <tr key={line.serial}>
              <td className="invoice__num">{line.serial}</td>
              <th scope="row">
                {line.description}
                {line.variant !== null && (
                  <>
                    {' '}
                    <span className="invoice__variant">{line.variant}</span>
                  </>
                )}
                {line.tint !== null && (
                  <span className="invoice__tint">{tintText(line.tint, labels, false)}</span>
                )}
              </th>
              {lineColumns.map((column) => (
                <td key={column.key} className={column.numeric ? 'invoice__num' : ''}>
                  {column.value(line)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="invoice__summary">
        {view.taxSummary.length > 0 ? (
          <table className="invoice__tax-summary" aria-label={labels.taxSummary.text}>
            <thead>
              <tr>
                <th scope="col">{label(labels.rate)}</th>
                <th scope="col" className="invoice__num">
                  {label(labels.taxableValue)}
                </th>
                {view.taxColumns.map((column) => (
                  <th key={column.key} scope="col" className="invoice__num">
                    {column.label}
                  </th>
                ))}
                <th scope="col" className="invoice__num">
                  {label(labels.totalTax)}
                </th>
              </tr>
            </thead>
            <tbody>
              {view.taxSummary.map((row) => (
                <tr key={row.rate}>
                  <th scope="row">{row.rate}</th>
                  <td className="invoice__num">{row.taxable}</td>
                  {view.taxColumns.map((column) => (
                    <td key={column.key} className="invoice__num">
                      {row.taxes[column.key]}
                    </td>
                  ))}
                  <td className="invoice__num">{row.totalTax}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div />
        )}
        <dl className="invoice__totals">
          {view.totals.map((row) => (
            <div key={row.key} className={row.key === 'grandTotal' ? 'invoice__grand' : ''}>
              <dt>{label(row.label)}</dt>
              <dd>{row.key === 'grandTotal' ? view.grandTotal : row.amount}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="invoice__closing">
        <div className="invoice__texts">
          <section>
            <h3 className="invoice__party-title">{label(labels.amountInWords)}</h3>
            <p className="invoice__strong">{view.amountInWords}</p>
          </section>
          {view.notes.length > 0 && (
            <section>
              <h3 className="invoice__party-title">{label(labels.notes)}</h3>
              {view.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </section>
          )}
          {view.terms.length > 0 && (
            <section>
              <h3 className="invoice__party-title">{label(labels.terms)}</h3>
              <ol className="invoice__terms">
                {view.terms.map((term) => (
                  <li key={term}>{term}</li>
                ))}
              </ol>
            </section>
          )}
          {view.bank !== null && (
            <section>
              <h3 className="invoice__party-title">{label(labels.bankDetails)}</h3>
              <p>{view.bank.bankName}</p>
              <p>
                {view.bank.accountName} · {labels.bankAccount.text} {view.bank.accountNumber} ·{' '}
                {labels.ifsc.text} {view.bank.ifsc}
              </p>
              {view.bank.upiId !== null && (
                <p>
                  {labels.upi.text}: {view.bank.upiId}
                </p>
              )}
            </section>
          )}
        </div>
        <div className="invoice__signatory">
          <p className="invoice__strong">{view.signatory.forLine}</p>
          <p className="invoice__signature-space" />
          {view.signatory.name !== null && <p>{view.signatory.name}</p>}
          <p className="invoice__strong">{label(labels.authorisedSignatory)}</p>
        </div>
      </div>
    </article>
  );
}
