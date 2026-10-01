import { schema } from '@paint/db';

export const NOTIFICATION_EVENTS = schema.notificationEvent.enumValues;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** How each event is described in the preferences screen. */
export const EVENT_TITLES: Record<NotificationEvent, string> = {
  transfer_awaiting_approval: 'A transfer needs your approval',
  transfer_awaiting_receipt: 'A transfer is on its way to your store',
  stock_count_awaiting_approval: 'A stock count needs your approval',
  low_stock: 'A product falls to its reorder level',
  follow_up_due: 'A follow-up assigned to you is due',
  support_access_requested: 'Platform support asks to access your business',
};
