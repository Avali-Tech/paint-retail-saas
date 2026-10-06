import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { setErrorTexts } from '../api/errors.js';
import {
  formatCompactMoney,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelativeTime,
} from '../lib/format.js';
import { en, type Messages } from './en.js';
import { hi } from './hi.js';
import { readLocale, saveLocale, type Locale } from './locale-store.js';
import { applyLanguage } from './script-font.js';
import type { Plural } from './shape.js';
import { te } from './te.js';

export { LOCALE_CODES, type Locale } from './locale-store.js';

interface LocaleInfo {
  /** The language's own name, the same in every language ("हिन्दी", not "Hindi"). */
  readonly label: string;
  /** The <html lang> value. */
  readonly lang: string;
  /** Formats: Indian grouping and India time in every language, always Latin digits. */
  readonly intl: string;
  readonly messages: Messages;
}

/** Languages the app offers. */
export const LOCALES: Readonly<Record<Locale, LocaleInfo>> = {
  en: { label: 'English', lang: 'en-IN', intl: 'en-IN', messages: en },
  hi: { label: 'हिन्दी', lang: 'hi-IN', intl: 'hi-IN-u-nu-latn', messages: hi },
  te: { label: 'తెలుగు', lang: 'te-IN', intl: 'te-IN-u-nu-latn', messages: te },
};

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends Plural
      ? never
      : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

type PluralLeaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends Plural
      ? `${Prefix}${K}`
      : PluralLeaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** A group of value names, e.g. "partyRoles" for customer/contractor/…. */
export type EnumGroup = keyof Messages['enums'];

/** "sub_dealer" -> "Sub dealer", for values a language has no name for yet. */
export function humanize(value: string): string {
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A pipeline stage's name ("qualified" -> "Qualified"); unknown ones are humanized. */
export function stageLabel(t: I18n['t'], stage: string): string {
  return stage in en.stages ? t(`stages.${stage as keyof typeof en.stages}`) : humanize(stage);
}

/** A message id such as "auth.signIn". */
export type MessageKey = Leaves<Messages>;
/** A count-dependent message id such as "team.moreStores" (see Plural). */
export type PluralKey = PluralLeaves<Messages>;
export type MessageParams = Readonly<Record<string, string | number>>;

function lookup(messages: Messages, key: string): unknown {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function fill(text: string, params: MessageParams): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

/** Looks up a message and fills in "{name}" placeholders. */
export function translate(messages: Messages, key: MessageKey, params: MessageParams = {}): string {
  return fill(String(lookup(messages, key)), params);
}

/**
 * The form of a count-dependent message that suits `count` in the language (`intl`),
 * with "{count}" written the Indian way (1,00,000) unless `params` gives it.
 */
export function translatePlural(
  messages: Messages,
  intl: string,
  key: PluralKey,
  count: number,
  params: MessageParams = {},
): string {
  const forms = lookup(messages, key) as Plural;
  const form = new Intl.PluralRules(intl).select(count) === 'one' ? forms.one : forms.other;
  return fill(form, { count: formatNumber(count, intl), ...params });
}

export interface I18n {
  readonly locale: Locale;
  readonly t: (key: MessageKey, params?: MessageParams) => string;
  /** plural('team.moreStores', 2) -> "2 other stores". */
  readonly plural: (key: PluralKey, count: number, params?: MessageParams) => string;
  readonly number: (value: number) => string;
  readonly money: (paise: number) => string;
  readonly compactMoney: (paise: number) => string;
  readonly date: (iso: string) => string;
  readonly dateTime: (iso: string) => string;
  readonly relativeTime: (iso: string) => string;
  /** The name of an API value, e.g. label('partyRoles', 'sub_dealer') -> "Sub-dealer". */
  readonly label: (group: EnumGroup, value: string) => string;
  /** Switches the app's language and remembers it on this device. */
  readonly setLocale: (locale: Locale) => void;
}

function ignoreLocale(): void {
  // Outside an I18nProvider there is nothing to switch.
}

export function createI18n(
  locale: Locale,
  setLocale: (locale: Locale) => void = ignoreLocale,
): I18n {
  const { intl, messages } = LOCALES[locale];
  return {
    locale,
    t: (key, params) => translate(messages, key, params),
    plural: (key, count, params) => translatePlural(messages, intl, key, count, params),
    number: (value) => formatNumber(value, intl),
    money: formatMoney,
    compactMoney: (paise) => formatCompactMoney(paise, intl),
    date: (iso) => formatDate(iso, intl),
    dateTime: (iso) => formatDateTime(iso, intl),
    relativeTime: (iso) => formatRelativeTime(iso, Date.now(), intl),
    label: (group, value) =>
      (messages.enums[group] as Readonly<Record<string, string | undefined>>)[value] ??
      humanize(value),
    setLocale,
  };
}

const I18nContext = createContext<I18n>(createI18n('en'));

/**
 * The app's language: the one chosen on this device (`storage`), or `locale` when given
 * (tests). Sets <html lang> and loads a font for the language's script.
 */
export function I18nProvider({
  locale: fixed,
  storage = localStorage,
  doc = document,
  children,
}: {
  readonly locale?: Locale;
  readonly storage?: Storage;
  readonly doc?: Document;
  readonly children: ReactNode;
}) {
  const [chosen, setChosen] = useState<Locale>(() => fixed ?? readLocale(storage));
  const setLocale = useCallback(
    (next: Locale) => {
      saveLocale(storage, next);
      setChosen(next);
    },
    [storage],
  );
  const value = useMemo(() => {
    setErrorTexts(LOCALES[chosen].messages.errors);
    return createI18n(chosen, setLocale);
  }, [chosen, setLocale]);
  useEffect(() => {
    applyLanguage(LOCALES[chosen].lang, chosen, doc);
  }, [chosen, doc]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

/** Messages and Indian number/date formats for the current language. */
export function useI18n(): I18n {
  return use(I18nContext);
}
