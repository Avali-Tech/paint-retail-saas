/**
 * How long stock may go without a sale or transfer out before it counts as
 * slow: the windows the Slow movers screen offers and the slow-mover alert
 * may use (Settings → Stock alerts), in days.
 */
export const SLOW_MOVER_WINDOWS = [45, 90, 180, 365] as const;
export type SlowMoverWindow = (typeof SLOW_MOVER_WINDOWS)[number];
