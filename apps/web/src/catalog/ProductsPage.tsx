import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PRODUCT_TYPES, type Product, type ProductType } from '../api/catalog.js';
import { ApiError, errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue, useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { categoryOptions } from './categories.js';

export const PAGE_SIZE = 50;
const FILTERS = ['q', 'brand', 'category', 'type', 'inactive'] as const;

/** The pack sizes on sale: the active ones (all of them for a product no longer sold, to tell it apart). */
export function sellable(product: Product): Product['variants'] {
  const active = product.variants.filter((variant) => variant.isActive);
  return active.length === 0 ? product.variants : active;
}

/** "₹450.00 – ₹1,700.00" across a product's pack sizes; null without prices. */
export function priceRange(product: Product, money: (paise: number) => string): string | null {
  const prices = sellable(product)
    .map((variant) => variant.sellingPricePaise ?? variant.mrpPaise)
    .filter((value): value is number => value !== null);
  if (prices.length === 0) return null;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? money(low) : `${money(low)} – ${money(high)}`;
}

/** Finds a product by barcode or SKU (a scanner types the code and presses Enter). */
function Lookup() {
  const api = useApi();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="lookup"
      onSubmit={(event) => {
        event.preventDefault();
        const value = code.trim();
        if (value === '') return;
        setPending(true);
        setMessage(null);
        api.catalog
          .lookup(value)
          .then((found) => {
            void navigate(`/products/${found.product.id}`);
          })
          .catch((error: unknown) => {
            setMessage(
              error instanceof ApiError && error.status === 404
                ? t('products.lookupNotFound', { code: value })
                : errorMessage(error),
            );
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <Field
        label={t('products.lookup')}
        hint={t('products.lookupHint')}
        error={message ?? undefined}
      >
        <Input
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          maxLength={64}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
      </Field>
      <Button type="submit" variant="secondary" loading={pending}>
        {t('products.lookupButton')}
      </Button>
    </form>
  );
}

/** The catalogue: every product with its pack sizes and prices. */
export function ProductsPage() {
  const api = useApi();
  const { t, label, money } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { brand, category, type, inactive } = filters.values;
  const q = useDebouncedValue(filters.values.q.trim(), 300);
  const filtered = q !== '' || brand !== '' || category !== '' || type !== '' || inactive !== '';

  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.catalog.categories(),
  });
  const products = useQuery({
    queryKey: ['products', { q, brand, category, type, inactive, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.catalog.products(
        {
          q: q || undefined,
          brandId: brand || undefined,
          categoryId: category || undefined,
          type: (type || undefined) as ProductType | undefined,
          includeInactive: inactive === '1',
          limit: PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title={t('products.title')}
        description={t('products.description')}
        actions={
          <>
            <Link to="/products/setup" {...buttonStyle('secondary')}>
              {t('products.setup')}
            </Link>
            {can('catalog:manage') && (
              <>
                <Link to="/imports?kind=products" {...buttonStyle('secondary')}>
                  {t('workflow.importData')}
                </Link>
                <Link to="/products/new" {...buttonStyle()}>
                  {t('products.new')}
                </Link>
              </>
            )}
          </>
        }
      />
      <div className="stack">
        <Card>
          <Lookup />
        </Card>
        <Card>
          <div className="filters">
            <Field label={t('products.search')} className="filters__search">
              <Input
                type="search"
                maxLength={100}
                value={filters.values.q}
                onChange={(event) => {
                  filters.set('q', event.target.value);
                }}
              />
            </Field>
            <Field label={t('products.brand')}>
              <Select
                value={brand}
                onChange={(event) => {
                  filters.set('brand', event.target.value);
                }}
              >
                <option value="">{t('products.allBrands')}</option>
                {(brands.data ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('products.category')}>
              <Select
                value={category}
                onChange={(event) => {
                  filters.set('category', event.target.value);
                }}
              >
                <option value="">{t('products.allCategories')}</option>
                {categoryOptions(categories.data ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('products.type')}>
              <Select
                value={type}
                onChange={(event) => {
                  filters.set('type', event.target.value);
                }}
              >
                <option value="">{t('products.allTypes')}</option>
                {PRODUCT_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {label('productTypes', value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkbox
              label={t('products.includeInactive')}
              checked={inactive === '1'}
              onChange={(event) => {
                filters.set('inactive', event.target.checked ? '1' : '');
              }}
            />
          </div>
          <QueryState query={products} error="products.error">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState
                  icon={<Icon name="products" size={32} />}
                  title={filtered ? t('products.noMatches') : t('products.emptyTitle')}
                  {...(filtered ? {} : { description: t('products.emptyDescription') })}
                />
              ) : (
                <>
                  <Table label={t('products.list')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('products.name')}</th>
                        <th scope="col">{t('products.brand')}</th>
                        <th scope="col">{t('products.type')}</th>
                        <th scope="col">{t('products.packs')}</th>
                        <th scope="col" className="ui-num">
                          {t('products.price')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((product) => (
                        <tr key={product.id}>
                          <th scope="row">
                            <Link to={`/products/${product.id}`}>{product.name}</Link>
                            {!product.isActive && (
                              <>
                                {' '}
                                <Badge>{t('products.inactive')}</Badge>
                              </>
                            )}
                          </th>
                          <td>{product.brand.name}</td>
                          <td>{label('productTypes', product.type)}</td>
                          <td>
                            {sellable(product)
                              .map((variant) => `${String(variant.packSize)} ${variant.unit}`)
                              .join(', ')}
                          </td>
                          <td className="ui-num">
                            {priceRange(product, money) ?? t('common.none')}
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
                    label={t('products.pages')}
                    range={(from, to, total) => t('common.range', { from, to, total })}
                    previousLabel={t('common.previous')}
                    nextLabel={t('common.next')}
                  />
                </>
              )
            }
          </QueryState>
        </Card>
      </div>
    </>
  );
}
