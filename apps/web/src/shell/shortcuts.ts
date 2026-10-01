import type { QuickAction } from '@paint/shared';
import { useEffect, useEffectEvent } from 'react';

/** Two keys pressed within this time form a shortcut such as "N C". */
export const SHORTCUT_WINDOW_MS = 1500;

/**
 * Matches two-key shortcuts ("N C" = new customer) as keys arrive. Returns the
 * action when the second key completes one, otherwise null.
 */
export function createShortcutMatcher(now: () => number = Date.now) {
  let pending: { key: string; at: number } | null = null;
  return (actions: readonly QuickAction[], key: string): QuickAction | null => {
    const pressed = key.toUpperCase();
    const at = now();
    if (pending && at - pending.at <= SHORTCUT_WINDOW_MS) {
      const combo = `${pending.key} ${pressed}`;
      const action = actions.find((candidate) => candidate.shortcut === combo);
      if (action) {
        pending = null;
        return action;
      }
    }
    pending = { key: pressed, at };
    return null;
  };
}

/** True when keys typed here are text, not shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * Keyboard shortcuts across the app: "/" jumps to search, and each quick
 * action's two-key shortcut opens it. Ignored while typing in a field.
 */
export function useShortcuts(
  actions: readonly QuickAction[],
  onSearch: () => void,
  onAction: (action: QuickAction) => void,
): void {
  const onKey = useEffectEvent(
    (event: KeyboardEvent, match: ReturnType<typeof createShortcutMatcher>) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (event.key === '/') {
        event.preventDefault();
        onSearch();
        return;
      }
      if (event.key.length !== 1) return;
      const action = match(actions, event.key);
      if (action) onAction(action);
    },
  );

  useEffect(() => {
    const match = createShortcutMatcher();
    const onKeyDown = (event: KeyboardEvent) => {
      onKey(event, match);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
