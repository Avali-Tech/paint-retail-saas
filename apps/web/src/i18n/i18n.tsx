import { createContext, use, useMemo, type ReactNode } from 'react';
import {
  formatCompactMoney,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelativeTime,
} from '../lib/format.js';
import { en, type Messages } from './en.js';

/** Languages the app offers. Hindi ("hi", hi-IN) and Telugu ("te", te-IN) join here. */
export const LOCALES = {
  en: { label: 'English', intl: 'en-IN', messages: en },
} as const satisfies Record<string, { label: string; intl: string; messages: Messages }>;
export type Locale = keyof typeof LOCALES;

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
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
export type MessageParams = Readonly<Record<string, string | number>>;

/** Looks up a message and fills in "{name}" placeholders. */
export function translate(messages: Messages, key: MessageKey, params: MessageParams = {}): string {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown>)[part];
  }
  return String(node).replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

export interface I18n {
  readonly locale: Locale;
  readonly t: (key: MessageKey, params?: MessageParams) => string;
  readonly number: (value: number) => string;
  readonly money: (paise: number) => string;
  readonly compactMoney: (paise: number) => string;
  readonly date: (iso: string) => string;
  readonly dateTime: (iso: string) => string;
  readonly relativeTime: (iso: string) => string;
  /** The name of an API value, e.g. label('partyRoles', 'sub_dealer') -> "Sub-dealer". */
  readonly label: (group: EnumGroup, value: string) => string;
}

export function createI18n(locale: Locale): I18n {
  const { intl, messages } = LOCALES[locale];
  return {
    locale,
    t: (key, params) => translate(messages, key, params),
    number: (value) => formatNumber(value, intl),
    money: formatMoney,
    compactMoney: (paise) => formatCompactMoney(paise, intl),
    date: (iso) => formatDate(iso, intl),
    dateTime: (iso) => formatDateTime(iso, intl),
    relativeTime: (iso) => formatRelativeTime(iso, Date.now(), intl),
    label: (group, value) =>
      (messages.enums[group] as Readonly<Record<string, string | undefined>>)[value] ??
      humanize(value),
  };
}

const I18nContext = createContext<I18n>(createI18n('en'));

export function I18nProvider({
  locale = 'en',
  children,
}: {
  readonly locale?: Locale;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => createI18n(locale), [locale]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

/** Messages and Indian number/date formats for the current language. */
export function useI18n(): I18n {
  return use(I18nContext);
}
