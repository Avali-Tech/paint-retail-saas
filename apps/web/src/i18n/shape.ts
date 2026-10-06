// Types shared by every language's message files.

/**
 * A message that depends on a count: "{count} day" / "{count} days". The language's
 * plural rules pick the form (Hindi uses "one" for 0 and 1, English and Telugu for 1).
 */
export interface Plural {
  readonly one: string;
  readonly other: string;
}

/**
 * The same keys as an English message object, with any text as values. A Hindi or
 * Telugu file is typed with it, so a missing, extra or misspelt key fails to compile:
 * `export const teamHi: Translation<typeof teamEn> = { … }`.
 */
export type Translation<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : Translation<T[K]>;
};
