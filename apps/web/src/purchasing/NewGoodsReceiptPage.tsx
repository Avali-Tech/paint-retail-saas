import { Alert, Button, Card, Field, Input, PageHeader, Textarea, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { PurchaseOrder } from '../api/purchasing.js';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { ProductPicker } from '../lib/ProductPicker.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import {
  checkReceiptLines,
  effectiveCost,
  lineValue,
  parseCost,
  parseQuantity,
  type Problems,
  type ReceiptLineDraft,
} from './drafts.js';
import { receivable, usePurchaseOrder } from './PurchaseOrderDetailPage.js';
import { SupplierSelect, useSupplier } from './shared.js';
import { refreshInventory } from '../lib/refresh.js';

/** The order's lines still due, ready to receive in full. */
export function linesFromOrder(order: PurchaseOrder): ReceiptLineDraft[] {
  return order.lines
    .filter((line) => line.pendingQuantity > 0)
    .map((line) => ({
      variantId: line.variantId,
      sku: line.sku,
      name: `${line.brandName} ${line.productName} ${String(line.packSize)} ${line.unit}`,
      pending: line.pendingQuantity,
      orderCostPaise: line.unitCostPaise,
      quantity: String(line.pendingQuantity),
      free: '0',
      unitCost: '',
    }));
}

type LineField = 'quantity' | 'free' | 'unitCost';

