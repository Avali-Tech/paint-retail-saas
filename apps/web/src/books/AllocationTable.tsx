import { Alert, Button, Input, Table } from '@paint/ui';
import type { OpenDocumentView } from '@paint/shared';
import { useI18n } from '../i18n/i18n.js';
import { billKey, oldestFirst, type AllocationCheck, type AllocationTexts } from './allocation.js';

export interface AllocationTableProps {
  /** The customer's open bills, oldest first. */
  readonly bills: readonly OpenDocumentView[];
  /** The money to put against them. */
  readonly availablePaise: number;
  readonly texts: AllocationTexts;
  readonly onChange: (texts: AllocationTexts) => void;
  /** The amounts as checked (allocation.ts). */
  readonly check: AllocationCheck;
}

/**
 * The customer's open bills with an amount against each: filled oldest first, any
 * of them changed by hand; the total and what stays as an advance below.
 */
export function AllocationTable({
  bills,
  availablePaise,
  texts,
  onChange,
  check,
}: AllocationTableProps) {
  const { t, label, money, date } = useI18n();
  if (bills.length === 0) {
    return <Alert tone="info">{t('books.allocate.noBills')}</Alert>;
  }
  return (
    <div className="stack">
      <div className="row">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onChange(oldestFirst(bills, availablePaise));
          }}
        >
          {t('books.allocate.oldestFirst')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onChange({});
          }}
        >
          {t('books.allocate.clear')}
        </Button>
      </div>
      <Table label={t('books.allocate.bills')}>
        <thead>
          <tr>
            <th scope="col">{t('books.allocate.bill')}</th>
            <th scope="col">{t('books.allocate.due')}</th>
            <th scope="col" className="numeric">
              {t('books.allocate.outstanding')}
            </th>
            <th scope="col">{t('books.allocate.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {bills.map((bill) => {
            const key = billKey(bill);
            const name = bill.number ?? label('billKinds', bill.kind);
            const problem = check.problems[key];
            return (
              <tr key={key}>
                <th scope="row">
                  {name}
                  <span className="cell-meta">
                    {label('billKinds', bill.kind)} · {date(bill.issuedOn)}
                  </span>
                </th>
                <td>{bill.dueOn === null ? t('common.none') : date(bill.dueOn)}</td>
                <td className="numeric">{money(bill.outstandingPaise)}</td>
                <td>
                  <Input
                    inputMode="decimal"
                    aria-label={t('books.allocate.amountFor', { bill: name })}
                    aria-invalid={problem === undefined ? undefined : true}
                    value={texts[key] ?? ''}
                    onChange={(event) => {
                      onChange({ ...texts, [key]: event.target.value });
                    }}
                  />
                  {problem !== undefined && (
                    <p className="ui-field__error">
                      {problem === 'invalid'
                        ? t('books.allocate.invalid')
                        : t('books.allocate.tooMuch', { amount: money(bill.outstandingPaise) })}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <dl className="facts" aria-label={t('books.allocate.summary')}>
        <div>
          <dt>{t('books.allocate.allocated')}</dt>
          <dd>{money(check.allocatedPaise)}</dd>
        </div>
        <div>
          <dt>{t('books.allocate.advance')}</dt>
          <dd>{money(Math.max(0, check.advancePaise))}</dd>
        </div>
      </dl>
      {check.advancePaise < 0 && (
        <Alert tone="danger">
          {t('books.allocate.over', { amount: money(-check.advancePaise) })}
        </Alert>
      )}
    </div>
  );
}
