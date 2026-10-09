import { Pagination, Spinner } from '@paint/ui';
import type { ListPageInfo } from '@paint/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { useI18n } from '../i18n/i18n.js';
import type { UrlFilters } from './hooks.js';

export interface ListPagerProps {
  /** Where the list is: the address's filters, or a list's own state. */
  readonly filters: Pick<UrlFilters<string>, 'offset' | 'setOffset'>;
  /** The page on screen. */
  readonly page: ListPageInfo & { readonly items: readonly unknown[] };
  readonly limit: number;
  /** Names the navigation, e.g. "Invoice pages". */
  readonly label: string;
}

/**
 * Previous and next for a keyset-paged MVP 2 list (round 6c): Next follows the API's
 * cursor, so page 200 is as quick as page 1; the offset stays in the address for the
 * "51–100 of 1,234" range. Past the API's count cap the range reads "of 10,000+".
 */
export function ListPager({ filters, page, limit, label }: ListPagerProps) {
  const { t, number } = useI18n();
  const shown = filters.offset + page.items.length;
  const total = page.totalCapped ? Math.max(page.total, shown) : page.total;
  return (
    <Pagination
      offset={filters.offset}
      limit={limit}
      total={total}
      hasMore={page.nextCursor !== null}
      onChange={(offset) => {
        filters.setOffset(offset, offset > filters.offset ? page.nextCursor : null);
      }}
      label={label}
      range={(from, to, all) =>
        t(page.totalCapped ? 'common.rangeMore' : 'common.range', {
          from: number(from),
          to: number(to),
          total: number(all),
        })
      }
      previousLabel={t('common.previous')}
      nextLabel={t('common.next')}
    />
  );
}

/** A small "Loading…" beside a list's filters while the next page or filter loads. */
export function ListRefreshing({ query }: { readonly query: UseQueryResult }) {
  const { t } = useI18n();
  if (!query.isPlaceholderData) return null;
  return (
    <span className="filters__note">
      <Spinner size="sm" label={t('common.loading')} />
    </span>
  );
}
