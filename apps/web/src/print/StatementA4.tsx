import type { PrintLabel, StatementView } from '@paint/shared';
import { InvoiceLabel } from './InvoiceLabel.js';

/**
 * A party's statement of account on A4 (roadmap P2-M12), drawn from the shared view
 * as the API's PDF is: the business and the customer, the opening balance, every
 * entry with its running balance, the totals and the closing balance, then the
 * ageing on the last day and the bills still due. Long statements break across
 * pages with the table's running header and column headings on every page.
 */
export function StatementA4({ view }: { readonly view: StatementView }) {
  const { labels, business, party } = view;
  const lang = view.secondLanguage ?? undefined;
  const label = (printLabel: PrintLabel) => <InvoiceLabel label={printLabel} lang={lang} />;
  const facts: [PrintLabel, string][] = [
    [labels.period, view.period],
    [labels.date, view.generatedOn],
    [labels.openingBalance, view.opening],
    [labels.closingBalance, view.closing],
  ];
  return (
    <article
      className="invoice invoice--a4 statement"
      aria-label={`${labels.statement.text} · ${party.name}`}
    >
      <header className="invoice__header">
        <div className="invoice__brand">
          <div>
            <p className="invoice__business">{business.name}</p>
            {business.legalName !== null && <p>{business.legalName}</p>}
            {business.address !== null && <p>{business.address}</p>}
            {business.gstin !== null && (
              <p>
                {labels.gstin.text}: {business.gstin}
              </p>
            )}
          </div>
        </div>
        <div className="invoice__heading">
          <h2 className="invoice__title">{label(labels.statement)}</h2>
        </div>
      </header>

      <section className="invoice__parties" aria-label={labels.customer.text}>
        <div>
          <h3 className="invoice__party-title">{label(labels.customer)}</h3>
          <p className="invoice__strong">{party.name}</p>
          {party.phone !== null && (
            <p>
              {labels.phone.text}: {party.phone}
            </p>
          )}
          {party.gstin !== null && (
            <p>
              {labels.gstin.text}: {party.gstin}
            </p>
          )}
          {party.address !== null && <p>{party.address}</p>}
        </div>
        <dl className="invoice__facts">
          {facts.map(([factLabel, value]) => (
            <div key={factLabel.text}>
              <dt>{label(factLabel)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {view.rows.length === 0 ? (
        <p className="invoice__notice">{label(labels.noEntries)}</p>
      ) : (
        <table className="invoice__lines">
          <thead>
            <tr className="invoice__running">
              <th colSpan={6}>{`${business.name} · ${labels.statement.text} · ${party.name}`}</th>
            </tr>
            <tr>
              <th scope="col">{label(labels.date)}</th>
              <th scope="col">{label(labels.particulars)}</th>
              <th scope="col">{label(labels.reference)}</th>
              <th scope="col" className="invoice__num">
                {label(labels.debit)}
              </th>
              <th scope="col" className="invoice__num">
                {label(labels.credit)}
              </th>
              <th scope="col" className="invoice__num">
                {label(labels.balance)}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, index) => (
              // Rows have no id of their own; their order is the ledger's.
              <tr key={index}>
                <td>{row.date}</td>
                <th scope="row">
                  {row.particulars}
                  {row.note !== null && <span className="invoice__variant">{row.note}</span>}
                </th>
                <td>{row.reference ?? ''}</td>
                <td className="invoice__num">{row.debit}</td>
                <td className="invoice__num">{row.credit}</td>
                <td className="invoice__num">{row.balance}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3} className="invoice__num">
                {label(labels.total)}
              </th>
              <td className="invoice__num invoice__strong">{view.totalDebit}</td>
              <td className="invoice__num invoice__strong">{view.totalCredit}</td>
              <td className="invoice__num invoice__strong">{view.closing}</td>
            </tr>
          </tfoot>
        </table>
      )}

      <section className="statement__ageing" aria-label={labels.ageing.text}>
        <h3 className="invoice__party-title">
          {label(labels.ageing)} · {view.ageingOn}
        </h3>
        <dl className="invoice__totals">
          {view.ageing.map((row) => (
            <div key={row.key} className={row.strong ? 'invoice__strong' : undefined}>
              <dt>{label(row.label)}</dt>
              <dd className="invoice__num">{row.amount}</dd>
            </div>
          ))}
        </dl>
      </section>

      {view.openItems.length > 0 && (
        <section aria-label={labels.openItems.text}>
          <h3 className="invoice__party-title">{label(labels.openItems)}</h3>
          <table className="invoice__lines">
            <thead>
              <tr>
                <th scope="col">{label(labels.reference)}</th>
                <th scope="col">{label(labels.date)}</th>
                <th scope="col">{label(labels.dueOn)}</th>
                <th scope="col" className="invoice__num">
                  {label(labels.daysPastDue)}
                </th>
                <th scope="col" className="invoice__num">
                  {label(labels.amountDue)}
                </th>
              </tr>
            </thead>
            <tbody>
              {view.openItems.map((item, index) => (
                <tr key={index}>
                  <th scope="row">{item.reference}</th>
                  <td>{item.date}</td>
                  <td>{item.dueOn}</td>
                  <td className="invoice__num">{item.daysPastDue}</td>
                  <td className="invoice__num">{item.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="invoice__terms">{label(labels.computerGenerated)}</p>
    </article>
  );
}
