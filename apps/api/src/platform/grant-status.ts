export type GrantStatus = 'pending' | 'declined' | 'active' | 'expired' | 'ended';

export interface GrantTimes {
  readonly approvedAt: Date | null;
  readonly declinedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly endedAt: Date | null;
}

/** Where a support grant stands at `now`. */
export function grantStatus(grant: GrantTimes, now = new Date()): GrantStatus {
  if (grant.declinedAt) return 'declined';
  if (grant.endedAt) return 'ended';
  if (!grant.approvedAt || !grant.expiresAt) return 'pending';
  return grant.expiresAt > now ? 'active' : 'expired';
}
