import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { I18nProvider, LOCALES, createI18n, translate, useI18n } from './i18n.js';

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
    expect(LOCALES.en.intl).toBe('en-IN');
  });
});

function Greeting() {
  const { t } = useI18n();
  return <p>{t('dashboard.title')}</p>;
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
});
