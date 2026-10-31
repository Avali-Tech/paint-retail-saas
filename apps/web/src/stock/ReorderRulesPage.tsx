import {
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Table,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ReorderRule } from '../api/stock.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { ProductPicker, type PickedVariant } from '../lib/ProductPicker.js';
import { parseQuantity } from '../lib/quantity.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from './StoreSelect.js';
import { productTitle, variantName, variantTitle } from '../lib/product-title.js';

export const PAGE_SIZE = 50;
const FILTERS = ['store', 'q'] as const;

export interface Levels {
  readonly minQuantity: number;
  readonly reorderLevel: number;
  readonly maxQuantity: number;
}

/** Checks typed levels the way the API does: 0 ≤ minimum ≤ reorder level ≤ maximum, maximum > 0. */
export function checkLevels(min: string, reorder: string, max: string): Levels | MessageKey {
  const minQuantity = parseQuantity(min);
  const reorderLevel = parseQuantity(reorder);
  const maxQuantity = parseQuantity(max);
  if (
    minQuantity === null ||
    reorderLevel === null ||
    maxQuantity === null ||
    minQuantity < 0 ||
    reorderLevel < 0
  ) {
    return 'stock.rules.levelInvalid';
  }
  if (maxQuantity <= 0) return 'stock.rules.maxInvalid';
  if (minQuantity > reorderLevel || reorderLevel > maxQuantity) return 'stock.rules.orderInvalid';
  return { minQuantity, reorderLevel, maxQuantity };
}

/** Sets the levels for a product at a store (rule === null) or changes a rule's levels. */
function RuleDialog({
  rule,
  defaultStoreId,
  onClose,
}: {
  readonly rule: ReorderRule | null;
  readonly defaultStoreId: string;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [storeId, setStoreId] = useState(rule?.store.id ?? defaultStoreId);
  const [product, setProduct] = useState<PickedVariant | null>(null);
  const [min, setMin] = useState(rule === null ? '' : String(rule.minQuantity));
  const [reorder, setReorder] = useState(rule === null ? '' : String(rule.reorderLevel));
  const [max, setMax] = useState(rule === null ? '' : String(rule.maxQuantity));

  return (
    <FormDialog
      open
      onClose={onClose}
      title={
        rule === null
          ? t('stock.rules.newTitle')
          : t('stock.rules.editTitle', { sku: rule.variant.sku, store: rule.store.code })
      }
      description={t('stock.rules.dialogDescription')}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        const variantId = rule?.variant.id ?? product?.variantId;
        if (storeId === '') return t('stock.rules.chooseStore');
        if (variantId === undefined) return t('stock.rules.chooseProduct');
        const levels = checkLevels(min, reorder, max);
        if (typeof levels === 'string') return t(levels);
        await api.stock.saveRules([{ storeId, variantId, ...levels }]);
        await queryClient.invalidateQueries({ queryKey: ['reorder-rules'] });
        await queryClient.invalidateQueries({ queryKey: ['low-stock'] });
        toast({ title: t('stock.rules.saved'), tone: 'success' });
        return undefined;
      }}
    >
      {rule === null && (
        <>
          <StoreSelect
            label={t('stock.store')}
            emptyLabel={t('stock.rules.chooseStore')}
            required
            value={storeId}
            onChange={setStoreId}
          />
          {product === null ? (
            <ProductPicker chosen={new Set()} onChoose={setProduct} />
          ) : (
            <div className="row">
              <span>
                <strong>{product.sku}</strong> <span className="muted">{product.name}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setProduct(null);
                }}
              >
                {t('stock.rules.changeProduct')}
              </Button>
            </div>
          )}
        </>
      )}
      <div className="form-grid">
        <Field label={t('stock.rules.min')} hint={t('stock.rules.minHint')}>
          <Input
            inputMode="decimal"
            value={min}
            onChange={(event) => {
              setMin(event.target.value);
            }}
          />
        </Field>
        <Field label={t('stock.rules.reorderLevel')} hint={t('stock.rules.reorderHint')}>
          <Input
            inputMode="decimal"
            value={reorder}
            onChange={(event) => {
              setReorder(event.target.value);
            }}
          />
        </Field>
        <Field label={t('stock.rules.max')} hint={t('stock.rules.maxHint')}>
          <Input
            inputMode="decimal"
            value={max}
            onChange={(event) => {
              setMax(event.target.value);
            }}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

