import type { MemberAccess } from '@paint/shared';

/**
 * Parties without a home store (suppliers, architects) are business-wide.
 * Parties with one are visible to members of that store and all-store members.
 */
export function canSeeParty(access: MemberAccess, party: { homeStoreId: string | null }): boolean {
  return access.allStores || party.homeStoreId === null || access.storeIds.has(party.homeStoreId);
}

/** A LIKE pattern matching `text` anywhere, with LIKE's special characters escaped. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** Digits to search phone numbers by, when the search text looks like a phone number. */
export function phoneSearchDigits(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  return /^[\d\s+()-]+$/.test(text) && digits.length >= 3 ? digits : null;
}
