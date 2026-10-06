import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { hi } from './hi.js';
import { I18nProvider, LOCALES, createI18n, translate, translatePlural, useI18n } from './i18n.js';
import { LOCALE_KEY } from './locale-store.js';
import { te } from './te.js';

describe('translate', () => {
  it('looks up nested messages and fills in placeholders', () => {
    expect(translate(en, 'auth.signIn')).toBe('Sign in');
    expect(translate(en, 'auth.title', { appName: 'Sri Balaji Paints' })).toBe(
      'Sign in to Sri Balaji Paints',
    );
    expect(translate(en, 'notifications.unread', { count: 3 })).toBe('3 unread');
  });

  it('leaves a placeholder visible when its value is missing', () => {
    expect(translate(en, 'auth.codeSentTo')).toBe('Enter the code sent to {phone}');
  });
});

describe('translatePlural', () => {
  it('picks the English form for the count, with Indian grouping', () => {
    expect(translatePlural(en, 'en-IN', 'team.moreStores', 1)).toBe('1 other store');
    expect(translatePlural(en, 'en-IN', 'team.moreStores', 0)).toBe('0 other stores');
    expect(translatePlural(en, 'en-IN', 'dashboard.skus', 123456)).toBe('1,23,456 SKUs');
  });

  it('fills in other placeholders, and a given count wins', () => {
    expect(
      translatePlural(en, 'en-IN', 'stock.lowStock.poSelected', 2, { store: 'Ameerpet' }),
    ).toBe('For the 2 selected items at Ameerpet');
    expect(translatePlural(en, 'en-IN', 'credit.daysValue', 5, { count: 'five' })).toBe(
      'five days',
    );
  });

  it('follows each language’s rules: Hindi says 0 like 1, Telugu like 2', () => {
    const hiOne = translatePlural(hi, LOCALES.hi.intl, 'credit.daysValue', 1);
    expect(translatePlural(hi, LOCALES.hi.intl, 'team.moreStores', 0)).toBe(
      translatePlural(hi, LOCALES.hi.intl, 'team.moreStores', 1).replace('1', '0'),
    );
    expect(hiOne).toBe(hi.credit.daysValue.one.replace('{count}', '1'));
    expect(translatePlural(te, LOCALES.te.intl, 'team.moreStores', 0)).toBe(
      te.team.moreStores.other.replace('{count}', '0'),
    );
    expect(translatePlural(te, LOCALES.te.intl, 'team.moreStores', 1)).toBe(
      te.team.moreStores.one.replace('{count}', '1'),
    );
  });
});

describe('createI18n', () => {
  it('formats numbers, money and dates the Indian way', () => {
    const i18n = createI18n('en');
    expect(i18n.locale).toBe('en');
    expect(i18n.number(1234567)).toBe('12,34,567');
    expect(i18n.money(12_345_00)).toBe('₹12,345.00');
    expect(i18n.compactMoney(25_00_000_00)).toBe('₹25 L');
    expect(i18n.date('2026-10-01T06:00:00Z')).toBe('1 Oct 2026');
    expect(i18n.dateTime('2026-10-01T06:00:00Z')).toBe('1 Oct 2026, 11:30 am');
    expect(i18n.relativeTime(new Date().toISOString())).toBe('now');
    expect(i18n.plural('team.moreStores', 3)).toBe('3 other stores');
    expect(LOCALES.en.intl).toBe('en-IN');
  });

  it.each(['hi', 'te'] as const)('keeps Indian formats and Latin digits in %s', (locale) => {
    const i18n = createI18n(locale);
    expect(i18n.t('auth.signIn')).toBe(LOCALES[locale].messages.auth.signIn);
    expect(i18n.number(1234567)).toBe('12,34,567');
    expect(i18n.money(12_345_00)).toBe('₹12,345.00');
    expect(i18n.compactMoney(25_00_000_00)).toBe('₹25 L');
    expect(i18n.compactMoney(1_25_00_000_00)).toBe('₹1.25 Cr');
    // 1 October 2026, 11:30 in India: the month's name is the language's, digits are Latin.
    expect(i18n.date('2026-10-01T06:00:00Z')).toMatch(/^1,? \S+ 2026$/);
    expect(i18n.dateTime('2026-10-01T06:00:00Z')).toMatch(/11:30/);
    expect(i18n.relativeTime('2020-01-01T06:00:00Z')).toMatch(/2020/);
    expect(i18n.label('partyRoles', 'customer')).toBe(
      LOCALES[locale].messages.enums.partyRoles.customer,
    );
  });

  it('switches nothing outside a provider', () => {
    const i18n = createI18n('en');
    i18n.setLocale('hi');
    expect(i18n.locale).toBe('en');
  });
});

function Greeting() {
  const { t, locale, setLocale } = useI18n();
  return (
    <>
      <p>{t('dashboard.title')}</p>
      <button
        type="button"
        onClick={() => {
          setLocale(locale === 'te' ? 'en' : 'te');
        }}
      >
        switch
      </button>
    </>
  );
}

describe('I18nProvider', () => {
  it('provides messages, with English as the default without a provider', () => {
    render(
      <>
        <I18nProvider locale="en">
          <Greeting />
        </I18nProvider>
        <Greeting />
      </>,
    );
    expect(screen.getAllByText('Dashboard')).toHaveLength(2);
  });

  it('starts in the language kept on this device and sets <html lang>', () => {
    localStorage.setItem(LOCALE_KEY, 'hi');
    render(
      <I18nProvider>
        <Greeting />
      </I18nProvider>,
    );
    expect(screen.getByText(hi.dashboard.title)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi-IN');
    expect(document.head.querySelector('link[data-script-font="hi"]')).not.toBeNull();
  });

  it('switches language, remembers it and updates the page', async () => {
    const user = userEvent.setup();
    const doc = document.implementation.createHTMLDocument('other');
    const storage = window.localStorage;
    render(
      <I18nProvider locale="en" storage={storage} doc={doc}>
        <Greeting />
      </I18nProvider>,
    );
    expect(doc.documentElement.lang).toBe('en-IN');
    await user.click(screen.getByRole('button', { name: 'switch' }));
    expect(screen.getByText(te.dashboard.title)).toBeInTheDocument();
    expect(storage.getItem(LOCALE_KEY)).toBe('te');
    expect(doc.documentElement.lang).toBe('te-IN');
    expect(doc.head.querySelector('link[data-script-font="te"]')).not.toBeNull();
    await act(() => user.click(screen.getByRole('button', { name: 'switch' })));
    expect(doc.documentElement.lang).toBe('en-IN');
    expect(doc.head.querySelector('link[data-script-font]')).toBeNull();
  });
});
