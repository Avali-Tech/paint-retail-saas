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
  contract_renewal_due: 'A contract assigned to you is due for renewal',
  credit_request_awaiting_approval: 'A credit request needs your approval',
  credit_request_decided: 'Your credit request is approved or rejected',
  loyalty_tier_reached: 'A customer you look after reaches a new loyalty tier',
  cheque_bounced: 'A cheque taken at your store bounces',
  register_variance: 'A register at your store closes with cash over or short',
  reconciliation_mismatch: 'The nightly check finds the books out of balance',
  credit_approval_requested: 'A sale on credit or a hold release needs your approval',
  credit_approval_decided: 'Your credit approval request is approved or rejected',
  credit_hold_applied: 'A customer is put on credit hold for overdue bills',
  promise_broken: 'A customer breaks a promise to pay',
};
