import type {
  BillOrderRequest,
  CancelOrderLineRequest,
  ConfirmSalesOrderRequest,
  ConvertQuotationRequest,
  DispatchRequest,
  DispatchView,
  InvoiceDispatchesView,
  IssueInvoiceRequest,
  IssuedInvoiceView,
  OrderAvailabilityView,
  QuotationPage,
  QuotationRequest,
  QuotationStatus,
  QuotationView,
  ReserveOrderRequest,
  SalesOrderCreditCheckView,
  SalesOrderPage,
  SalesOrderRequest,
  SalesOrderStatus,
  SalesOrderView,
  TaxDocumentView,
} from '@paint/shared';
import type { ApiClient } from '../api/client.js';

// Every call the quote → order → invoice screens make (round 4a's API, shapes in
// @paint/shared orders-api.ts). Calls that create something carry an idempotency
// key, so a retried request (a lost answer) returns the first result.

export interface QuotationQuery {
  readonly status?: QuotationStatus | undefined;
  readonly q?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface SalesOrderQuery {
  readonly status?: SalesOrderStatus | undefined;
  readonly q?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

const keyed = (idempotencyKey: string) => ({ headers: { 'Idempotency-Key': idempotencyKey } });

export function ordersEndpoints(api: ApiClient) {
  return {
    quotations: (query: QuotationQuery, signal?: AbortSignal) =>
      api.get<QuotationPage>('/quotations', { query: { ...query }, signal }),
    quotation: (id: string, signal?: AbortSignal) =>
      api.get<QuotationView>(`/quotations/${id}`, { signal }),
    createQuotation: (input: QuotationRequest, idempotencyKey: string) =>
      api.post<QuotationView>('/quotations', input, keyed(idempotencyKey)),
    updateQuotation: (id: string, input: QuotationRequest) =>
      api.put<QuotationView>(`/quotations/${id}`, input),
    /** A new draft version; this one becomes read-only (superseded). */
    reviseQuotation: (id: string) => api.post<QuotationView>(`/quotations/${id}/revise`),
    sendQuotation: (id: string) => api.post<QuotationView>(`/quotations/${id}/send`),
    acceptQuotation: (id: string) => api.post<QuotationView>(`/quotations/${id}/accept`),
    convertQuotation: (id: string, input: ConvertQuotationRequest, idempotencyKey: string) =>
      api.post<SalesOrderView>(`/quotations/${id}/convert`, input, keyed(idempotencyKey)),

    orders: (query: SalesOrderQuery, signal?: AbortSignal) =>
      api.get<SalesOrderPage>('/sales-orders', { query: { ...query }, signal }),
    order: (id: string, signal?: AbortSignal) =>
      api.get<SalesOrderView>(`/sales-orders/${id}`, { signal }),
    createOrder: (input: SalesOrderRequest, idempotencyKey: string) =>
      api.post<SalesOrderView>('/sales-orders', input, keyed(idempotencyKey)),
    updateOrder: (id: string, input: SalesOrderRequest) =>
      api.put<SalesOrderView>(`/sales-orders/${id}`, input),
    availability: (id: string, signal?: AbortSignal) =>
      api.get<OrderAvailabilityView>(`/sales-orders/${id}/availability`, { signal }),
    creditCheck: (id: string, signal?: AbortSignal) =>
      api.get<SalesOrderCreditCheckView>(`/sales-orders/${id}/credit-check`, { signal }),
    confirmOrder: (id: string, input: ConfirmSalesOrderRequest, idempotencyKey: string) =>
      api.post<SalesOrderView>(`/sales-orders/${id}/confirm`, input, keyed(idempotencyKey)),
    cancelOrder: (id: string, reason: string) =>
      api.post<SalesOrderView>(`/sales-orders/${id}/cancel`, { reason }),
    cancelLine: (id: string, lineId: string, input: CancelOrderLineRequest) =>
      api.post<SalesOrderView>(`/sales-orders/${id}/lines/${lineId}/cancel`, input),
    reserve: (id: string, input: ReserveOrderRequest) =>
      api.post<SalesOrderView>(`/sales-orders/${id}/reserve`, input),
    release: (id: string) => api.post<SalesOrderView>(`/sales-orders/${id}/release`, {}),
    /** A draft invoice for what is open at one fulfil store. */
    bill: (id: string, input: BillOrderRequest, idempotencyKey: string) =>
      api.post<TaxDocumentView>(`/sales-orders/${id}/invoices`, input, keyed(idempotencyKey)),
    /** Issues a draft raised from an order (round 2a's issue). */
    issue: (invoiceId: string, input: IssueInvoiceRequest, idempotencyKey: string) =>
      api.post<IssuedInvoiceView>(`/invoices/${invoiceId}/issue`, input, keyed(idempotencyKey)),

    dispatches: (invoiceId: string, signal?: AbortSignal) =>
      api.get<InvoiceDispatchesView>(`/invoices/${invoiceId}/dispatches`, { signal }),
    dispatch: (invoiceId: string, input: DispatchRequest, idempotencyKey: string) =>
      api.post<DispatchView>(`/invoices/${invoiceId}/dispatches`, input, keyed(idempotencyKey)),
  };
}

export type OrdersEndpoints = ReturnType<typeof ordersEndpoints>;
