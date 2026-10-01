import {
  Button,
  Icon,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from '@paint/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';

export const notificationsKey = ['notifications'] as const;
/** New notifications show up within a minute without a reload. */
export const NOTIFICATION_POLL_MS = 60_000;

/** "9+" once there are more than fit on the badge. */
export const badgeCount = (count: number) => (count > 9 ? '9+' : String(count));

/** The bell in the header: unread count, the latest notifications, mark as read. */
export function NotificationBell() {
  const api = useApi();
  const { t, relativeTime } = useI18n();
  const queryClient = useQueryClient();
  const notifications = useQuery({
    queryKey: notificationsKey,
    queryFn: () => api.notifications.list(),
    refetchInterval: NOTIFICATION_POLL_MS,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationsKey });
  const markRead = useMutation({ mutationFn: api.notifications.markRead, onSettled: refresh });
  const markAllRead = useMutation({
    mutationFn: api.notifications.markAllRead,
    onSettled: refresh,
  });

  const unread = notifications.data?.unread ?? 0;
  const label =
    unread > 0
      ? `${t('notifications.label')}, ${t('notifications.unread', { count: unread })}`
      : t('notifications.label');

  return (
    <Popover>
      <PopoverTrigger className="ui-icon-button" aria-label={label}>
        <Icon name="bell" />
        {unread > 0 && (
          <span className="bell-badge" aria-hidden="true">
            {badgeCount(unread)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent aria-label={t('notifications.label')}>
        <div className="notifications__header">
          <h2 className="notifications__title">{t('notifications.label')}</h2>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              loading={markAllRead.isPending}
              onClick={() => {
                markAllRead.mutate();
              }}
            >
              {t('notifications.markAllRead')}
            </Button>
          )}
        </div>
        {notifications.isPending && (
          <div className="notifications__status">
            <Spinner label={t('common.loading')} />
          </div>
        )}
        {notifications.isError && (
          <p className="notifications__status" role="alert">
            {t('notifications.error')}
          </p>
        )}
        {notifications.data?.items.length === 0 && (
          <p className="notifications__status">{t('notifications.empty')}</p>
        )}
        <ul className="notifications__list">
          {notifications.data?.items.map((item) => (
            <li key={item.id} data-unread={item.readAt === null ? '' : undefined}>
              <PopoverClose asChild>
                <Link
                  to={item.link}
                  className="notifications__item"
                  onClick={() => {
                    if (item.readAt === null) markRead.mutate(item.id);
                  }}
                >
                  <span className="notifications__item-title">{item.title}</span>
                  <span className="notifications__item-body">{item.body}</span>
                  <time className="notifications__time" dateTime={item.createdAt}>
                    {relativeTime(item.createdAt)}
                  </time>
                </Link>
              </PopoverClose>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