/** Goods arriving: against an order, or (order === null) against a supplier's invoice. */
function ReceiptForm({ order }: { readonly order: PurchaseOrder | null }) {
  const api = useApi();
  const { t, money, number } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [supplierId, setSupplierId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<ReceiptLineDraft[]>(
    order === null ? [] : linesFromOrder(order),
  );
  const [problems, setProblems] = useState<Problems>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const supplier = useSupplier(order?.supplier.id ?? supplierId);
  const lastCosts = new Map(
    (supplier.data?.products ?? []).map((product) => [product.variantId, product.lastCostPaise]),
  );
  const fallbackCost = (line: ReceiptLineDraft) =>
    line.orderCostPaise ?? lastCosts.get(line.variantId) ?? null;
  const valueOf = (line: ReceiptLineDraft) =>
    lineValue(parseQuantity(line.quantity) ?? 0, effectiveCost(line.unitCost, fallbackCost(line)));
  const total = lines.reduce((sum, line) => sum + (valueOf(line) ?? 0), 0);
  const problem = (key: string) => {
    const found: MessageKey | undefined = problems[key];
    return found === undefined ? undefined : t(found);
  };
  const change = (variantId: string, field: LineField, value: string) => {
    setLines((current) =>
      current.map((line) => (line.variantId === variantId ? { ...line, [field]: value } : line)),
    );
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const found = checkReceiptLines(lines);
    const invoice = invoiceNumber.trim();
    if (order === null) {
      if (supplierId === '') found.supplier = 'purchasing.newOrder.supplierRequired';
      if (storeId === '') found.store = 'purchasing.newOrder.storeRequired';
      if (invoice === '') found.invoice = 'purchasing.newReceipt.invoiceRequired';
    }
    if (invoiceDate !== '' && invoice === '')
      found.invoice = 'purchasing.newReceipt.invoiceWithDate';
    setProblems(found);
    setMessage(null);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      const receipt = await api.purchasing.receive({
        ...(order === null ? { supplierId, storeId } : { purchaseOrderId: order.id }),
        ...(invoice === '' ? {} : { supplierInvoiceNumber: invoice }),
        ...(invoiceDate === '' ? {} : { supplierInvoiceDate: invoiceDate }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        lines: lines.map((line) => {
          const cost = parseCost(line.unitCost);
          return {
            variantId: line.variantId,
            quantity: Number(parseQuantity(line.quantity)),
            freeQuantity: Number(parseQuantity(line.free)),
            ...(typeof cost === 'number' ? { unitCostPaise: cost } : {}),
          };
        }),
      });
      queryClient.setQueryData(['goods-receipt', receipt.id], receipt);
      await refreshInventory(queryClient, ['goods-receipt', receipt.id]);
      toast({
        title: t('purchasing.newReceipt.saved', { number: receipt.number }),
        tone: 'success',
      });
      void navigate(`/goods-receipts/${receipt.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      <Card>
        <div className="stack">
          <p className="muted">
            {order === null
              ? t('purchasing.newReceipt.direct')
              : t('purchasing.newReceipt.againstOrder', {
                  number: order.number,
                  supplier: order.supplier.name,
                  store: order.store.name,
                })}
          </p>
          <div className="form-grid">
            {order === null && (
              <>
                <SupplierSelect
                  label={t('purchasing.supplier')}
                  value={supplierId}
                  emptyLabel={t('purchasing.chooseSupplier')}
                  required
                  error={problem('supplier')}
                  onChange={setSupplierId}
                />
                <StoreSelect
                  label={t('purchasing.store')}
                  value={storeId}
                  emptyLabel={t('purchasing.chooseStore')}
                  required
                  error={problem('store')}
                  onChange={setStoreId}
                />
              </>
            )}
            <Field
              label={t('purchasing.newReceipt.invoiceNumber')}
              required={order === null}
              error={problem('invoice')}
            >
              <Input
                autoComplete="off"
                maxLength={40}
                value={invoiceNumber}
                onChange={(event) => {
                  setInvoiceNumber(event.target.value);
                }}
              />
            </Field>
            <Field label={t('purchasing.newReceipt.invoiceDate')}>
              <Input
                type="date"
                value={invoiceDate}
                onChange={(event) => {
                  setInvoiceDate(event.target.value);
                }}
              />
            </Field>
          </div>
          <Field label={t('purchasing.newReceipt.note')}>
            <Textarea
              maxLength={500}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </div>
      </Card>
      <Card title={t('purchasing.newReceipt.lines')}>
        <div className="stack">
          {problem('lines') !== undefined && <Alert tone="danger">{problem('lines')}</Alert>}
          {lines.length > 0 && (
            <ul className="doc-lines">
              {lines.map((line) => {
                const fallback = fallbackCost(line);
                const value = valueOf(line);
                return (
                  <li key={line.variantId} className="doc-line">
                    <div className="doc-line__head">
                      <span className="doc-line__title">
                        {line.sku} · {line.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setLines((current) =>
                            current.filter((item) => item.variantId !== line.variantId),
                          );
                        }}
                      >
                        {t('workflow.remove', { sku: line.sku })}
                      </Button>
                    </div>
                    <div className="doc-line__fields">
                      <Field
                        label={t('purchasing.line.quantity', { sku: line.sku })}
                        {...(line.pending === null
                          ? {}
                          : {
                              hint: t('purchasing.line.pending', {
                                pending: number(line.pending),
                              }),
                            })}
                        error={problem(`qty-${line.variantId}`)}
                      >
                        <Input
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) => {
                            change(line.variantId, 'quantity', event.target.value);
                          }}
                        />
                      </Field>
                      <Field
                        label={t('purchasing.line.free', { sku: line.sku })}
                        hint={t('purchasing.line.freeHint')}
                        error={problem(`free-${line.variantId}`)}
                      >
                        <Input
                          inputMode="decimal"
                          value={line.free}
                          onChange={(event) => {
                            change(line.variantId, 'free', event.target.value);
                          }}
                        />
                      </Field>
                      <Field
                        label={t('purchasing.line.cost', { sku: line.sku })}
                        hint={
                          fallback === null
                            ? t('purchasing.line.costHint')
                            : line.orderCostPaise === null
                              ? t('purchasing.line.lastCost', { cost: money(fallback) })
                              : t('purchasing.line.orderCost', { cost: money(fallback) })
                        }
                        error={problem(`cost-${line.variantId}`)}
                      >
                        <Input
                          inputMode="decimal"
                          value={line.unitCost}
                          onChange={(event) => {
                            change(line.variantId, 'unitCost', event.target.value);
                          }}
                        />
                      </Field>
                    </div>
                    <p className="line-facts">
                      {value === null
                        ? t('purchasing.line.noValue')
                        : t('purchasing.line.value', { value: money(value) })}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {order === null && (
            <ProductPicker
              chosen={new Set(lines.map((line) => line.variantId))}
              onChoose={(picked) => {
                setLines((current) => [
                  ...current,
                  {
                    variantId: picked.variantId,
                    sku: picked.sku,
                    name: picked.name,
                    pending: null,
                    orderCostPaise: null,
                    quantity: '',
                    free: '0',
                    unitCost: '',
                  },
                ]);
              }}
            />
          )}
          <p className="doc-total">{t('purchasing.newReceipt.total', { total: money(total) })}</p>
        </div>
      </Card>
      <div className="row row--end">
        <Button type="submit" loading={pending}>
          {t('purchasing.newReceipt.submit')}
        </Button>
      </div>
    </form>
  );
}

function AgainstOrder({ orderId }: { readonly orderId: string }) {
  const { t, label } = useI18n();
  const order = usePurchaseOrder(orderId);
  return (
    <QueryState query={order} error="purchasing.newReceipt.orderError">
      {(data) =>
        receivable(data) ? (
          <ReceiptForm order={data} />
        ) : (
          <Alert tone="warning">
            {t('purchasing.newReceipt.orderDone', {
              status: label('purchaseOrderStatus', data.status).toLowerCase(),
            })}
          </Alert>
        )
      }
    </QueryState>
  );
}

/** /goods-receipts/new (?order=<id> to receive against a purchase order). */
export function NewGoodsReceiptPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const orderId = params.get('order');
  return (
    <>
      <PageHeader title={t('purchasing.newReceipt.title')} />
      {orderId === null ? <ReceiptForm order={null} /> : <AgainstOrder orderId={orderId} />}
    </>
  );
}
