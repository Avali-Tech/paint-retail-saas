import { type EstimateView } from '@paint/shared';
import { Alert } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { productIdsOf } from './estimate-form.js';
import { EstimateEditor } from './EstimateEditor.js';
import type { PaintProduct } from './estimator-api.js';

const NO_PRODUCTS: ReadonlyMap<string, PaintProduct> = new Map();
const ignoreSaved = () => undefined;

/** A saved estimate: the editor once its products' packs are loaded, or where it went. */
function SavedEstimate({ estimate }: { readonly estimate: EstimateView }) {
  const api = useApi();
  const { t, label } = useI18n();
  const ids = productIdsOf(estimate);
  const products = useQuery({
    queryKey: ['estimates', estimate.id, 'products', ids],
    queryFn: async ({ signal }) =>
      new Map(
        (await Promise.all(ids.map((id) => api.estimator.paintProduct(id, signal)))).map(
          (product) => [product.id, product] as const,
        ),
      ),
  });
  if (estimate.status === 'converted') {
    return (
      <Alert tone="info" title={t('estimator.editor.title', { number: estimate.number })}>
        <p>
          {t('estimator.converted.text', {
            number: String(estimate.quotationNumber),
            tier: label('estimateTiers', String(estimate.convertedTier)),
          })}
        </p>
        <Link to={`/quotations/${String(estimate.quotationId)}`}>
          {t('estimator.converted.open')}
        </Link>
      </Alert>
    );
  }
  return (
    <QueryState query={products} error="estimator.editor.error">
      {(loaded) => <EstimateEditor existing={estimate} products={loaded} onSaved={ignoreSaved} />}
    </QueryState>
  );
}

function LoadEstimate({ id }: { readonly id: string }) {
  const api = useApi();
  const estimate = useQuery({
    queryKey: ['estimates', id],
    queryFn: ({ signal }) => api.estimator.estimate(id, signal),
  });
  return (
    <QueryState query={estimate} error="estimator.editor.error">
      {(data) => <SavedEstimate key={data.id} estimate={data} />}
    </QueryState>
  );
}

/**
 * /estimates/new and /estimates/:id. A new estimate keeps its editor (and the rooms
 * as typed) when its first save moves the address to its id.
 */
export function EstimatePage() {
  const id = String(useParams().id);
  const navigate = useNavigate();
  const [createdId, setCreatedId] = useState<string | null>(null);
  if (id === 'new' || id === createdId) {
    return (
      <EstimateEditor
        existing={null}
        products={NO_PRODUCTS}
        onSaved={(estimate) => {
          if (estimate.id === createdId) return;
          setCreatedId(estimate.id);
          void navigate(`/estimates/${estimate.id}`, { replace: true });
        }}
      />
    );
  }
  return <LoadEstimate id={id} />;
}
