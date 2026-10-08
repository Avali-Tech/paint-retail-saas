import type { QuotationView, SalesOrderView } from '@paint/shared';
import { Alert } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { SalesDocEditor, type EditorKind } from './SalesDocEditor.js';

/** Only a draft can change; a sent quote is revised, a confirmed order is not edited. */
function DraftOnly({
  kind,
  document,
}: {
  readonly kind: EditorKind;
  readonly document: QuotationView | SalesOrderView;
}) {
  const { t } = useI18n();
  if (document.status !== 'draft') {
    return <Alert tone="warning">{t('orders.editor.notDraft', { number: document.number })}</Alert>;
  }
  return <SalesDocEditor kind={kind} existing={document} />;
}

/** /quotations/new */
export function NewQuotationPage() {
  return <SalesDocEditor kind="quotation" existing={null} />;
}

/** /sales-orders/new — an order without a quotation first (spec §4.1: a direct order). */
export function NewOrderPage() {
  return <SalesDocEditor kind="order" existing={null} />;
}

/** /quotations/:id/edit */
export function EditQuotationPage() {
  const api = useApi();
  const id = String(useParams().id);
  const quotation = useQuery({
    queryKey: ['quotations', id],
    queryFn: ({ signal }) => api.orders.quotation(id, signal),
  });
  return (
    <QueryState query={quotation} error="orders.quotation.error">
      {(data) => <DraftOnly kind="quotation" document={data} />}
    </QueryState>
  );
}

/** /sales-orders/:id/edit */
export function EditOrderPage() {
  const api = useApi();
  const id = String(useParams().id);
  const order = useQuery({
    queryKey: ['sales-orders', id],
    queryFn: ({ signal }) => api.orders.order(id, signal),
  });
  return (
    <QueryState query={order} error="orders.order.error">
      {(data) => <DraftOnly kind="order" document={data} />}
    </QueryState>
  );
}
