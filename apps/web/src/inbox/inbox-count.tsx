import { useQuery } from '@tanstack/react-query';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';

/**
 * Every inbox query: the page and the badge's count. The refresh helpers of the
 * queues (credit, inventory, activities, collections) load them again after any
 * change, made here or on the queue's own screen.
 */
export const inboxKey = ['inbox'] as const;
export const inboxCountKey = ['inbox', 'count'] as const;
/** The badge catches up within a minute, and only while the app is in view. */
export const INBOX_POLL_MS = 60_000;

/** How many items wait on the member (0 until known, or if it cannot be loaded). */
export function useInboxCount(): number {
  const api = useApi();
  const count = useQuery({
    queryKey: inboxCountKey,
    queryFn: ({ signal }) => api.inbox.count(signal),
    refetchInterval: INBOX_POLL_MS,
  });
  return count.data?.total ?? 0;
}

/** "99+" once there are more than fit on the badge. */
export const inboxBadge = (count: number) => (count > 99 ? '99+' : String(count));

/**
 * The count on a menu entry or tab, seen only: the link says it in its name
 * (badgedName), the same in every browser. Nothing at 0.
 */
export function CountBadge({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <span className="count-badge" aria-hidden="true">
      {inboxBadge(count)}
    </span>
  );
}

/** The name of a link with a count, "Home, 3 waiting for you"; at 0, none (its text names it). */
export function useBadgedName(): (label: string, count: number) => string | undefined {
  const { t } = useI18n();
  return (label, count) => (count === 0 ? undefined : t('inbox.waiting', { label, count }));
}
