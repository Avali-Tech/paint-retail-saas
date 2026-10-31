import { Card, EmptyState, Icon, PageHeader, Pagination, Table, buttonStyle } from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { SupplierSelect } from './shared.js';

export const PAGE_SIZE = 50;
const FILTERS = ['store', 'supplier'] as const;

/** /goods-receipts — stock received from suppliers. */
export function GoodsReceiptsPage() {
  const api = useApi();
  const { t, money, dateTime } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { store, supplier } = filters.values;
  const filtered = store !== '' || supplier !== '';
  const receipts = useQuery({
    queryKey: ['goods-receipts', { store, supplier, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.purchasing.receipts(
        {
          storeId: store || undefined,
          supplierId: supplier || undefined,
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
        title={t('purchasing.receiptList.title')}
        description={t('purchasing.receiptList.description')}
        actions={
          can('purchasing:manage') ? (
            <Link to="/goods-receipts/new" {...buttonStyle()}>
              {t('purchasing.receiptList.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <StoreSelect
            label={t('purchasing.store')}
            value={store}
            emptyLabel={t('purchasing.allStores')}
            onChange={(value) => {
              filters.set('store', value);
            }}
          />
          <SupplierSelect
            label={t('purchasing.supplier')}
            value={supplier}
            emptyLabel={t('purchasing.allSuppliers')}
            onChange={(value) => {
              filters.set('supplier', value);
            }}
          />
        </div>
        <QueryState query={receipts} error="purchasing.receiptList.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="purchasing" size={32} />}
                title={
                  filtered
                    ? t('purchasing.receiptList.noMatches')
                    : t('purchasing.receiptList.emptyTitle')
                }
                {...(filtered ? {} : { description: t('purchasing.receiptList.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('purchasing.receiptList.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('purchasing.receiptList.number')}</th>
                      <th scope="col">{t('purchasing.supplier')}</th>
                      <th scope="col">{t('purchasing.store')}</th>
                      <th scope="col">{t('purchasing.receiptList.order')}</th>
                      <th scope="col">{t('purchasing.receiptList.invoice')}</th>
                      <th scope="col">{t('purchasing.receiptList.receivedAt')}</th>
                      <th scope="col" className="ui-num">
                        {t('purchasing.value')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((receipt) => (
                      <tr key={receipt.id}>
                        <th scope="row">
                          <Link to={`/goods-receipts/${receipt.id}`}>{receipt.number}</Link>
                        </th>
                        <td>{receipt.supplier.name}</td>
                        <td>{receipt.store.code}</td>
                        <td>{receipt.purchaseOrderNumber ?? t('common.none')}</td>
                        <td>{receipt.supplierInvoiceNumber ?? t('common.none')}</td>
                        <td>{dateTime(receipt.receivedAt)}</td>
                        <td className="ui-num">{money(receipt.totalValuePaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('purchasing.receiptList.pages')}
                  range={(from, to, total) => t('common.range', { from, to, total })}
                  previousLabel={t('common.previous')}
                  nextLabel={t('common.next')}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
