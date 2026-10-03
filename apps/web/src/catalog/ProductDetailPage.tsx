import { zodResolver } from '@hookform/resolvers/zod';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  buttonStyle,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { UNITS, type Product, type Variant } from '../api/catalog.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';
import {
  EMPTY_VARIANT,
  toVariantChanges,
  toVariantInput,
  variantDraft,
  variantSchema,
  type VariantDraft,
} from './variant-form.js';

/** Adds a pack size (variant === null) or edits one. */
function VariantDialog({
  product,
  variant,
  onClose,
}: {
  readonly product: Product;
  readonly variant: Variant | null;
  readonly onClose: () => void;
}) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const schema = useMemo(() => variantSchema(t), [t]);
  const form = useForm<VariantDraft>({
    resolver: zodResolver(schema),
    defaultValues: variant === null ? { ...EMPTY_VARIANT } : variantDraft(variant),
  });
  const { errors } = form.formState;
  const editing = variant !== null;

  return (
    <FormDialog
      open
      onClose={onClose}
      title={
        editing
          ? t('products.detail.editVariant', { sku: variant.sku })
          : t('products.detail.addVariant')
      }
      submitLabel={t('common.save')}
      onSubmit={async () => {
        if (!(await form.trigger())) return false;
        const draft = form.getValues();
        const saved = editing
          ? await api.catalog.updateVariant(variant.id, toVariantChanges(draft))
          : await api.catalog.addVariant(product.id, toVariantInput(draft));
        queryClient.setQueryData(['product', product.id], saved);
        await queryClient.invalidateQueries({ queryKey: ['products'] });
        toast({
          title: editing ? t('products.detail.variantSaved') : t('products.detail.variantAdded'),
          tone: 'success',
        });
        return undefined;
      }}
    >
      <Field label={t('products.form.sku')} required error={errors.sku?.message}>
        <Input className="uppercase" {...form.register('sku')} />
      </Field>
      {!editing && (
        <div className="form-grid">
          <Field label={t('products.form.packSize')} required error={errors.packSize?.message}>
            <Input inputMode="decimal" {...form.register('packSize')} />
          </Field>
          <Field label={t('products.form.unit')}>
            <Select {...form.register('unit')}>
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {label('units', unit)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      <div className="form-grid">
        <Field label={t('products.form.mrp')} error={errors.mrp?.message}>
          <Input inputMode="decimal" {...form.register('mrp')} />
        </Field>
        <Field label={t('products.form.sellingPrice')} error={errors.sellingPrice?.message}>
          <Input inputMode="decimal" {...form.register('sellingPrice')} />
        </Field>
      </div>
      <Field
        label={t('products.form.barcodes')}
        hint={t('products.form.barcodesHint')}
        error={errors.barcodes?.message}
      >
        <Input {...form.register('barcodes')} />
      </Field>
      {editing && <Checkbox label={t('products.form.active')} {...form.register('isActive')} />}
    </FormDialog>
  );
}

/** Where the product is in stock: every pack size at each of the member's stores. */
function StockByStore({ product }: { readonly product: Product }) {
  const api = useApi();
  const { t, number } = useI18n();
  const stock = useQuery({
    queryKey: ['stock', { productId: product.id }],
    queryFn: ({ signal }) => api.stock.balances({ productId: product.id, limit: 200 }, signal),
  });
  return (
    <Card title={t('products.detail.stock')}>
      <QueryState query={stock} error="stock.error">
        {(page) =>
          page.items.length === 0 ? (
            <p className="muted">{t('products.detail.noStock')}</p>
          ) : (
            <Table label={t('products.detail.stock')}>
              <thead>
                <tr>
                  <th scope="col">{t('stock.store')}</th>
                  <th scope="col">{t('products.form.sku')}</th>
                  <th scope="col" className="ui-num">
                    {t('stock.onHand')}
                  </th>
                  <th scope="col" className="ui-num">
                    {t('stock.available')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <tr key={`${row.store.id}-${row.variant.id}`}>
                    <th scope="row">{row.store.code}</th>
                    <td>{row.variant.sku}</td>
                    <td className="ui-num">{number(row.onHand)}</td>
                    <td className="ui-num">{number(row.available)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
    </Card>
  );
}

function ProductView({ product }: { readonly product: Product }) {
  const { t, label, money } = useI18n();
  const can = usePermissions();
  const manage = can('catalog:manage');
  // undefined: no dialog; null: adding a pack size; a variant: editing it.
  const [editing, setEditing] = useState<Variant | null | undefined>(undefined);
  const price = (paise: number | null) => (paise === null ? t('common.none') : money(paise));

  return (
    <>
      <PageHeader
        title={product.name}
        description={
          <span className="badges">
            <Badge tone="primary">{product.brand.name}</Badge>
            <Badge>{label('productTypes', product.type)}</Badge>
            {product.category !== null && <Badge>{product.category.name}</Badge>}
            {!product.isActive && <Badge tone="warning">{t('products.inactive')}</Badge>}
            <span className="muted">
              {t('products.detail.tax', { hsn: product.hsnCode, rate: product.gstRatePercent })}
            </span>
          </span>
        }
        actions={
          manage ? (
            <Link to={`/products/${product.id}/edit`} {...buttonStyle('secondary')}>
              {t('common.edit')}
            </Link>
          ) : undefined
        }
      />
      <div className="stack">
        {product.description !== null && (
          <Card>
            <p>{product.description}</p>
          </Card>
        )}
        <Card
          title={t('products.form.variants')}
          actions={
            manage ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditing(null);
                }}
              >
                {t('products.detail.addVariant')}
              </Button>
            ) : undefined
          }
        >
          <Table label={t('products.form.variants')}>
            <thead>
              <tr>
                <th scope="col">{t('products.form.sku')}</th>
                <th scope="col">{t('products.form.packSize')}</th>
                <th scope="col" className="ui-num">
                  {t('products.form.mrp')}
                </th>
                <th scope="col" className="ui-num">
                  {t('products.form.sellingPrice')}
                </th>
                <th scope="col">{t('products.form.barcodes')}</th>
                {manage && (
                  <th scope="col">
                    <span className="ui-visually-hidden">{t('common.edit')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {product.variants.map((variant) => (
                <tr key={variant.id}>
                  <th scope="row">
                    {variant.sku}
                    {!variant.isActive && (
                      <>
                        {' '}
                        <Badge>{t('products.inactive')}</Badge>
                      </>
                    )}
                  </th>
                  <td>
                    {String(variant.packSize)} {label('units', variant.unit)}
                  </td>
                  <td className="ui-num">{price(variant.mrpPaise)}</td>
                  <td className="ui-num">{price(variant.sellingPricePaise)}</td>
                  <td>
                    {variant.barcodes.length === 0 ? t('common.none') : variant.barcodes.join(', ')}
                  </td>
                  {manage && (
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing(variant);
                        }}
                      >
                        {t('products.detail.editVariant', { sku: variant.sku })}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        {can('inventory:read') && <StockByStore product={product} />}
      </div>
      {editing !== undefined && (
        <VariantDialog
          key={editing?.id ?? 'new'}
          product={product}
          variant={editing}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
    </>
  );
}

/** /products/:id */
export function ProductDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const product = useQuery({
    queryKey: ['product', id],
    queryFn: ({ signal }) => api.catalog.product(id, signal),
  });
  return (
    <QueryState query={product} error="products.detail.error">
      {(data) => <ProductView product={data} />}
    </QueryState>
  );
}
