import { Alert, Button, Card, Field, Input, PageHeader, Textarea, useToast } from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { ProductPicker } from '../lib/ProductPicker.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import {
  checkOrderLines,
  effectiveCost,
  lineValue,
  parseCost,
  parseQuantity,
  type OrderLineDraft,
  type Problems,
} from './drafts.js';
import { SupplierSelect, useSupplier } from './shared.js';
import { refreshInventory } from '../lib/refresh.js';

/** /purchase-orders/new — order products from a supplier for one store. */
export function NewPurchaseOrderPage() {
  const api = useApi();
  const { t, money } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [supplierId, setSupplierId] = useState(params.get('supplier') ?? '');
  const [storeId, setStoreId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<OrderLineDraft[]>([]);
  const [problems, setProblems] = useState<Problems>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const supplier = useSupplier(supplierId);
  const lastCosts = new Map(
    (supplier.data?.products ?? []).map((product) => [product.variantId, product.lastCostPaise]),
  );
  const chosen = new Set(lines.map((line) => line.variantId));
  const missing = (supplier.data?.products ?? []).filter(
    (product) => !chosen.has(product.variantId),
  );
  const problem = (key: string) => {
    const found: MessageKey | undefined = problems[key];
    return found === undefined ? undefined : t(found);
  };
  const lastCost = (variantId: string) => lastCosts.get(variantId) ?? null;
  const total = lines.reduce((sum, line) => {
    const value = lineValue(
      parseQuantity(line.quantity) ?? 0,
      effectiveCost(line.unitCost, lastCost(line.variantId)),
    );
    return sum + (value ?? 0);
  }, 0);
  const change = (variantId: string, field: 'quantity' | 'unitCost', value: string) => {
    setLines((current) =>
      current.map((line) => (line.variantId === variantId ? { ...line, [field]: value } : line)),
    );
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const found = checkOrderLines(lines);
    if (supplierId === '') found.supplier = 'purchasing.newOrder.supplierRequired';
    if (storeId === '') found.store = 'purchasing.newOrder.storeRequired';
    setProblems(found);
    setMessage(null);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      const order = await api.purchasing.createOrder({
        supplierId,
        storeId,
        ...(expectedDate === '' ? {} : { expectedDate }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        lines: lines.map((line) => {
          const cost = parseCost(line.unitCost);
          return {
            variantId: line.variantId,
            quantity: Number(parseQuantity(line.quantity)),
            ...(typeof cost === 'number' ? { unitCostPaise: cost } : {}),
          };
        }),
      });
      queryClient.setQueryData(['purchase-order', order.id], order);
      await refreshInventory(queryClient, ['purchase-order', order.id]);
      toast({ title: t('purchasing.newOrder.created', { number: order.number }), tone: 'success' });
      void navigate(`/purchase-orders/${order.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader title={t('purchasing.newOrder.title')} />
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <Card>
          <div className="form-grid">
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
            <Field label={t('purchasing.newOrder.expectedDate')}>
              <Input
                type="date"
                value={expectedDate}
                onChange={(event) => {
                  setExpectedDate(event.target.value);
                }}
              />
            </Field>
          </div>
          <Field label={t('purchasing.newOrder.note')} className="form-wide">
            <Textarea
              maxLength={500}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </Card>
        <Card title={t('purchasing.newOrder.lines')}>
          <div className="stack">
            {problem('lines') !== undefined && <Alert tone="danger">{problem('lines')}</Alert>}
            {lines.length > 0 && (
              <ul className="doc-lines">
                {lines.map((line) => {
                  const known = lastCost(line.variantId);
                  const value = lineValue(
                    parseQuantity(line.quantity) ?? 0,
                    effectiveCost(line.unitCost, known),
                  );
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
                          required
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
                          label={t('purchasing.line.cost', { sku: line.sku })}
                          hint={
                            known === null
                              ? t('purchasing.line.costHint')
                              : t('purchasing.line.lastCost', { cost: money(known) })
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
            {missing.length > 0 && (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setLines((current) => [
                      ...current,
                      ...missing.map((product) => ({
                        variantId: product.variantId,
                        sku: product.sku,
                        name: `${product.brandName} ${product.productName}`,
                        quantity: '',
                        unitCost: '',
                      })),
                    ]);
                  }}
                >
                  {t('purchasing.newOrder.addSupplierProducts')}
                </Button>
              </div>
            )}
            <ProductPicker
              chosen={chosen}
              onChoose={(picked) => {
                setLines((current) => [
                  ...current,
                  {
                    variantId: picked.variantId,
                    sku: picked.sku,
                    name: picked.name,
                    quantity: '',
                    unitCost: '',
                  },
                ]);
              }}
            />
            <p className="doc-total">
              {t('purchasing.newOrder.knownTotal', { total: money(total) })}
            </p>
          </div>
        </Card>
        <div className="row row--end">
          <Button type="submit" loading={pending}>
            {t('purchasing.newOrder.create')}
          </Button>
        </div>
      </form>
    </>
  );
}
