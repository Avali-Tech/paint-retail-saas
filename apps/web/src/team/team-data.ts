import { useQuery } from '@tanstack/react-query';
import type { Member } from '../api/team.js';
import { useApi } from '../app/services.js';
import type { I18n } from '../i18n/i18n.js';

export const membersKey = ['members'] as const;
export const rolesKey = ['roles'] as const;

/** The team (GET /members): the people the signed-in member can see. */
export function useMembers({ enabled }: { readonly enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: membersKey,
    queryFn: ({ signal }) => api.team.members(signal),
    enabled,
  });
}

/** The business's roles (GET /roles). */
export function useRoles() {
  const api = useApi();
  return useQuery({ queryKey: rolesKey, queryFn: ({ signal }) => api.team.roles(signal) });
}

/**
 * Where a member works, as the viewer can name it: "All stores", the codes of
 * the stores the viewer knows, and how many others there are.
 */
export function storeSummary(
  member: Pick<Member, 'allStores' | 'storeIds'>,
  stores: readonly { readonly id: string; readonly code: string }[],
  { t, plural }: Pick<I18n, 't' | 'plural'>,
): string {
  if (member.allStores) return t('team.allStores');
  if (member.storeIds.length === 0) return t('team.noStores');
  const codes = stores.filter((store) => member.storeIds.includes(store.id)).map((s) => s.code);
  const others = member.storeIds.length - codes.length;
  return [...codes, ...(others > 0 ? [plural('team.moreStores', others)] : [])].join(', ');
}

/** True when `member` matches every word of a search across name, mobile and email. */
export function matchesSearch(member: Member, query: string): boolean {
  const text = [member.user.fullName, member.user.phone, member.user.email]
    .filter((part) => part !== null)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .every((word) => text.includes(word));
}
