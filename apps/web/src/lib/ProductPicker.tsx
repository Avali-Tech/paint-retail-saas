import { Button, Field, Input, Spinner } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Product, Variant } from '../api/catalog.js';
import { ApiError, errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue } from './hooks.js';
import { variantTitle } from './product-title.js';

/** A pack size chosen to go on a document (a movement, transfer, order…). */
export interface PickedVariant {
  readonly variantId: string;
  readonly sku: string;
  /** e.g. "Asian Paints Apex Ultima 1 l" or "Asian Paints Paint Brush 2 inch" */
  readonly name: string;
  readonly product: Product;
  readonly variant: Variant;
}

/** A product's size / pack as the picker hands it over. */
export const picked = (product: Product, variant: Variant): PickedVariant => ({
  variantId: variant.id,
  sku: variant.sku,
  name: variantTitle(product.brand.name, product.name, variant),
  product,
  variant,
});

export interface ProductPickerProps {
  /** Variants already on the document; they are not offered again. */
  readonly chosen: ReadonlySet<string>;
  readonly onChoose: (variant: PickedVariant) => void;
  /**
   * Also offer products and pack sizes no longer sold, e.g. to write off or
   * correct old stock. Otherwise they are left out (and refused when scanned).
   */
  readonly includeInactive?: boolean;
}

/**
 * Finds pack sizes to add to a document: type a name, brand or SKU to search,
 * or scan a barcode (the scanner types it and presses Enter) to add it at once.
 */
export function ProductPicker({ chosen, onChoose, includeInactive = false }: ProductPickerProps) {
  const api = useApi();
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const q = useDebouncedValue(text.trim(), 300);
  const results = useQuery({
    queryKey: ['products', { q, picker: true, includeInactive }],
    queryFn: ({ signal }) => api.catalog.products({ q, limit: 10, includeInactive }, signal),
    enabled: q.length >= 2,
  });
  const options = (results.data?.items ?? []).flatMap((product) =>
    product.variants
      .filter((variant) => (includeInactive || variant.isActive) && !chosen.has(variant.id))
      .map((variant) => picked(product, variant)),
  );

  const lookUp = async () => {
    const code = text.trim();
    if (code === '') return;
    setLooking(true);
    setMessage(null);
    try {
      // Discontinued packs too, so the member is told why one cannot be chosen.
      const found = await api.catalog.lookup(code, true);
      if (chosen.has(found.variant.id)) {
        setMessage(t('picker.alreadyAdded', { sku: found.variant.sku }));
      } else if (!includeInactive && !(found.product.isActive && found.variant.isActive)) {
        setMessage(t('picker.inactive', { sku: found.variant.sku }));
      } else {
        onChoose(picked(found.product, found.variant));
        setText('');
      }
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 404
          ? t('picker.notFound', { code })
          : errorMessage(error),
      );
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="stack">
      <Field label={t('picker.label')} hint={t('picker.hint')} error={message ?? undefined}>
        <Input
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMessage(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // Inside a document's form: Enter looks the code up instead of submitting it.
            event.preventDefault();
            void lookUp();
          }}
        />
      </Field>
      {(looking || results.isFetching) && <Spinner size="sm" label={t('common.loading')} />}
      {results.isSuccess && options.length === 0 && (
        <p className="muted">{t('picker.noResults')}</p>
      )}
      {options.length > 0 && (
        <ul className="record-list">
          {options.map((option) => (
            <li key={option.variantId} className="record-list__row">
              <span>
                <span className="record-list__title">{option.sku}</span>{' '}
                <span className="record-list__meta">{option.name}</span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onChoose(option);
                }}
              >
                {t('picker.add', { sku: option.sku })}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
