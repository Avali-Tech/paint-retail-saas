import { Alert, Button, Card, Table } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import type { ChallanParty } from '../api/transfers.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';

function Party({ title, party }: { readonly title: string; readonly party: ChallanParty }) {
  const { t } = useI18n();
  const place = [party.city, party.state].filter((part) => part !== null).join(', ');
  return (
    <div>
      <dt>{title}</dt>
      <dd>
        {party.code} · {party.name}
        {place !== '' && <span className="cell-meta">{place}</span>}
        <span className="cell-meta">
          {party.gstin === null
            ? t('transfers.challan.noGstin')
            : t('transfers.challan.gstin', { gstin: party.gstin })}
        </span>
      </dd>
    </div>
  );
}

/** The delivery challan that travels with dispatched goods, ready to print. */
export function ChallanCard({ transferId }: { readonly transferId: string }) {
  const api = useApi();
  const { t, number, money, dateTime } = useI18n();
  const challan = useQuery({
    queryKey: ['transfer', transferId, 'challan'],
    queryFn: ({ signal }) => api.transfers.challan(transferId, signal),
  });
  const value = (paise: number | null) => (paise === null ? t('common.none') : money(paise));
  return (
    <Card
      title={t('transfers.challan.title')}
      className="challan"
      actions={
        <Button
          variant="secondary"
          size="sm"
          className="no-print"
          onClick={() => {
            window.print();
          }}
        >
          {t('transfers.challan.print')}
        </Button>
      }
    >
      <QueryState query={challan} error="transfers.challan.error">
        {(data) => (
          <div className="stack">
            <p className="muted">
              {data.number} ·{' '}
              {t('transfers.challan.dispatchedAt', { time: dateTime(data.dispatchedAt) })}
            </p>
            {data.requiresTaxInvoice && (
              <Alert tone="warning">{t('transfers.challan.taxInvoice')}</Alert>
            )}
            <dl className="facts">
              <Party title={t('transfers.challan.from')} party={data.from} />
              <Party title={t('transfers.challan.to')} party={data.to} />
            </dl>
            <Table label={t('transfers.challan.list')}>
              <thead>
                <tr>
                  <th scope="col">{t('transfers.challan.sku')}</th>
                  <th scope="col">{t('transfers.challan.item')}</th>
                  <th scope="col">{t('transfers.challan.hsn')}</th>
                  <th scope="col" className="ui-num">
                    {t('transfers.challan.quantity')}
                  </th>
                  <th scope="col" className="ui-num">
                    {t('transfers.challan.unitValue')}
                  </th>
                  <th scope="col" className="ui-num">
                    {t('transfers.challan.value')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line) => (
                  <tr key={line.sku}>
                    <th scope="row">{line.sku}</th>
                    <td>{line.description}</td>
                    <td>{line.hsnCode}</td>
                    <td className="ui-num">{number(line.quantity)}</td>
                    <td className="ui-num">{value(line.unitValuePaise)}</td>
                    <td className="ui-num">{value(line.valuePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="doc-total">
              <span>{t('transfers.challan.total')}</span>
              <span>{money(data.totalValuePaise)}</span>
            </p>
          </div>
        )}
      </QueryState>
    </Card>
  );
}
