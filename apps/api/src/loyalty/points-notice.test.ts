import { Logger } from '@nestjs/common';
import type { Transaction } from '@paint/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PointsNotices, type PointsEarnedNotice } from './points-notice.js';

const notice: PointsEarnedNotice = {
  organizationId: 'org',
  partyId: 'party',
  partyName: 'Ravi Painter',
  phone: '+919812300002',
  invoiceId: 'invoice',
  invoiceNumber: 'AMP/26-27/000001',
  points: 24,
  balance: 130,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PointsNotices', () => {
  it('logs the points-earned message until the outbox takes it', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const notices = new PointsNotices();
    const tx = {} as Transaction;

    await notices.pointsEarned(tx, notice);
    await notices.pointsEarned(tx, { ...notice, phone: null });

    expect(log.mock.calls.map(([message]) => String(message))).toEqual([
      'points_earned to +919812300002: Ravi Painter earned 24 points on AMP/26-27/000001 (balance 130)',
      'points_earned to no mobile: Ravi Painter earned 24 points on AMP/26-27/000001 (balance 130)',
    ]);
  });
});
