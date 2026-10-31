/** Where this device keeps the tab last opened in each section. */
export const LAST_TABS_KEY = 'paint.nav.lastTabs';

/**
 * The tab last opened in each section on this device, by section key. Anything
 * unreadable (private mode, blocked storage, a damaged value) reads as nothing.
 * Values are only compared with the section's tabs, so a stray one is harmless.
 */
export function readLastTabs(): Readonly<Partial<Record<string, string>>> {
  try {
    return (JSON.parse(localStorage.getItem(LAST_TABS_KEY) ?? '{}') ?? {}) as Partial<
      Record<string, string>
    >;
  } catch {
    return {};
  }
}

/** Remembers `path` as the tab last opened in `section`; does nothing when storage fails. */
export function rememberTab(section: string, path: string): void {
  try {
    localStorage.setItem(LAST_TABS_KEY, JSON.stringify({ ...readLastTabs(), [section]: path }));
  } catch {
    // Storage is full or blocked: the section opens at its first tab instead.
  }
}
