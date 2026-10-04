import type { Tone } from '@paint/ui';
import type { TransferStatus } from '../api/transfers.js';

/** A quantity typed by a person: 0 or more with at most 3 decimals ("2", "1.5"); null otherwise. */
export function parseNonNegative(text: string): number | null {
  const value = text.trim();
  return /^\d+(\.\d{1,3})?$/.test(value) ? Number(value) : null;
}

/** How each transfer status is coloured. */
export const TRANSFER_TONE: Record<TransferStatus, Tone> = {
  requested: 'warning',
  approved: 'info',
  in_transit: 'primary',
  received: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};
