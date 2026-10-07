import { Card, PageHeader, Table } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { GoodsReceipt } from '../api/purchasing.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { productTitle } from '../lib/product-title.js';

function ReceiptView({ receipt }: { readonly receipt: GoodsReceipt }) {
  const { t, money, number, date, dateTime } = useI18n();
  const cost = (paise: number | null) => (paise === null ? t('common.none') : money(paise));
  return (
    <>
      <PageHeader title={receipt.number} description={dateTime(receipt.receivedAt)} />
      <div className="stack">
        <Card>
          <dl className="facts">
            <div>
              <dt>{t('purchasing.receiptDetail.supplier')}</dt>
              <dd>
                <Link to={`/suppliers/${receipt.supplier.id}`}>{receipt.supplier.name}</Link>
              </dd>
            </div>
            <div>
              <dt>{t('purchasing.receiptDetail.store')}</dt>
              <dd>
                {receipt.store.code} · {receipt.store.name}
              </dd>
            </div>
            <div>
              <dt>{t('purchasing.receiptDetail.order')}</dt>
              <dd>
                {receipt.purchaseOrder === null ? (
                  t('purchasing.receiptDetail.none')
                ) : (
                  <Link to={`/purchase-orders/${receipt.purchaseOrder.id}`}>
                    {receipt.purchaseOrder.number}
                  </Link>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('purchasing.receiptDetail.invoice')}</dt>
              <dd>{receipt.supplierInvoiceNumber ?? t('common.none')}</dd>
            </div>
            <div>
              <dt>{t('purchasing.receiptDetail.invoiceDate')}</dt>
              <dd>
                {receipt.supplierInvoiceDate === null
                  ? t('common.none')
                  : date(receipt.supplierInvoiceDate)}
              </dd>
            </div>
            {receipt.note !== null && (
              <div>
                <dt>{t('purchasing.receiptDetail.note')}</dt>
                <dd>{receipt.note}</dd>
              </div>
            )}
          </dl>
        </Card>
        <Card title={t('purchasing.receiptDetail.lines')}>
          <Table label={t('purchasing.receiptDetail.lines')}>
            <thead>
              <tr>
                <th scope="col">{t('purchasing.product')}</th>
                <th scope="col" className="ui-num">
                  {t('purchasing.receiptDetail.quantity')}
                </th>
                <th scope="col" className="ui-num">
                  {t('purchasing.receiptDetail.free')}
                </th>
                <th scope="col" className="ui-num">
                  {t('purchasing.receiptDetail.cost')}
                </th>
                <th scope="col" className="ui-num">
                  {t('purchasing.value')}
                </th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((line) => (
                <tr key={line.variantId}>
                  <th scope="row">
                    {productTitle(line.brandName, line.productName)}
                    <span className="cell-meta">{line.sku}</span>
                  </th>
                  <td className="ui-num">{number(line.quantity)}</td>
                  <td className="ui-num">{number(line.freeQuantity)}</td>
                  <td className="ui-num">{cost(line.unitCostPaise)}</td>
                  <td className="ui-num">{cost(line.valuePaise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="doc-total">
            {t('purchasing.total')} {money(receipt.totalValuePaise)}
          </p>
        </Card>
      </div>
    </>
  );
}

/** /goods-receipts/:id */
export function GoodsReceiptDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const receipt = useQuery({
    queryKey: ['goods-receipt', id],
    queryFn: ({ signal }) => api.purchasing.receipt(id, signal),
  });
  return (
    <QueryState query={receipt} error="purchasing.receiptDetail.error">
      {(data) => <ReceiptView receipt={data} />}
    </QueryState>
  );
}
