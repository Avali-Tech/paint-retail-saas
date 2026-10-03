import {
  Badge,
  Card,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  Select,
  Table,
  buttonStyle,
} from '@paint/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { TRANSFER_STATUSES, type TransferStatus } from '../api/transfers.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { useUrlFilters } from '../lib/hooks.js';
import { QueryState } from '../lib/QueryState.js';
import { SectionNav } from '../lib/SectionNav.js';
import { STOCK_SECTIONS } from '../stock/sections.js';
import { StoreSelect } from '../stock/StoreSelect.js';
import { TRANSFER_TONE } from './quantity.js';

export const PAGE_SIZE = 50;
const FILTERS = ['status', 'direction', 'store'] as const;

/** /transfers — stock moving between the member's stores. */
export function TransfersPage() {
  const api = useApi();
  const { t, label, date, number } = useI18n();
  const can = usePermissions();
  const filters = useUrlFilters(FILTERS);
  const { status, direction, store } = filters.values;
  const filtered = status !== '' || direction !== '' || store !== '';
  const transfers = useQuery({
    queryKey: ['transfers', { status, direction, store, offset: filters.offset }],
    queryFn: ({ signal }) =>
      api.transfers.list(
        {
          status: (status || undefined) as TransferStatus | undefined,
          direction: (direction || undefined) as 'incoming' | 'outgoing' | undefined,
          storeId: store || undefined,
          limit: PAGE_SIZE,
          offset: filters.offset,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <SectionNav label="stock.sections.label" links={STOCK_SECTIONS} />
      <PageHeader
        title={t('transfers.title')}
        description={t('transfers.description')}
        actions={
          can('inventory:manage') ? (
            <Link to="/transfers/new" {...buttonStyle()}>
              {t('transfers.new')}
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="filters">
          <Field label={t('transfers.status')}>
            <Select
              value={status}
              onChange={(event) => {
                filters.set('status', event.target.value);
              }}
            >
              <option value="">{t('transfers.allStatuses')}</option>
              {TRANSFER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {label('transferStatus', value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('transfers.direction')}>
            <Select
              value={direction}
              onChange={(event) => {
                filters.set('direction', event.target.value);
              }}
            >
              <option value="">{t('transfers.bothDirections')}</option>
              <option value="incoming">{t('transfers.incoming')}</option>
              <option value="outgoing">{t('transfers.outgoing')}</option>
            </Select>
          </Field>
          <StoreSelect
            label={t('transfers.store')}
            value={store}
            emptyLabel={t('transfers.allStores')}
            onChange={(value) => {
              filters.set('store', value);
            }}
          />
        </div>
        <QueryState query={transfers} error="transfers.error">
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState
                icon={<Icon name="stock" size={32} />}
                title={filtered ? t('transfers.noMatches') : t('transfers.emptyTitle')}
                {...(filtered ? {} : { description: t('transfers.emptyDescription') })}
              />
            ) : (
              <>
                <Table label={t('transfers.list')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('transfers.number')}</th>
                      <th scope="col">{t('transfers.route')}</th>
                      <th scope="col">{t('transfers.status')}</th>
                      <th scope="col">{t('transfers.requested')}</th>
                      <th scope="col" className="ui-num">
                        {t('transfers.lines')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((transfer) => (
                      <tr key={transfer.id}>
                        <th scope="row">
                          <Link to={`/transfers/${transfer.id}`}>{transfer.number}</Link>
                        </th>
                        <td>
                          {t('transfers.routeValue', {
                            from: transfer.from.code,
                            to: transfer.to.code,
                          })}
                        </td>
                        <td>
                          <Badge tone={TRANSFER_TONE[transfer.status]}>
                            {label('transferStatus', transfer.status)}
                          </Badge>
                        </td>
                        <td>{date(transfer.requestedAt)}</td>
                        <td className="ui-num">{number(transfer.lineCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  offset={filters.offset}
                  limit={PAGE_SIZE}
                  total={page.total}
                  onChange={filters.setOffset}
                  label={t('transfers.pages')}
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
