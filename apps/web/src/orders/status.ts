import type { QuotationStatus, SalesOrderStatus } from '@paint/shared';
import type { Tone } from '@paint/ui';

/** Rows per page of the quotation and order lists. */
export const PAGE_SIZE = 50;

export const QUOTATION_TONE: Record<QuotationStatus, Tone> = {
  draft: 'neutral',
  sent: 'primary',
  accepted: 'success',
  expired: 'warning',
  superseded: 'neutral',
  converted: 'success',
};

export const ORDER_TONE: Record<SalesOrderStatus, Tone> = {
  draft: 'neutral',
  confirmed: 'primary',
  partly_fulfilled: 'warning',
  fulfilled: 'success',
  cancelled: 'danger',
  closed: 'neutral',
};

/**
 * A WhatsApp share link (spec §5.3: `wa.me` until 2.1 sends the PDF itself): to the
 * customer's mobile when it is known (an Indian 10-digit number gets +91), else
 * WhatsApp asks whom to send it to.
 */
export function whatsappLink(phone: string | null, message: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  const number = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
