import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { useServices } from '../app/services.js';
import type { PlatformEndpoints, PlatformSession } from './platform-api.js';
import type { PlatformSessionState } from './platform-session-store.js';

/** Every platform query key starts with this, so signing in or out clears only the console's data. */
export const PLATFORM_QUERY = 'platform';

export function usePlatformApi(): PlatformEndpoints {
  return useServices().platform.api;
}

export function usePlatformSession(): PlatformSessionState {
  const { sessions } = useServices().platform;
  return useSyncExternalStore(sessions.subscribe, sessions.getState);
}

export function useStartPlatformSession(): (session: PlatformSession) => void {
  const { sessions } = useServices().platform;
  const queryClient = useQueryClient();
  return useCallback(
    (session: PlatformSession) => {
      queryClient.removeQueries({ queryKey: [PLATFORM_QUERY] });
      sessions.start(session);
    },
    [queryClient, sessions],
  );
}

/** Ends the operator's session on the server (best effort) and on this device. */
export function usePlatformSignOut(): () => Promise<void> {
  const { api, sessions } = useServices().platform;
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Signed out here regardless; the server session expires on its own.
    }
    sessions.end('signed-out');
    queryClient.removeQueries({ queryKey: [PLATFORM_QUERY] });
  }, [api, queryClient, sessions]);
}
