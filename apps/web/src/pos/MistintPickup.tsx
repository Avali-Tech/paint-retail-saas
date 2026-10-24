import { Alert, Button } from '@paint/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import type { BillAction } from './bill.js';
import { itemOf } from './ScanBox.js';

/**
 * A mistinted can sent to the counter (Stock → Mistinted cans → Sell at the
 * counter, /pos?mistint=<id>): offered to the bill at its catalogue price, for
 * the cashier to discount. Only one waiting to be sold at this store.
 */
export function MistintPickup({
  storeId,
  dispatch,
}: {
  readonly storeId: string;
  readonly dispatch: (action: BillAction) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const id = params.get('mistint');
  const can = useQuery({
    queryKey: ['mistints', 'pickup', id],
    queryFn: async ({ signal }) => {
      const found = await api.mistints.get(String(id), signal);
      return { found, product: await api.catalog.product(found.product.id, signal) };
    },
    enabled: id !== null,
  });
  if (id === null || can.data === undefined) return null;
  const { found, product } = can.data;
  const variant = product.variants.find((candidate) => candidate.id === found.variant.id);
  const drop = () => {
    const next = new URLSearchParams(params);
    next.delete('mistint');
    setParams(next, { replace: true });
  };
  const problem =
    found.status !== 'available'
      ? t('pos.mistint.gone')
      : found.store.id !== storeId
        ? t('pos.mistint.otherStore', { store: found.store.code })
        : variant?.sellingPricePaise == null
          ? t('pos.mistint.noPrice')
          : null;
  return (
    <Alert tone={problem === null ? 'info' : 'warning'}>
      <p>
        {t('pos.mistint.offer', {
          sku: found.variant.sku,
          shade: found.shadeCode,
        })}
      </p>
      {problem === null && variant ? (
        <Button
          size="sm"
          onClick={() => {
            dispatch({
              type: 'addMistint',
              item: itemOf({ product, variant }, Number(variant.sellingPricePaise)),
              quantity: found.quantity,
              mistint: { id: found.id, shadeCode: found.shadeCode },
            });
            drop();
          }}
        >
          {t('pos.mistint.add')}
        </Button>
      ) : (
        <p>{problem}</p>
      )}
    </Alert>
  );
}
