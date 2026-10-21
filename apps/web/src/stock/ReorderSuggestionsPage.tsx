import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  Select,
  Table,
  useToast,
} from '@paint/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Levels, ReorderSuggestion } from '../api/stock.js';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { productTitle, variantName } from '../lib/product-title.js';
import { STOCK_SECTIONS } from './sections.js';
import { StoreSelect } from './StoreSelect.js';

export const PAGE_SIZE = 100;
/** Sales over this many days set the daily rate; 90 is the API's default. */
export const SALES_WINDOWS = [30, 60, 90, 180] as const;
/** Extra days of stock on top of the supplier's lead time. */
export const SAFETY_MARGINS = [0, 3, 7, 14] as const;

const pick = (value: string, options: readonly number[], fallback: number) =>
  options.includes(Number(value)) && value !== '' ? Number(value) : fallback;

const same = (a: Levels | null, b: Levels) =>
  a !== null &&
  a.minQuantity === b.minQuantity &&
  a.reorderLevel === b.reorderLevel &&
  a.maxQuantity === b.maxQuantity;

const key = (item: ReorderSuggestion) => item.variant.id;

/**
 * /stock/reorder-rules/suggestions — reorder levels worked out from what sold at a
 * store and how long the supplier takes, to apply in one go.
 */
export function ReorderSuggestionsPage() {
  const api = useApi();
  const { t, plural, number } = useI18n();
  const can = usePermissions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const manage = can('inventory:manage');
  const filters = useUrlFilters(['store', 'days', 'safety'] as const);
  const { store } = filters.values;
  const days = pick(filters.values.days, SALES_WINDOWS, 90);
  const safetyDays = pick(filters.values.safety, SAFETY_MARGINS, 7);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const suggestions = useQuery({
    queryKey: ['reorder-suggestions', store, days, safetyDays, filters.offset],
    queryFn: ({ signal }) =>
      api.stock.suggestions(
        { storeId: store, days, safetyDays, limit: PAGE_SIZE, offset: filters.offset },
        signal,
      ),
    enabled: store !== '',
    placeholderData: keepPreviousData,
  });

  const choose = (change: Partial<Record<'store' | 'days' | 'safety', string>>) => {
    setSelected(new Set());
    filters.setMany(change);
  };
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const apply = async (items: readonly ReorderSuggestion[]) => {
    setSaving(true);
    try {
      const chosen = items.filter((item) => selected.has(key(item)));
      await api.stock.saveRules(
        chosen.map((item) => ({
          storeId: store,
          variantId: item.variant.id,
          ...item.suggested,
        })),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reorder-suggestions'] }),
        queryClient.invalidateQueries({ queryKey: ['reorder-rules'] }),
        queryClient.invalidateQueries({ queryKey: ['low-stock'] }),
      ]);
      setSelected(new Set());
      toast({ title: plural('stock.suggestions.applied', chosen.length), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };
  const levels = (value: Levels) =>
    `${number(value.minQuantity)} / ${number(value.reorderLevel)} / ${number(value.maxQuantity)}`;

  return (
    <>
      <PageHeader
        title={t('stock.suggestions.title')}
        description={plural('stock.suggestions.description', safetyDays, { days })}
      />
      <SectionNav label="stock.sections.label" links={STOCK_SECTIONS} />
      <Card>
        <div className="filters">
          <StoreSelect
            label={t('stock.store')}
            emptyLabel={t('stock.suggestions.chooseStore')}
            value={store}
            onChange={(value) => {
              choose({ store: value });
            }}
          />
          <Field label={t('stock.suggestions.window')}>
            <Select
              value={String(days)}
              onChange={(event) => {
                choose({ days: event.target.value });
              }}
            >
              {SALES_WINDOWS.map((option) => (
                <option key={option} value={option}>
                  {plural('stock.suggestions.days', option)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('stock.suggestions.safety')}>
            <Select
              value={String(safetyDays)}
              onChange={(event) => {
                choose({ safety: event.target.value });
              }}
            >
              {SAFETY_MARGINS.map((option) => (
                <option key={option} value={option}>
                  {plural('stock.suggestions.days', option)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {store === '' ? (
          <Alert tone="info">{t('stock.suggestions.storeFirst')}</Alert>
        ) : (
          <QueryState query={suggestions} error="stock.suggestions.error">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState
                  icon={<Icon name="check" size={32} />}
                  title={t('stock.suggestions.emptyTitle')}
                  description={plural('stock.suggestions.emptyDescription', days)}
                />
              ) : (
                <>
                  <Table label={t('stock.suggestions.list')}>
                    <thead>
                      <tr>
                        {manage && (
                          <th scope="col">
                            <span className="ui-visually-hidden">
                              {t('stock.lowStock.selectColumn')}
                            </span>
                          </th>
                        )}
                        <th scope="col">{t('stock.product')}</th>
                        <th scope="col" className="ui-num">
                          {t('stock.suggestions.sold')}
                        </th>
                        <th scope="col" className="ui-num">
                          {t('stock.suggestions.perDay')}
                        </th>
                        <th scope="col">{t('stock.suggestions.leadTime')}</th>
                        <th scope="col" className="ui-num">
                          {t('stock.suggestions.current')}
                        </th>
                        <th scope="col" className="ui-num">
                          {t('stock.suggestions.suggested')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((item) => (
                        <tr key={key(item)}>
                          {manage && (
                            <td>
                              <input
                                type="checkbox"
                                className="table-check"
                                aria-label={t('stock.lowStock.select', { sku: item.variant.sku })}
                                checked={selected.has(key(item))}
                                onChange={() => {
                                  toggle(key(item));
                                }}
                              />
                            </td>
                          )}
                          <th scope="row">
                            {productTitle(item.brand.name, item.product.name)}
                            <span className="cell-meta">
                              {item.variant.sku} · {variantName(item.variant)}
                            </span>
                          </th>
                          <td className="ui-num">{number(item.soldQuantity)}</td>
                          <td className="ui-num">{number(item.dailyRate)}</td>
                          <td>
                            {plural('stock.suggestions.days', item.leadTimeDays)}
                            <span className="cell-meta">
                              {item.supplierName ?? t('stock.suggestions.defaultLead')}
                            </span>
                          </td>
                          <td className="ui-num">
                            {item.current === null
                              ? t('stock.suggestions.noRule')
                              : levels(item.current)}
                          </td>
                          <td className="ui-num">
                            {levels(item.suggested)}
                            {same(item.current, item.suggested) && (
                              <span className="cell-meta">{t('stock.suggestions.unchanged')}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Pagination
                    offset={filters.offset}
                    limit={PAGE_SIZE}
                    total={page.total}
                    onChange={filters.setOffset}
                    label={t('stock.suggestions.pages')}
                    range={(from, to, total) => t('common.range', { from, to, total })}
                    previousLabel={t('common.previous')}
                    nextLabel={t('common.next')}
                  />
                  {manage && (
                    <div className="row">
                      <Button
                        disabled={selected.size === 0}
                        loading={saving}
                        onClick={() => {
                          void apply(page.items);
                        }}
                      >
                        {plural('stock.suggestions.apply', selected.size)}
                      </Button>
                    </div>
                  )}
                </>
              )
            }
          </QueryState>
        )}
      </Card>
    </>
  );
}
