import type { Permission } from '@paint/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import type { Profile, SessionGrant } from '../api/types.js';
import { useServices } from '../app/services.js';
import type { SessionState } from './session-store.js';

export function useSession(): SessionState {
  const { sessions } = useServices();
  return useSyncExternalStore(sessions.subscribe, sessions.getState);
}

export const profileKey = (organizationId: string | undefined) => ['me', organizationId] as const;

/** The signed-in member (GET /auth/me), loaded once per session. */
export function useProfile() {
  const { api } = useServices();
  const { session } = useSession();
  return useQuery({
    queryKey: profileKey(session?.organizationId),
    queryFn: ({ signal }) => api.auth.me(signal),
    enabled: session !== null,
    staleTime: 5 * 60_000,
  });
}

/** The signed-in member, inside pages behind RequireAuth (which waits for it to load). */
export function useCurrentProfile(): Profile {
  const { data } = useProfile();
  if (!data) throw new Error('useCurrentProfile must be used inside <RequireAuth>');
  return data;
}

/** Whether the signed-in member holds a permission. */
export function usePermissions(): (permission: Permission) => boolean {
  const profile = useProfile().data;
  return useCallback(
    (permission: Permission) => profile?.permissions.includes(permission) ?? false,
    [profile],
  );
}

/** Starts a session from a sign-in answer, forgetting anything cached from a previous one. */
export function useStartSession(): (grant: SessionGrant) => void {
  const { sessions } = useServices();
  const queryClient = useQueryClient();
  return useCallback(
    (grant: SessionGrant) => {
      queryClient.clear();
      sessions.start(grant);
    },
    [queryClient, sessions],
  );
}

/** Ends the session on the server (best effort) and on this device. */
export function useSignOut(): () => Promise<void> {
  const { api, sessions } = useServices();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // Signed out on this device regardless; the server session expires on its own.
    }
    sessions.end('signed-out');
    queryClient.clear();
  }, [api, queryClient, sessions]);
}

export type { Profile };