/** Asks before removing a rule; the product then never shows as low at that store. */
function RemoveDialog({
  rule,
  onClose,
}: {
  readonly rule: ReorderRule;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('stock.rules.removeTitle', { sku: rule.variant.sku, store: rule.store.code })}
      description={t('stock.rules.removeDescription')}
      submitLabel={t('stock.rules.removeConfirm')}
      onSubmit={async () => {
        await api.stock.deleteRule(rule.store.id, rule.variant.id);
        await queryClient.invalidateQueries({ queryKey: ['reorder-rules'] });
        await queryClient.invalidateQueries({ queryKey: ['low-stock'] });
        toast({ title: t('stock.rules.removed'), tone: 'success' });
        return undefined;
      }}
    >
      <p>{variantTitle(rule.brand.name, rule.product.name, rule.variant)}</p>
    </FormDialog>
  );
}

type Dialog =
  | { readonly kind: 'edit'; readonly rule: ReorderRule | null }
  | { readonly kind: 'remove'; readonly rule: ReorderRule };

/** /stock/reorder-rules — the minimum, reorder level and maximum per store and product. */
export function ReorderRulesPage() {
  const api = useApi();
  const { t, number } = useI18n();
  const can = usePermissions();
  const manage = can('inventory:manage');
  const filters = useUrlFilters(FILTERS);
  const { store } = filters.values;
  const q = useDebouncedValue(filters.values.q.trim(), 300);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const rules = useQuery({
    queryKey: ['reorder-rules', { store, q, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.stock.rules(
        {
          storeId: store || undefined,
          q: q || undefined,
          limit: PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const close = () => {
    setDialog(null);
  };

  return (
    <>
      <PageHeader
        title={t('stock.rules.title')}
        description={t('stock.rules.description')}
        actions={
          <>
            <Link
              to={
                store === ''
                  ? '/stock/reorder-rules/suggestions'
                  : `/stock/reorder-rules/suggestions?store=${store}`
              }
              {...buttonStyle('secondary')}
            >
              {t('stock.suggestions.open')}
            </Link>
            {manage && (
              <Button
                onClick={() => {
                  setDialog({ kind: 'edit', rule: null });
                }}
              >
                {t('stock.rules.new')}
              </Button>
            )}
          </>
        }
      />
      <Card>
        <div className="filters">
          <StoreSelect
            label={t('stock.store')}
            emptyLabel={t('stock.allStores')}
            value={store}
            onChange={(value) => {
              filters.set('store', value);
            }}
          />
          <Field label={t('stock.search')} className="filters__search">
            <Input
              type="search"
              value={filters.values.q}
              onChange={(event) => {
                filters.set('q', event.target.value);
              }}
            />
          </Field>
        </div>
        <QueryState query={rules} error="stock.rules.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="stock" size={32} />}
                title={
                  store !== '' || q !== ''
                    ? t('stock.rules.noMatches')
                    : t('stock.rules.emptyTitle')
                }
                description={t('stock.rules.emptyDescription')}
              />
            ) : (
              <>
                <Table label={t('stock.rules.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stock.product')}</th>
                      <th scope="col">{t('stock.store')}</th>
                      <th scope="col" className="ui-num">
                        {t('stock.rules.min')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.rules.reorderLevel')}
                      </th>
                      <th scope="col" className="ui-num">
                        {t('stock.rules.max')}
                      </th>
                      {manage && (
                        <th scope="col">
                          <span className="ui-visually-hidden">{t('stock.rules.actions')}</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((rule) => (
                      <tr key={`${rule.store.id}-${rule.variant.id}`}>
                        <th scope="row">
                          {productTitle(rule.brand.name, rule.product.name)}
                          <span className="cell-meta">
                            {rule.variant.sku} · {variantName(rule.variant)}
                          </span>
                        </th>
                        <td>{rule.store.code}</td>
                        <td className="ui-num">{number(rule.minQuantity)}</td>
                        <td className="ui-num">{number(rule.reorderLevel)}</td>
                        <td className="ui-num">{number(rule.maxQuantity)}</td>
                        {manage && (
                          <td>
                            <span className="row">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t('stock.rules.editTitle', {
                                  sku: rule.variant.sku,
                                  store: rule.store.code,
                                })}
                                onClick={() => {
                                  setDialog({ kind: 'edit', rule });
                                }}
                              >
                                {t('common.edit')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t('stock.rules.removeTitle', {
                                  sku: rule.variant.sku,
                                  store: rule.store.code,
                                })}
                                onClick={() => {
                                  setDialog({ kind: 'remove', rule });
                                }}
                              >
                                {t('stock.rules.remove')}
                              </Button>
                            </span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('stock.rules.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
      {dialog?.kind === 'edit' && (
        <RuleDialog rule={dialog.rule} defaultStoreId={store} onClose={close} />
      )}
      {dialog?.kind === 'remove' && <RemoveDialog rule={dialog.rule} onClose={close} />}
    </>
  );
}
