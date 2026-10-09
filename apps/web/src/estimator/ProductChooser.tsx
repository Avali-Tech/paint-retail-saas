import { productTitle } from '@paint/shared';
import { Button, Field, Input, Spinner } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ProductType } from '../api/catalog.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useDebouncedValue } from '../lib/hooks.js';
import type { PaintProduct } from './estimator-api.js';

export const paintProductName = (product: PaintProduct) =>
  productTitle(product.brand.name, product.name);

/** One product slot of an estimate (a tier's paint, the primer or the putty): search and choose. */
export function ProductChooser({
  label,
  hint,
  type,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  /** Offer only this type, e.g. primers for the primer. */
  readonly type?: ProductType;
  readonly value: PaintProduct | null;
  readonly onChange: (product: PaintProduct | null) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 300);
  const results = useQuery({
    queryKey: ['products', { q, type, estimator: true }],
    queryFn: ({ signal }) => api.estimator.paintProducts({ q, type, limit: 10 }, signal),
    enabled: picking && q.length >= 2,
  });
  const choices = (results.data?.items ?? []).filter((product) => product.isActive);
  return (
    <div className="estimator-product">
      <Field label={label} hint={hint}>
        <Input
          readOnly
          value={value === null ? '' : paintProductName(value)}
          placeholder={t('estimator.products.none')}
        />
      </Field>
      <div className="row">
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={picking}
          onClick={() => {
            setPicking(!picking);
          }}
        >
          {`${t('estimator.products.change')}: ${label}`}
        </Button>
        {value !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange(null);
            }}
          >
            {`${t('estimator.products.remove')}: ${label}`}
          </Button>
        )}
      </div>
      {picking && (
        <div className="stack">
          <Field label={t('estimator.products.search', { what: label })}>
            <Input
              type="search"
              autoFocus
              autoComplete="off"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          </Field>
          {results.isFetching && <Spinner size="sm" label={t('common.loading')} />}
          {results.isSuccess && choices.length === 0 && (
            <p className="muted">{t('estimator.products.noResults')}</p>
          )}
          {choices.length > 0 && (
            <ul className="record-list">
              {choices.map((product) => (
                <li key={product.id} className="record-list__row">
                  <span className="record-list__title">{paintProductName(product)}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onChange(product);
                      setPicking(false);
                      setText('');
                    }}
                  >
                    {t('estimator.products.choose', { name: paintProductName(product) })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
