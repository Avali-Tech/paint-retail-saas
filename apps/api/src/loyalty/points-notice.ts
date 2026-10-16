import type { Transaction } from '@paint/db';
import type { QueueResult } from '@paint/shared';
import { queueMessage } from '../messaging/outbox.js';

/** What the painter is told when an invoice earns them points (spec §6.5, template points_earned). */
export interface PointsEarnedNotice {
  readonly organizationId: string;
  /** The painter or contractor. */
  readonly partyId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly points: number;
  /** Their balance after the points. */
  readonly balance: number;
}

/**
 * Queues the `points_earned` WhatsApp message in the issuing transaction, so it
 * goes only if the invoice is issued (P2-M32 outbox). Nothing is queued without
 * the painter's consent; one message per invoice, so a retry never sends twice.
 */
export function queuePointsEarned(
  tx: Transaction,
  notice: PointsEarnedNotice,
  memberId: string,
): Promise<QueueResult> {
  return queueMessage(tx, {
    organizationId: notice.organizationId,
    partyId: notice.partyId,
    channel: 'whatsapp',
    templateKey: 'points_earned',
    variables: {
      points: String(notice.points),
      number: notice.invoiceNumber,
      balance: String(notice.balance),
    },
    reference: { type: 'tax_document', id: notice.invoiceId },
    dedupeKey: `points_earned:${notice.invoiceId}`,
    memberId,
  });
}
