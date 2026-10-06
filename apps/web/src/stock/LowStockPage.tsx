import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
  useToast,
  type Tone,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Severity } from '../api/stock.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { STOCK_SECTIONS } from './sections.js';
import { StoreSelect } from './StoreSelect.js';
import { useStores } from './stores.js';
import { refreshInventory } from '../lib/refresh.js';

export const PAGE_SIZE = 100;

const SEVERITY_TONE: Record<Severity, Tone> = {
  out_of_stock: 'danger',
  below_minimum: 'warning',
  reorder: 'info',
};

/** Orders the selected (or all) low items at one store from a supplier. */
function OrderDialog({
  storeId,
  storeName,
  variantIds,
  onClose,
}: {
  readonly storeId: string;
  readonly storeName: string;
  readonly variantIds: readonly string[];
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, plural } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const suppliers = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.purchasing.suppliers({ limit: 200 }),
  });
  const [supplierId, setSupplierId] = useState('');
  const options = suppliers.data?.items ?? [];
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('stock.lowStock.poTitle')}
      description={
        variantIds.length === 0
          ? t('stock.lowStock.poAll', { store: storeName })
          : plural('stock.lowStock.poSelected', variantIds.length, { store: storeName })
      }
      submitLabel={t('stock.lowStock.create')}
      onSubmit={async () => {
        if (supplierId === '') return t('stock.lowStock.chooseSupplier');
        const order = await api.purchasing.orderFromLowStock({
          supplierId,
          storeId,
          ...(variantIds.length === 0 ? {} : { variantIds: [...variantIds] }),
        });
        await refreshInventory(queryClient);
        toast({ title: t('stock.lowStock.created', { number: order.number }), tone: 'success' });
        void navigate(`/purchase-orders/${order.id}`);
        return undefined;
      }}
    >
      {suppliers.isSuccess && options.length === 0 ? (
        <Alert tone="warning">{t('stock.lowStock.noSuppliers')}</Alert>
      ) : (
        <Field label={t('stock.lowStock.supplier')}>
          <Select
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
            }}
          >
            <option value="">{t('stock.lowStock.chooseSupplier')}</option>
            {options.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </FormDialog>
  );
}

/** /stock/low — items at or below their reorder level, and ordering them. */
export function LowStockPage() {
  const api = useApi();
  const { t, label, number } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(['store'] as const);
  const { store } = filters.values;
  const stores = useStores();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [ordering, setOrdering] = useState(false);
  const low = useQuery({
    queryKey: ['low-stock', store, filters.offset],
    queryFn: ({ signal }) =>
      api.stock.low(
        { storeId: store || undefined, limit: PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const storeName = stores.data?.find((option) => option.id === store)?.name;
  const canOrder = can('purchasing:manage');

  const toggle = (variantId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  };

  return (
    <>
      <PageHeader
        title={t('stock.lowStock.title')}
        description={t('stock.lowStock.description')}
        actions={
          canOrder && storeName !== undefined ? (
            <Button
              onClick={() => {
                setOrdering(true);
              }}
            >
              {t('stock.lowStock.createPo')}
            </Button>
          ) : undefined
        }
      />
      <SectionNav label="stock.sections.label" links={STOCK_SECTIONS} />
      <Card>
        <div className="filters">
          <StoreSelect
            label={t('stock.store')}
            emptyLabel={t('stock.allStores')}
            value={store}
            onChange={(value) => {
              setSelected(new Set());
              filters.set('store', value);
            }}
          />
          {canOrder && storeName === undefined && (
            <p className="muted filters__note">{t('stock.lowStock.chooseStore')}</p>
          )}
        </div>
        <QueryState query={low} error="stock.lowStock.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="check" size={32} />}
                title={t('stock.lowStock.emptyTitle')}
                description={t('stock.lowStock.emptyDescription')}
                action={
                  <Link to="/stock/reorder-rules" {...buttonStyle('secondary')}>
                    {t('stock.rules.title')}
                  </Link>
                }
              />
            ) : (
              <>
                <Table label={t('stock.lowStock.list')}>
                  <thead>
                    <tr>
                      {canOrder && storeName !== undefined && (
                        <th scope="col">
                          <span className="ui-visually-hidden">
                            {t('stock.lowStock.selectColumn')}
                          </span>
                        </th>
                      )}
                      <th scope="col">{t('stock.product')}</th>
                      <th scope="col">{t('stock.store')}</th>
                      <th scope="col">{t('stock.lowStock.severity')}</th>
                      <th scope="col" className="ui-num">
                        {t('stock.available')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.lowStock.reorderLevel')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.lowStock.suggested')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((item) => (
                      <tr key={`${item.store.id}-${item.variant.id}`}>
                        {canOrder && storeName !== undefined && (
                          <td>
                            <input
                              type="checkbox"
                              className="table-check"
                              aria-label={t('stock.lowStock.select', { sku: item.variant.sku })}
                              checked={selected.has(item.variant.id)}
                              onChange={() => {
                                toggle(item.variant.id);
                              }}
                            />
                          </td>
                        )}
                        <th scope="row">
                          {item.brand.name} {item.product.name}
                          <span className="cell-meta">{item.variant.sku}</span>
                        </th>
                        <td>{item.store.code}</td>
                        <td>
                          <Badge tone={SEVERITY_TONE[item.severity]}>
                            {label('severity', item.severity)}
                          </Badge>
                        </td>
                        <td className="ui-num">{number(item.available)}</td>
                        <td className="ui-num">{number(item.reorderLevel)}</td>
                        <td className="ui-num">{number(item.suggestedQuantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('stock.lowStock.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
      {ordering && storeName !== undefined && (
        <OrderDialog
          storeId={store}
          storeName={storeName}
          variantIds={[...selected]}
          onClose={() => {
            setOrdering(false);
          }}
        />
      )}
    </>
  );
}
