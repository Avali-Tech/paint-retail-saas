import { OPEN_ORDER_STATUSES, ORDERS_PERMISSION, type SalesOrderView } from '@paint/shared';
import { Button, Card, Select, Table, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';

/**
 * Stock per line per store the member can see (spec §5.3, §4.3): on hand, held for
 * orders and free. An open order reserves what is open, gives held stock back, or
 * moves a line to another store (released there, reserved here).
 */
export function OrderAvailability({ order }: { readonly order: SalesOrderView }) {
  const api = useApi();
  const can = usePermissions();
  const { t, number } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const availability = useQuery({
    queryKey: ['sales-orders', order.id, 'availability'],
    queryFn: ({ signal }) => api.orders.availability(order.id, signal),
  });
  const open = OPEN_ORDER_STATUSES.includes(order.status);
  const manage = open && can(ORDERS_PERMISSION);

  const run = async (call: () => Promise<SalesOrderView>, done: string) => {
    setBusy(true);
    try {
      const next = await call();
      queryClient.setQueryData(['sales-orders', order.id], next);
      await queryClient.invalidateQueries({ queryKey: ['sales-orders', order.id, 'availability'] });
      toast({ title: done, tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const actions = manage ? (
    <div className="row">
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onClick={() => {
          void run(() => api.orders.reserve(order.id, {}), t('orders.stock.reserved'));
        }}
      >
        {t('orders.stock.reserve')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={() => {
          void run(() => api.orders.release(order.id), t('orders.stock.released'));
        }}
      >
        {t('orders.stock.release')}
      </Button>
    </div>
  ) : undefined;

  return (
    <Card title={t('orders.stock.title')} actions={actions}>
      <QueryState query={availability} error="orders.stock.error">
        {(data) => (
          <Table label={t('orders.stock.table')}>
            <thead>
              <tr>
                <th scope="col">{t('sales.lines.item')}</th>
                <th scope="col">{t('orders.stock.open')}</th>
                <th scope="col">{t('orders.stock.held')}</th>
                <th scope="col">{t('orders.stock.stores')}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => {
                const description =
                  order.lines.find((candidate) => candidate.id === line.lineId)?.description ??
                  line.sku;
                return (
                  <tr key={line.lineId}>
                    <th scope="row">
                      {description}
                      <span className="cell-meta">{line.sku}</span>
                    </th>
                    <td>{number(line.quantityOpen)}</td>
                    <td>{number(line.quantityReserved)}</td>
                    <td>
                      <ul className="orders-stores">
                        {line.stores.map((store) => (
                          <li key={store.storeId}>
                            {t(
                              store.storeId === line.fulfilStoreId
                                ? 'orders.stock.fromHere'
                                : 'orders.stock.store',
                              {
                                store: store.storeName,
                                available: number(store.available),
                                onHand: number(store.onHand),
                                reserved: number(store.reserved),
                              },
                            )}
                          </li>
                        ))}
                      </ul>
                      {manage && line.quantityOpen > 0 && line.stores.length > 1 && (
                        <Select
                          aria-label={t('orders.stock.moveLine', { item: description })}
                          value={line.fulfilStoreId}
                          disabled={busy}
                          onChange={(event) => {
                            const fulfilStoreId = event.target.value;
                            void run(
                              () =>
                                api.orders.reserve(order.id, {
                                  lines: [{ lineId: line.lineId, fulfilStoreId }],
                                }),
                              t('orders.stock.moved'),
                            );
                          }}
                        >
                          {line.stores.map((store) => (
                            <option key={store.storeId} value={store.storeId}>
                              {t('orders.stock.fulfilFrom', { store: store.storeName })}
                            </option>
                          ))}
                        </Select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </QueryState>
    </Card>
  );
}
