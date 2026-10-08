import {
  OPEN_ORDER_STATUSES,
  ORDERS_PERMISSION,
  type SalesOrderLineView,
  type SalesOrderView,
} from '@paint/shared';
import { Badge, Button, Card, PageHeader, Table, VisuallyHidden, buttonStyle } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { STATUS_TONE } from '../sales/InvoicesPage.js';
import { TaxTotals } from '../sales/TaxTotals.js';
import { storeLabel } from '../stock/StoreSelect.js';
import { useStores } from '../stock/stores.js';
import { DocumentFacts } from './DocumentFacts.js';
import { OrderAvailability } from './OrderAvailability.js';
import { OrderCreditPanel } from './OrderCredit.js';
import {
  BillDialog,
  CancelLineDialog,
  ConfirmDialog,
  IssueDialog,
  refreshOrder,
} from './OrderDialogs.js';
import { ORDER_TONE } from './status.js';

type Open =
  | { readonly kind: 'confirm' | 'cancel' | 'bill' }
  | { readonly kind: 'cancelLine'; readonly line: SalesOrderLineView }
  | { readonly kind: 'issue'; readonly invoiceId: string }
  | null;

/** The order's lines: ordered, billed, cancelled, held and still open. */
function OrderLines({
  order,
  storeName,
  onCancelLine,
}: {
  readonly order: SalesOrderView;
  readonly storeName: (id: string) => string;
  readonly onCancelLine: ((line: SalesOrderLineView) => void) | null;
}) {
  const { t, money, number } = useI18n();
  return (
    <Table label={t('sales.lines.title')}>
      <thead>
        <tr>
          <th scope="col">{t('sales.lines.item')}</th>
          <th scope="col">{t('orders.lines.from')}</th>
          <th scope="col">{t('orders.lines.ordered')}</th>
          <th scope="col">{t('orders.lines.billed')}</th>
          <th scope="col">{t('orders.lines.cancelled')}</th>
          <th scope="col">{t('orders.stock.held')}</th>
          <th scope="col">{t('orders.stock.open')}</th>
          <th scope="col">{t('sales.lines.total')}</th>
          {onCancelLine !== null && (
            <th scope="col">
              <VisuallyHidden>{t('orders.lines.actions')}</VisuallyHidden>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {order.lines.map((line) => (
          <tr key={line.id}>
            <th scope="row">
              {line.description}
              <span className="cell-meta">{line.sku}</span>
            </th>
            <td>{storeName(line.fulfilStoreId)}</td>
            <td>{number(line.quantity)}</td>
            <td>{number(line.quantityInvoiced)}</td>
            <td>{number(line.quantityCancelled)}</td>
            <td>{number(line.quantityReserved)}</td>
            <td>{number(line.quantityOpen)}</td>
            <td>{money(line.totalPaise)}</td>
            {onCancelLine !== null && (
              <td>
                {line.quantityOpen > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('orders.cancelLine.button', { item: line.description })}
                    onClick={() => {
                      onCancelLine(line);
                    }}
                  >
                    {t('orders.cancelLine.short')}
                  </Button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Invoices raised from the order; a draft whose issue failed can be issued from here. */
function OrderInvoices({
  order,
  onIssue,
}: {
  readonly order: SalesOrderView;
  readonly onIssue: ((invoiceId: string) => void) | null;
}) {
  const { t, label, money, date } = useI18n();
  return (
    <Card title={t('orders.invoices.title')}>
      {order.invoices.length === 0 ? (
        <p>{t('orders.invoices.empty')}</p>
      ) : (
        <ul className="record-list">
          {order.invoices.map((invoice) => (
            <li key={invoice.id} className="record-list__row">
              <span>
                <Link to={`/invoices/${invoice.id}`}>
                  {invoice.number ?? t('sales.invoices.draft')}
                </Link>
                <span className="record-list__meta">
                  {[
                    invoice.issuedOn === null ? null : date(invoice.issuedOn),
                    money(invoice.totalPaise),
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
                </span>
              </span>
              <span className="row">
                <Badge tone={STATUS_TONE[invoice.status]}>
                  {label('taxDocumentStatuses', invoice.status)}
                </Badge>
                {invoice.status === 'draft' && onIssue !== null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onIssue(invoice.id);
                    }}
                  >
                    {t('orders.issue.button')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OrderDetail({ order }: { readonly order: SalesOrderView }) {
  const api = useApi();
  const can = usePermissions();
  const stores = useStores();
  const queryClient = useQueryClient();
  const { t, label, money } = useI18n();
  const [open, setOpen] = useState<Open>(null);
  const credit = useQuery({
    queryKey: ['sales-orders', order.id, 'credit-check'],
    queryFn: ({ signal }) => api.orders.creditCheck(order.id, signal),
    enabled: order.status === 'draft' && order.paymentTerms === 'postpaid',
  });
  const manage = can(ORDERS_PERMISSION);
  const isOpen = OPEN_ORDER_STATUSES.includes(order.status);
  const draft = order.status === 'draft';
  const issue = can('billing:issue');
  const storeName = (id: string) => {
    const store = stores.data?.find((candidate) => candidate.id === id);
    return store === undefined ? t('common.none') : storeLabel(store);
  };
  const close = () => {
    setOpen(null);
  };
  // A blocked party cannot be confirmed; the panel says why.
  const approval = credit.data?.approval ?? 'none';

  const actions = manage && (draft || isOpen) && (
    <div className="row">
      {draft && (
        <>
          <Link to={`/sales-orders/${order.id}/edit`} {...buttonStyle('secondary')}>
            {t('common.edit')}
          </Link>
          <Button
            disabled={approval === 'blocked' || credit.isFetching}
            onClick={() => {
              setOpen({ kind: 'confirm' });
            }}
          >
            {t('orders.order.confirm')}
          </Button>
        </>
      )}
      {isOpen && issue && (
        <Button
          onClick={() => {
            setOpen({ kind: 'bill' });
          }}
        >
          {t('orders.order.bill')}
        </Button>
      )}
      <Button
        variant="ghost"
        onClick={() => {
          setOpen({ kind: 'cancel' });
        }}
      >
        {t('orders.order.cancel')}
      </Button>
    </div>
  );

  const extra: [string, string][] = [
    [t('orders.editor.paymentTerms'), label('paymentTerms', order.paymentTerms)],
    [t('orders.order.invoiced'), money(order.invoicedPaise)],
  ];
  if (order.advanceRequiredPaise !== null) {
    extra.push([t('orders.order.advance'), money(order.advanceRequiredPaise)]);
  }
  if (order.cancelReason !== null) {
    extra.push([t('sales.invoice.cancelReason'), order.cancelReason]);
  }

  return (
    <>
      <PageHeader
        title={t('orders.order.title', { number: order.number })}
        description={
          order.quotationNumber === null ? (
            t('orders.order.direct')
          ) : (
            <Link to={`/quotations/${String(order.quotationId)}`}>
              {t('orders.order.fromQuote', { number: order.quotationNumber })}
            </Link>
          )
        }
        actions={actions}
      />
      <DocumentFacts
        document={order}
        badge={
          <Badge tone={ORDER_TONE[order.status]}>{label('salesOrderStatuses', order.status)}</Badge>
        }
        storeName={storeName(order.storeId)}
        extra={extra}
      />
      <Card title={t('sales.lines.title')}>
        <div className="stack">
          <OrderLines
            order={order}
            storeName={storeName}
            onCancelLine={
              manage && isOpen
                ? (line) => {
                    setOpen({ kind: 'cancelLine', line });
                  }
                : null
            }
          />
          <TaxTotals totals={order} />
        </div>
      </Card>
      <OrderCreditPanel order={order} />
      {(draft || isOpen) && <OrderAvailability order={order} />}
      <OrderInvoices
        order={order}
        onIssue={
          issue
            ? (invoiceId) => {
                setOpen({ kind: 'issue', invoiceId });
              }
            : null
        }
      />
      {open?.kind === 'confirm' && (
        <ConfirmDialog order={order} approval={approval} onClose={close} />
      )}
      {open?.kind === 'bill' && <BillDialog order={order} onClose={close} />}
      {open?.kind === 'cancelLine' && (
        <CancelLineDialog order={order} line={open.line} onClose={close} />
      )}
      {open?.kind === 'issue' && (
        <IssueDialog order={order} invoiceId={open.invoiceId} onClose={close} />
      )}
      {open?.kind === 'cancel' && (
        <ReasonDialog
          title={t('orders.order.cancelTitle', { number: order.number })}
          description={t('orders.order.cancelHint')}
          submitLabel={t('orders.order.cancel')}
          onClose={close}
          onSubmit={async (reason) => {
            await api.orders.cancelOrder(order.id, reason);
            await refreshOrder(queryClient, order);
          }}
        />
      )}
    </>
  );
}

/** /sales-orders/:id — the order: availability, credit, confirm, bill part or all, cancel. */
export function OrderPage() {
  const api = useApi();
  // The route always has an :id.
  const id = String(useParams().id);
  const order = useQuery({
    queryKey: ['sales-orders', id],
    queryFn: ({ signal }) => api.orders.order(id, signal),
  });
  return (
    <QueryState query={order} error="orders.order.error">
      {(data) => <OrderDetail order={data} />}
    </QueryState>
  );
}
