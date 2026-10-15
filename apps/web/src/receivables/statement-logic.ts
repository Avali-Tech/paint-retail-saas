import type { PrintLanguage } from '@paint/shared';
import { isDate } from '../lib/india-time.js';

/** 1 April of the financial year `today` falls in: India's books run April to March. */
export function financialYearStart(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return `${String(month >= 4 ? year : year - 1)}-04-01`;
}

export interface StatementChoice {
  readonly from: string;
  readonly to: string;
  readonly lang: PrintLanguage;
  /** True when "to" is before "from": nothing is asked of the server. */
  readonly backwards: boolean;
}

const LANGUAGES: readonly PrintLanguage[] = ['en', 'hi', 'te'];

/**
 * The period and language the address asks for, else this financial year up to
 * today and the member's own language: one click from the party gives a statement.
 */
export function statementChoice(
  values: { readonly from: string; readonly to: string; readonly lang: string },
  today: string,
  locale: PrintLanguage,
): StatementChoice {
  const to = isDate(values.to) ? values.to : today;
  const from = isDate(values.from) ? values.from : financialYearStart(to);
  const lang = LANGUAGES.find((language) => language === values.lang) ?? locale;
  return { from, to, lang, backwards: to < from };
}
