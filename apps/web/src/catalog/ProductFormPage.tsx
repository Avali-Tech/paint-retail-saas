import { zodResolver } from '@hookform/resolvers/zod';
import { basisPointsToPercent, isValidHsn, type TaxCategoryOptions } from '@paint/shared';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useFieldArray, useForm, useWatch, type Path } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { PRODUCT_TYPES, UNITS, type Brand, type Category, type Product } from '../api/catalog.js';
import { TAX_OPTIONS_KEY } from '../api/tax.js';
import { useApi } from '../app/services.js';
import { showApiError } from '../auth/forms.js';
import { useI18n, type I18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { optional } from '../lib/inputs.js';
import { categoryOptions, usableCategories } from './categories.js';
import { EMPTY_VARIANT, toVariantInput, variantSchema, type VariantDraft } from './variant-form.js';

/** The most pack sizes a new product may start with (the API's limit). */
export const MAX_VARIANTS = 50;

const variantPath = <K extends keyof VariantDraft>(index: number, key: K) =>
  `variants.${String(index)}.${key}` as `variants.${number}.${K}`;

/** `taxRequired`: a new product of a business registered for GST needs its tax category picked. */
function formSchema(t: I18n['t'], taxRequired: boolean) {
  return z.object({
    brandId: z.string().min(1, t('common.required')),
    categoryId: z.string(),
    name: z
      .string()
      .trim()
      .min(2, t('products.form.nameInvalid'))
      .max(120, t('products.form.nameInvalid')),
    type: z.enum(PRODUCT_TYPES),
    description: z.string(),
    hsnCode: z.string().refine((value) => isValidHsn(value.trim()), t('products.form.hsnInvalid')),
    taxCategoryId: z
      .string()
      .refine((value) => !taxRequired || value !== '', t('products.form.taxCategoryRequired')),
    isActive: z.boolean(),
    variants: z.array(variantSchema(t)),
  });
}

type Values = z.output<ReturnType<typeof formSchema>>;

const FIELDS = [
  'brandId',
  'categoryId',
  'name',
  'type',
  'description',
  'hsnCode',
  'taxCategoryId',
] as const satisfies readonly Path<Values>[];

export function initialValues(product: Product | null): Values {
  return {
    brandId: product?.brand.id ?? '',
    categoryId: product?.category?.id ?? '',
    name: product?.name ?? '',
    type: product?.type ?? 'interior_paint',
    description: product?.description ?? '',
    hsnCode: product?.hsnCode ?? '3209',
    // Blank: the default category (until the business registers for GST).
    taxCategoryId: product?.taxCategory?.id ?? '',
    isActive: product?.isActive ?? true,
    // Pack sizes of an existing product are edited one by one on its page.
    variants: product === null ? [{ ...EMPTY_VARIANT }] : [],
  };
}

interface ProductFormProps {
  readonly product: Product | null;
  readonly brands: readonly Brand[];
  readonly categories: readonly Category[];
  readonly tax: TaxCategoryOptions;
}

/** The form, once brands and categories are loaded (so its pickers start on the saved choice). */
function ProductForm({ product, brands, categories, tax }: ProductFormProps) {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taxRequired = tax.gstRegistered && product === null;
  const schema = useMemo(() => formSchema(t, taxRequired), [t, taxRequired]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: initialValues(product),
  });
  const variants = useFieldArray({ control: form.control, name: 'variants' });
  const [message, setMessage] = useState<string | null>(null);
  const activeBrands = brands.filter((brand) => brand.isActive || brand.id === product?.brand.id);
  // Inactive categories take no new products; the product's own stays on the list.
  const usable = new Set(
    usableCategories(categories, product?.category?.id ?? null).map((category) => category.id),
  );
  const { errors, isSubmitting } = form.formState;
  const savedTax = product?.taxCategory ?? null;
  // An inactive category takes no new products; the product's own stays on the list.
  const taxChoices = [
    ...tax.categories.map(({ id, name }) => ({ id, name })),
    ...(savedTax && !tax.categories.some((option) => option.id === savedTax.id) ? [savedTax] : []),
  ];
  const defaultTax = tax.categories.find((option) => option.isDefault);
  const chosenTaxId = useWatch({ control: form.control, name: 'taxCategoryId' });
  const chosenTax = tax.categories.find((option) => option.id === chosenTaxId);

  const save = async (values: Values) => {
    setMessage(null);
    const fields = {
      brandId: values.brandId,
      name: values.name.trim(),
      type: values.type,
      hsnCode: values.hsnCode.trim(),
      ...(values.taxCategoryId === '' || values.taxCategoryId === savedTax?.id
        ? {}
        : { taxCategoryId: values.taxCategoryId }),
    };
    try {
      const saved =
        product === null
          ? await api.catalog.createProduct({
              ...fields,
              ...(values.categoryId === '' ? {} : { categoryId: values.categoryId }),
              ...(optional(values.description) === null
                ? {}
                : { description: values.description.trim() }),
              variants: values.variants.map(toVariantInput),
            })
          : await api.catalog.updateProduct(product.id, {
              ...fields,
              categoryId: optional(values.categoryId),
              description: optional(values.description),
              isActive: values.isActive,
            });
      queryClient.setQueryData(['product', saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      toast({
        title: product === null ? t('products.form.created') : t('common.saved'),
        tone: 'success',
      });
      void navigate(`/products/${saved.id}`);
    } catch (error) {
      setMessage(showApiError(error, FIELDS, form.setError));
    }
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit(save)(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {activeBrands.length === 0 && <Alert tone="warning">{t('products.form.noBrands')}</Alert>}
      <Card>
        <div className="form-grid">
          <Field label={t('products.form.brand')} required error={errors.brandId?.message}>
            <Select {...form.register('brandId')}>
              <option value="">{t('products.form.chooseBrand')}</option>
              {activeBrands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('products.form.category')}>
            <Select {...form.register('categoryId')}>
              <option value="">{t('products.form.noCategory')}</option>
              {categoryOptions(categories)
                .filter((category) => usable.has(category.id))
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('products.form.name')} required error={errors.name?.message}>
            <Input autoComplete="off" {...form.register('name')} />
          </Field>
          <Field label={t('products.form.type')}>
            <Select {...form.register('type')}>
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {label('productTypes', type)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('products.form.hsn')} required error={errors.hsnCode?.message}>
            <Input inputMode="numeric" maxLength={8} {...form.register('hsnCode')} />
          </Field>
          <Field
            label={t('products.form.taxCategory')}
            required={taxRequired}
            hint={
              chosenTax?.currentRateBps == null
                ? undefined
                : t('products.form.taxCategoryHint', {
                    rate: basisPointsToPercent(chosenTax.currentRateBps),
                  })
            }
            error={errors.taxCategoryId?.message}
          >
            <Select {...form.register('taxCategoryId')}>
              {savedTax === null && (
                <option value="">
                  {!tax.gstRegistered && defaultTax
                    ? t('products.form.defaultTaxCategory', { name: defaultTax.name })
                    : t('products.form.chooseTaxCategory')}
                </option>
              )}
              {taxChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('products.form.description')} className="form-wide">
          <Textarea maxLength={2000} {...form.register('description')} />
        </Field>
        {product !== null && (
          <Checkbox label={t('products.form.active')} {...form.register('isActive')} />
        )}
      </Card>

      {product === null && (
        <Card title={t('products.form.variants')}>
          <div className="stack">
            {variants.fields.map((field, index) => {
              const number = index + 1;
              const fieldErrors = errors.variants?.[index];
              return (
                <fieldset key={field.id} className="variant-row">
                  <legend>{t('products.form.variant', { number })}</legend>
                  <div className="form-grid">
                    <Field
                      label={t('products.form.sku')}
                      required
                      error={fieldErrors?.sku?.message}
                    >
                      <Input className="uppercase" {...form.register(variantPath(index, 'sku'))} />
                    </Field>
                    <Field
                      label={t('products.form.packSize')}
                      required
                      error={fieldErrors?.packSize?.message}
                    >
                      <Input
                        inputMode="decimal"
                        {...form.register(variantPath(index, 'packSize'))}
                      />
                    </Field>
                    <Field label={t('products.form.unit')}>
                      <Select {...form.register(variantPath(index, 'unit'))}>
                        {UNITS.map((unit) => (
                          <option key={unit} value={unit}>
                            {label('units', unit)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label={t('products.form.label')}
                      hint={t('products.form.labelHint')}
                      error={fieldErrors?.label?.message}
                    >
                      <Input {...form.register(variantPath(index, 'label'))} />
                    </Field>
                    <Field label={t('products.form.mrp')} error={fieldErrors?.mrp?.message}>
                      <Input inputMode="decimal" {...form.register(variantPath(index, 'mrp'))} />
                    </Field>
                    <Field
                      label={t('products.form.sellingPrice')}
                      error={fieldErrors?.sellingPrice?.message}
                    >
                      <Input
                        inputMode="decimal"
                        {...form.register(variantPath(index, 'sellingPrice'))}
                      />
                    </Field>
                    <Field
                      label={t('products.form.barcodes')}
                      hint={t('products.form.barcodesHint')}
                      error={fieldErrors?.barcodes?.message}
                    >
                      <Input {...form.register(variantPath(index, 'barcodes'))} />
                    </Field>
                  </div>
                  {variants.fields.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        variants.remove(index);
                      }}
                    >
                      {t('products.form.removeVariant', { number })}
                    </Button>
                  )}
                </fieldset>
              );
            })}
            {variants.fields.length < MAX_VARIANTS && (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    variants.append({ ...EMPTY_VARIANT });
                  }}
                >
                  {t('products.form.addVariant')}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="row row--end">
        <Button type="submit" loading={isSubmitting}>
          {product === null ? t('products.form.create') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Loads brands and categories, then shows the form. */
function ProductFormLoader({ product }: { readonly product: Product | null }) {
  const api = useApi();
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.catalog.categories(),
  });
  const tax = useQuery({
    queryKey: TAX_OPTIONS_KEY,
    queryFn: ({ signal }) => api.tax.options(signal),
  });
  return (
    <QueryState query={brands} error="catalogSetup.error">
      {(brandList) => (
        <QueryState query={categories} error="catalogSetup.error">
          {(categoryList) => (
            <QueryState query={tax} error="catalogSetup.error">
              {(options) => (
                <ProductForm
                  product={product}
                  brands={brandList}
                  categories={categoryList}
                  tax={options}
                />
              )}
            </QueryState>
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

/** /products/new */
export function NewProductPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('products.form.newTitle')} />
      <ProductFormLoader product={null} />
    </>
  );
}

/** /products/:id/edit */
export function EditProductPage() {
  const api = useApi();
  const { t } = useI18n();
  const id = String(useParams().id);
  const product = useQuery({
    queryKey: ['product', id],
    queryFn: ({ signal }) => api.catalog.product(id, signal),
  });
  return (
    <QueryState query={product} error="products.detail.error">
      {(record) => (
        <>
          <PageHeader title={t('products.form.editTitle', { name: record.name })} />
          <ProductFormLoader product={record} />
        </>
      )}
    </QueryState>
  );
}
