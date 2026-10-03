import { Button, Card, PageHeader, Table, buttonStyle, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { PurchaseOrder } from '../api/purchasing.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { OrderStatusBadge } from './shared.js';
import { refreshInventory } from '../lib/refresh.js';

export const purchaseOrderKey = (id: string) => ['purchase-order', id] as const;

/** Whether goods can still arrive against an order. */
export const receivable = (order: Pick<PurchaseOrder, 'status'>) =>
  order.status === 'open' || order.status === 'partially_received';

function OrderView({ order }: { readonly order: PurchaseOrder }) {
  const api = useApi();
  const { t, money, number, date, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const can = usePermissions();
  const manage = can('purchasing:manage');
  const [action, setAction] = useState<'cancel' | 'close' | null>(null);
  const cost = (paise: number | null) => (paise === null ? t('common.none') : money(paise));

  /** Cancels or closes; when refused (someone else changed the order), shows the order as it is now. */
  const finish = async (work: Promise<PurchaseOrder>, message: string) => {
    let saved: PurchaseOrder;
    try {
      saved = await work;
    } catch (error) {
      await refreshInventory(queryClient);
      throw error;
    }
    queryClient.setQueryData(purchaseOrderKey(order.id), saved);
    await refreshInventory(queryClient, purchaseOrderKey(order.id));
    toast({ title: message, tone: 'success' });
  };

  return (
    <>
      <PageHeader
        title={order.number}
        description={
          <span className="badges">
            <OrderStatusBadge status={order.status} />
            <span className="muted">{dateTime(order.createdAt)}</span>
          </span>
        }
        actions={
          manage && receivable(order) ? (
            <>
              {order.status === 'open' ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAction('cancel');
                  }}
                >
                  {t('purchasing.orderDetail.cancel')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAction('close');
                  }}
                >
                  {t('purchasing.orderDetail.close')}
                </Button>
              )}
              <Link to={`/goods-receipts/new?order=${order.id}`} {...buttonStyle()}>
                {t('purchasing.orderDetail.receive')}
              </Link>
            </>
          ) : undefined
        }
      />
      <div className="stack">
        <Card>
          <dl className="facts">
            <div>
              <dt>{t('purchasing.orderDetail.supplier')}</dt>
              <dd>
                <Link to={`/suppliers/${order.supplier.id}`}>{order.supplier.name}</Link>
              </dd>
            </div>
            <div>
              <dt>{t('purchasing.orderDetail.store')}</dt>
              <dd>
                {order.store.code} · {order.store.name}
              </dd>
            </div>
            <div>
              <dt>{t('purchasing.orderDetail.expected')}</dt>
              <dd>{order.expectedDate === null ? t('common.none') : date(order.expectedDate)}</dd>
            </div>
            {order.note !== null && (
              <div>
                <dt>{t('purchasing.orderDetail.note')}</dt>
                <dd>{order.note}</dd>
              </div>
            )}
            {order.closingReason !== null && (
              <div>
                <dt>{t('purchasing.orderDetail.closingReason')}</dt>
                <dd>{order.closingReason}</dd>
              </div>
            )}
          </dl>
        </Card>
        <Card title={t('purchasing.orderDetail.lines')}>
          <Table label={t('purchasing.orderDetail.lines')}>
            <thead>
              <tr>
                <th scope="col">{t('purchasing.product')}</th>
                <th scope="col" className="ui-num">
                  {t('purchasing.orderDetail.ordered')}
                </th>
                <th scope="col" className="ui-num">
                  {t('purchasing.orderDetail.received')}
                </th>
                <th scope="col" className="ui-num">
                  {t('purchasing.orderDetail.pending')}
                </th>
                <th scope="col" className="ui-num">
                  {t('purchasing.orderDetail.cost')}
                </th>
                <th scope="col" className="ui-num">
                  {t('purchasing.value')}
                </th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.variantId}>
                  <th scope="row">
                    {line.brandName} {line.productName}
                    <span className="cell-meta">
                      {line.sku} · {String(line.packSize)} {line.unit}
                    </span>
                  </th>
                  <td className="ui-num">{number(line.orderedQuantity)}</td>
                  <td className="ui-num">{number(line.receivedQuantity)}</td>
                  <td className="ui-num">{number(line.pendingQuantity)}</td>
                  <td className="ui-num">{cost(line.unitCostPaise)}</td>
                  <td className="ui-num">{cost(line.valuePaise)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="doc-total">
            {t('purchasing.total')} {money(order.totalValuePaise)}
          </p>
        </Card>
        <Card title={t('purchasing.orderDetail.receipts')}>
          {order.receipts.length === 0 ? (
            <p className="muted">{t('purchasing.orderDetail.noReceipts')}</p>
          ) : (
            <ul className="record-list">
              {order.receipts.map((receipt) => (
                <li key={receipt.id}>
                  <Link to={`/goods-receipts/${receipt.id}`} className="record-list__title">
                    {receipt.number}
                  </Link>
                  <span className="record-list__meta">
                    {dateTime(receipt.receivedAt)}
                    {receipt.supplierInvoiceNumber !== null &&
                      ` · ${t('purchasing.orderDetail.invoice', { number: receipt.supplierInvoiceNumber })}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {action === 'cancel' && (
        <ReasonDialog
          title={t('purchasing.orderDetail.cancelTitle', { number: order.number })}
          submitLabel={t('purchasing.orderDetail.cancel')}
          onClose={() => {
            setAction(null);
          }}
          onSubmit={async (reason) => {
            await finish(
              api.purchasing.cancelOrder(order.id, reason),
              t('purchasing.orderDetail.cancelled'),
            );
          }}
        />
      )}
      {action === 'close' && (
        <ReasonDialog
          title={t('purchasing.orderDetail.closeTitle', { number: order.number })}
          description={t('purchasing.orderDetail.closeDescription')}
          submitLabel={t('purchasing.orderDetail.close')}
          onClose={() => {
            setAction(null);
          }}
          onSubmit={async (reason) => {
            await finish(
              api.purchasing.closeOrder(order.id, reason),
              t('purchasing.orderDetail.closed'),
            );
          }}
        />
      )}
    </>
  );
}

/** The order and its loading state, shared by the detail and receive pages. */
export function usePurchaseOrder(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: purchaseOrderKey(id),
    queryFn: ({ signal }) => api.purchasing.order(id, signal),
  });
}

/** /purchase-orders/:id */
export function PurchaseOrderDetailPage() {
  const order = usePurchaseOrder(String(useParams().id));
  return (
    <QueryState query={order} error="purchasing.orderDetail.error">
      {(data) => <OrderView order={data} />}
    </QueryState>
  );
}
