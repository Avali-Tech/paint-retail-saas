import 'reflect-metadata';
import { Injectable, Logger } from '@nestjs/common';
import type { Transaction } from '@paint/db';

/** What the painter is told when an invoice earns them points (spec §6.5, template points_earned). */
export interface PointsEarnedNotice {
  readonly organizationId: string;
  /** The painter or contractor. */
  readonly partyId: string;
  readonly partyName: string;
  readonly phone: string | null;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly points: number;
  /** Their balance after the points. */
  readonly balance: number;
}

/**
 * Queues the points-earned message in the issuing transaction, so it is sent
 * only if the invoice is. This is the seam for the messaging outbox.
 *
 * TODO(P2-M32, round 2a): replace this logging implementation with one that
 * inserts a `message_outbox` row (channel whatsapp, template `points_earned`,
 * variables name / points / invoice / balance) in `tx`, once 2a's outbox,
 * templates and consents are merged; skip parties without a WhatsApp opt-in.
 */
@Injectable()
export class PointsNotices {
  private readonly logger = new Logger('PointsNotices');

  pointsEarned(_tx: Transaction, notice: PointsEarnedNotice): Promise<void> {
    this.logger.log(
      `points_earned to ${notice.phone ?? 'no mobile'}: ${notice.partyName} earned ` +
        `${String(notice.points)} points on ${notice.invoiceNumber} (balance ${String(notice.balance)})`,
    );
    return Promise.resolve();
  }
}
