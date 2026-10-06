// Remembers each person's language on this device. The API has no per-user language
// setting yet, so the choice does not follow someone to another phone or computer.

export const LOCALE_CODES = ['en', 'hi', 'te'] as const;
export type Locale = (typeof LOCALE_CODES)[number];

export const LOCALE_KEY = 'paint.locale';

export function isLocale(value: unknown): value is Locale {
  return LOCALE_CODES.some((code) => code === value);
}

/** The language chosen on this device, or English. Unreadable storage counts as no choice. */
export function readLocale(storage: Pick<Storage, 'getItem'>): Locale {
  try {
    const stored = storage.getItem(LOCALE_KEY);
    return isLocale(stored) ? stored : 'en';
  } catch {
    return 'en';
  }
}

/** Keeps the choice for the next visit; a full or blocked storage only loses the memory. */
export function saveLocale(storage: Pick<Storage, 'setItem'>, locale: Locale): void {
  try {
    storage.setItem(LOCALE_KEY, locale);
  } catch {
    // Private mode or full storage: the language still changes for this visit.
  }
}
